import type {
  GrantView,
  ContextReadType,
  InboxAckResult,
  InboxDeliveryRef,
  InboxEnvelope,
  Task,
} from '@ziggs-ai/api-client';
import {
  decisionWords,
  grantCaveat,
  hintsFromTasks,
  inboxEngagement,
  planInboxAck,
  planPartialInboxAck,
} from '@ziggs-ai/api-client';
import {
  buildDecidedForMeItems,
  formatPendingDecisionsPayload,
  humanAttentionForResult,
  resolveWebAppOrigin,
} from './pendingDecisions.js';

/** Keep the plan bounded; the full deliveries array still carries everything. */
const MAX_READ_PLAN = 12;

/**
 * (Step 1): a pre-filled next call. The agent can run it verbatim
 * instead of assembling args from the ids scattered through the response.
 * `tool` + `args` mirror the MCP tool signature; `why` is a one-line reason.
 */
export interface ReadPlanCall {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

/**
 * buildReadPlan returns the (bounded, deduped) plan plus how many
 * candidate entries the cap dropped, so the caller can surface truncation
 * explicitly instead of the plan silently ending short.
 */
export interface ReadPlanResult {
  plan: ReadPlanCall[];
  truncated: number;
  /**
   * Rows the server said this reader cannot open. Listed so the agent can tell
   * its person what arrived and what it would take to read it, instead of
   * running a pre-filled read that refuses.
   */
  unreadable: Array<{ resourceId: string } & OutOfReachNote>;
}

interface AccessRequestCall<Permission extends 'read' | 'reply'> {
  tool: 'ziggs_access_request';
  args: {
    scopeKind: string;
    scopeId: string;
    permission: Permission;
    temporal: 'from-start';
  };
  requiredInput: string[];
  effect: 'request_only';
}

/**
 * The server's note on a row whose container this reader holds nothing to open.
 *
 * Read off the delivery rather than taken from the contract type: this client
 * is installed independently of the server it talks to, so it has to work
 * against a backend that predates the field as well as one that sends it.
 */
interface OutOfReachNote {
  scopeKind: string;
  scopeId: string;
  remedy: string;
  requestAccess?: AccessRequestCall<'read'>;
  /** Optional alternative when the person's work includes answering here. */
  requestReplyAccess?: AccessRequestCall<'reply'>;
}

/** What to do with rows marked `outOfReach`, said once per inbox read. */
export const OUT_OF_REACH_NOTE =
  'Rows with outOfReach: true are in rooms or resources you cannot read. ziggs_chat_list with readable: false shows each room you may list and the read request to file; for anything else, ziggs_open on it returns the request to make.';

function outOfReachOf(d: InboxDeliveryRef): OutOfReachNote | null {
  const note = (d as { outOfReach?: unknown }).outOfReach;
  if (!note || typeof note !== 'object') return null;
  const { scopeKind, scopeId, remedy } = note as Record<string, unknown>;
  return typeof scopeKind === 'string' &&
    typeof scopeId === 'string' &&
    typeof remedy === 'string'
    ? { scopeKind, scopeId, remedy }
    : null;
}

/**
 * Where to read an artifact delivery from — a total function, so there is no
 * "none of the above" that silently drops the row. Container first (the parties
 * who can see it there are the audience the write chose), then the artifact
 * itself for a free-standing one.
 */
function openCall(
  kind: 'artifact' | 'chat' | 'task' | 'agreement',
  id: string,
): ReadPlanCall {
  // One field names any record; the kind is read from it.
  void kind;
  const args = { ref: id };
  return {
    tool: 'ziggs_open',
    args,
    why: `open the ${kind} ${id}`,
  };
}

/**
 * replace the free-text `nextActions` hints with typed `readPlan`
 * call objects — tool name + pre-filled args — so the most common loop
 * (inbox → read what was addressed to you → ack) needs no guesswork.
 *
 * Safe by construction: every entry is synthesized purely from fields already
 * on the envelope (delivery kinds and ids, the per-chat fold, ackTo). No new
 * data is read and no new permission check runs — this is the same information
 * the caller already received, restated as runnable calls.
 *
 * Mapping honours how reads resolve server-side: messages read only via chat,
 * artifacts via the chat, agreement, or task they landed on.
 */
export function buildReadPlan(
  inbox: InboxEnvelope,
  grantsByScope?: Map<string, ScopeGrantTag>,
  self: DecisionSelfIds = { agentId: '' },
): ReadPlanResult {
  const proposals = inbox.proposalsAwaitingMe ?? [];
  const connectionRequests = inbox.connectionRequestsAwaitingMe ?? [];
  const deliveries = inbox.deliveries ?? [];

  // dedup by call signature so the same (type, via) can't appear
  // twice when several deliveries land in one chat. Collect candidates
  // uncapped; the cap is applied once, after the ack is reserved, so the ack
  // step always survives.
  //
  // Two lists, because only one of them can cost the ack.
  // `mine` is what was addressed to this caller (decisions, and rows stamped
  // for it); `ambient` is context nobody asked it to handle. A mailbox full of
  // ambient mail — a person's, read by their assistant — overflowed the one
  // list, the overflow dropped the ack step, and with no ack the window never
  // moved, so the next read overflowed identically. Measured on one account:
  // 200 rows, 23 reads dropped, ten days behind, and no way forward.
  const candidates: ReadPlanCall[] = [];
  const ambient: ReadPlanCall[] = [];
  const seen = new Set<string>();
  // Which assigned rows each candidate step settles, so a checkpoint ack can
  // name what is finished once that step is done. Keyed by the step's own
  // dedup key, because one read covers every row that landed in its chat.
  const settledBy = new Map<string, string[]>();
  const candidateKeys: string[] = [];
  const add = (
    key: string,
    call: ReadPlanCall,
    mine = true,
    settles?: string,
  ) => {
    // Recorded before the dedup return: the second row landing in a chat adds
    // no step, but the one step there already covers it.
    if (settles) {
      const rows = settledBy.get(key);
      if (rows) rows.push(settles);
      else settledBy.set(key, [settles]);
    }
    if (seen.has(key)) return;
    seen.add(key);
    if (mine) candidateKeys.push(key);
    (mine ? candidates : ambient).push(call);
  };

  // Inbox references do not evaluate approval grants. Read the agreement's
  // server-resolved approvalAction before suggesting any decision.
  for (const p of proposals) add(`respond:${p.agreementId}`, {
    tool: 'ziggs_agreement_get', args: { agreementId: p.agreementId },
    why: 'Read terms and approvalAction. Decide only under existing authority; otherwise ask the accountable party to review.',
  });
  for (const c of connectionRequests) add(`respond:${c.requestId}`, {
    tool: 'ziggs_agreement_get', args: { agreementId: c.requestId },
    why: 'Read terms and approvalAction before answering this connection request.',
  });

  const open = (
    kind: 'artifact' | 'chat' | 'task' | 'agreement',
    id: string,
    mine = true,
    settles?: string,
  ) => add(`open:${kind}:${id}`, openCall(kind, id), mine, settles);
  // grantsByScope used to pin X-Context-Grant-Id on reconstructed via reads.
  // open takes the ordinary id; the server rechecks without a grant pin.
  void grantsByScope;

  /**
   * Is this row the caller's own? With no self id configured every row counts
   * as its own, which is the old behaviour: the plan then holds one list and
   * the ack rides on all of it fitting, exactly as before.
   */
  const isMine = (d: InboxDeliveryRef) =>
    self.agentIds?.includes(d.assigneeId ?? '') || (!self.agentIds && self.agentId === '') || d.assigneeId === self.agentId;

  // Reads — one call per place mail actually landed. The delivery names the
  // chat, agreement or task directly, so nothing has to be inferred from a scope.
  //
  // Total over BOTH axes, and that is the whole point of this shape:
  //
  //   - over `kind`, so a delivery kind nobody plans a read for is a compile
  //     error here rather than a plan that quietly ends at the ack;
  //   - over the anchor, so is an artifact carrying none of chat/agreement/task
  // — it is read as `artifact:<id>`, the entry added for that case.
  //
  // The first is history: while this looked at chatId/agreementId only, a
  // task-bound deliverable produced an envelope whose plan was the ack and
  // nothing else, and an agent following the plan acked work it never read. The
  // second is that hole closed ahead of an emitter — nothing writes an
  // anchor-less delivery today, and when something does it is planned.
  //
  // A row the server marked out of reach is not planned at all. The
  // read behind it refuses, and handing the agent a call that always fails is
  // what left it with no honest move: it could not open the row, could not
  // report it, and could not ack past it.
  const unreadable: Array<{ resourceId: string } & OutOfReachNote> = [];
  // Assigned first, ambient second, so a chat that carries both is planned as
  // the caller's own work rather than as droppable context.
  const inPlanOrder = [
    ...deliveries.filter((d) => isMine(d)),
    ...deliveries.filter((d) => !isMine(d)),
  ];
  for (const d of inPlanOrder) {
    const note = outOfReachOf(d);
    if (note) {
      unreadable.push({ resourceId: d.resourceId, ...note,
        ...(['chat', 'agreement', 'task', 'artifact'].includes(note.scopeKind) ? {
          requestAccess: { tool: 'ziggs_access_request', args: { scopeKind: note.scopeKind, scopeId: note.scopeId, permission: 'read', temporal: 'from-start' }, requiredInput: note.scopeKind === 'artifact' ? ['reason', 'recipientId', 'chatId'] : ['reason', 'recipientId'], effect: 'request_only' },
        } : {}),
        ...(note.scopeKind === 'chat' ? {
          requestReplyAccess: {
            tool: 'ziggs_access_request',
            args: { scopeKind: 'chat', scopeId: note.scopeId, permission: 'reply', temporal: 'from-start' },
            requiredInput: ['reason', 'recipientId'],
            effect: 'request_only',
          },
        } : {}),
      });
      continue;
    }
    const mine = isMine(d);
    switch (d.kind) {
      case 'message':
        // A message always lands in a chat; open the ordinary chat id.
        if (d.chatId)
          open('chat', d.chatId, mine, mine ? d.resourceId : undefined);
        break;
      case 'artifact':
        // The delivery's resourceId is the artifact. Do not reconstruct via.
        open('artifact', d.resourceId, mine, mine ? d.resourceId : undefined);
        break;
      case 'agreement': {
        // An agreement row whose reason names a decision on a request this
        // side made (an access request approved or refused, a connection
        // request answered, an approval slot filled) is planned as a read of
        // that agreement, and its `why` is what was decided rather than "open
        // the agreement": read generically, the row said nothing, and an agent
        // learned it had been refused only if it happened to list its
        // agreements. Any other agreement row plans nothing, as before: it
        // arrives as standing state elsewhere on the envelope.
        const agreementId = d.agreementId ?? d.resourceId;
        const words = decisionWords({
          reason: d.reason,
          actorId: d.actorId,
          ts: d.ts,
          agreementId,
          surface: 'mcp',
        });
        if (words) {
          add(
            `open:agreement:${agreementId}`,
            { tool: 'ziggs_open', args: { ref: agreementId }, why: words.sentence },
            mine,
            mine ? d.resourceId : undefined,
          );
        }
        break;
      }
      case 'task-state':
      case 'request':
        // Deliberately no read call. Tasks/proposals arrive as standing state
        // elsewhere on the envelope; requests ride `openRequestsAwaitingMe`
        // and are host-triaged with a plain string compare — never an LLM read
        // plan entry (that would recreate the per-request token drain).
        break;
      default:
        // Compile-time exhaustiveness: a kind added to the vocabulary no longer
        // satisfies `never`, so it cannot be introduced without a decision being
        // made here. At runtime this skips rather than throws — this client is
        // installed independently of the server it talks to, and one
        // unrecognised delivery must not cost the caller the whole envelope.
        d.kind satisfies never;
        break;
    }
  }

  // reserve a slot for the ack before capping, so the pre-filled ack
  // never gets squeezed out exactly when there's the most news. Report how many
  // read/decision candidates the cap dropped as an explicit count.
  //
  // The ack rides on MY steps all fitting, not on the whole plan fitting. The
  // server's bury-guard is the thing this protects, and it asks one question:
  // was every row assigned to me in this window handled? Ambient reads dropped
  // by the cap are not part of that answer — they were never mine to handle,
  // and the owner's own seen mark tracks them. Letting them veto the ack is
  // what pinned a busy mailbox in place for good.
  //
  // A capped delivery list is the oldest head; acking it with the listed ids
  // is safe, because the newer tail is past ackTo.
  const ack = planInboxAck(inbox, {
    ownAgentId: self.agentId || undefined,
    ownAgentIds: self.agentIds,
  });

  // One checkpoint ack, after the FIRST assigned step.
  //
  // A single ack at the end freezes the watermark for the caller's whole turn,
  // and the server hands an unanswered row to the person's stand-in after 90
  // seconds. A delegate's turn is a model turn, so that is the long one.
  //
  // One checkpoint, not one per step. The plan is capped at MAX_READ_PLAN, and
  // acking after every read would roughly halve the reads that fit — the exact
  // pressure the two-list split above exists to relieve, and overflow here is
  // what put an account ten days behind with no way forward.
  //
  // The first step is the valuable one anyway. The takeover only reaches rows
  // already past the window, which are the oldest, and assigned reads are
  // planned oldest-first (deliveries arrive oldest-first and `inPlanOrder`
  // keeps assigned rows ahead of ambient). So this releases exactly the rows
  // that are in danger, at step one instead of step eleven.
  const firstKey = candidateKeys[0];
  const settledFirst = firstKey ? (settledBy.get(firstKey) ?? []) : [];
  const checkpoint =
    settledFirst.length > 0
      ? planPartialInboxAck(inbox, new Set(settledFirst), {
          ownAgentId: self.agentId || undefined,
    ownAgentIds: self.agentIds,
        })
      : null;
  // Never the same mark as the final ack — that is a wasted call and a second
  // chance for the model to ack work it has not done.
  const useCheckpoint = !!checkpoint && checkpoint.ackTo !== inbox.ackTo;

  const reserved = (ack.allowed ? 1 : 0) + (useCheckpoint ? 1 : 0);
  const leaveRoomForAck =
    ack.allowed && candidates.length <= MAX_READ_PLAN - reserved;
  const budget = leaveRoomForAck
    ? MAX_READ_PLAN - reserved
    : MAX_READ_PLAN;
  const ordered = [...candidates, ...ambient];
  const truncated = Math.max(0, ordered.length - budget);
  const plan = ordered.slice(0, budget);
  if (leaveRoomForAck && useCheckpoint && plan.length > 1) {
    plan.splice(1, 0, {
      tool: 'ziggs_inbox_ack',
      args: {
        ack: checkpoint!.ackTo,
        handledResourceIds: checkpoint!.handledResourceIds,
      },
      why:
        'checkpoint — run this as soon as the ONE step above it is done, not later: ' +
        'it hands back the oldest mail so nobody answers it on top of you while you ' +
        'work through the rest. Pass ack back VERBATIM (it is opaque). If the step ' +
        'above is not done, skip this one and let the final ack cover it',
    });
  }
  if (leaveRoomForAck) {
    const handledResourceIds = ack.handledResourceIds;
    // Says exactly what the server checks. It refuses an ack that passes over
    // an ASSIGNED row not listed; rows assigned to nobody or to someone else
    // never gate. "Every step above" used to include the ambient reads, so an
    // agent that had not opened someone else's mail held its own mark back.
    plan.push({
      tool: 'ziggs_inbox_ack',
      args: {
        ack: inbox.ackTo,
        handledResourceIds,
      },
      why:
        (handledResourceIds.length
          ? `acking asserts you handled these ASSIGNED rows: [${handledResourceIds.join(', ')}]. ` +
            'Reads of rows assigned to others never count; skip them freely. '
          : 'no row in this window is assigned to you; acking only moves your mark past context that other windows handle. ') +
        'Pass ackTo back VERBATIM (it is opaque). ' +
        'Handled some of them, in order? Ack with the ackTo of the last assigned row you handled and the ids up to it; the rest stays for the next pass',
    });
  }

  return { plan, truncated, unreadable };
}

/**
 * forward-continuation for a read_context page. Built only from fields
 * already on the page (via, hasMore/nextCursor, latestSequence) plus the grant
 * id the caller presented — echoed back, never discovered. Nothing new is read.
 *
 * - When the page has more rows in this window: a cursor call for the next page.
 * - When the page reports a high-water sequence: a forward-delta call that
 *   returns only items created after this page (after = latestSequence).
 */
export function buildReadContextReadPlan(
  page: {
    hasMore?: boolean;
    nextCursor?: string | null;
    latestSequence?: string | null;
  },
  type: ContextReadType,
  via: string,
  presentedGrantId?: string,
): ReadPlanCall[] {
  const plan: ReadPlanCall[] = [];
  // Only echo a grant the caller already presented — never one we discovered.
  const grant = presentedGrantId ? { contextGrantId: presentedGrantId } : {};

  if (page.hasMore && page.nextCursor) {
    plan.push({
      tool: 'ziggs_context_read',
      args: { type, via, cursor: page.nextCursor, ...grant },
      why: 'more rows in this window — next page',
    });
  }

  if (page.latestSequence) {
    plan.push({
      tool: 'ziggs_context_read',
      args: {
        type,
        via,
        direction: 'forward',
        after: page.latestSequence,
        ...grant,
      },
      why: 'forward-delta — only items created after this page',
    });
  }

  return plan;
}

/**
 * (Step 2): the covering grant attached to a scope so the agent can
 * pin the right X-Context-Grant-Id without a separate discover_context call.
 * Grant metadata only — never a resource-derived field.
 */
export interface ScopeGrantTag {
  grantId: string;
  temporal: 'from-now' | 'from-start';
  watermarkAt: string;
  expiresAt: string | null;
  parentGrantId: string | null;
}

function toScopeGrantTag(g: GrantView): ScopeGrantTag {
  return {
    grantId: g.grantId,
    // Context grants carry temporal/watermark as caveats.
    temporal:
      (grantCaveat(g, 'temporal') as 'from-now' | 'from-start') ?? 'from-now',
    watermarkAt: (grantCaveat(g, 'watermark_at') as string) ?? '',
    expiresAt: g.expiresAt,
    parentGrantId: g.parentGrantId,
  };
}

/**
 * When several live grants cover the same scope, pick the one the agent should
 * pin: the broadest history first (from-start over from-now, then the earliest
 * watermark), so a read against it returns the most the caller is entitled to.
 */
function isBroaderGrant(a: ScopeGrantTag, b: ScopeGrantTag): boolean {
  if (a.temporal !== b.temporal) return a.temporal === 'from-start';
  return a.watermarkAt < b.watermarkAt;
}

/**
 * index the caller's own live reach descriptors by scope. The reach
 * list is already the caller's non-expired grants (holderId == principalId),
 * so this is grant metadata the caller already holds — no protected content.
 */
export function indexReachByScope(
  reach: GrantView[],
): Map<string, ScopeGrantTag> {
  const byScope = new Map<string, ScopeGrantTag>();
  for (const g of reach) {
    if (!g?.scope) continue;
    const key = `${g.scope.kind}:${g.scope.id}`;
    const tag = toScopeGrantTag(g);
    const existing = byScope.get(key);
    if (!existing || isBroaderGrant(tag, existing)) byScope.set(key, tag);
  }
  return byScope;
}

/**
 * Put humanAttention first so MCP hosts surface it before counts,
 * and append readPlan last so each inbox call self-narrates the follow-up
 * calls without disturbing the leading humanAttention key.
 *
 * When `reach` (the caller's own live grants) is passed, the read plan pins
 * each read's covering grant so the agent can present
 * X-Context-Grant-Id without a separate discover round-trip.
 */
export function formatInboxToolResult(
  inbox: InboxEnvelope,
  ack?: InboxAckResult | null,
  webOrigin?: string,
  activeTasks?: Task[],
  reach?: GrantView[],
  activeTasksError?: string,
  /**
   * The caller's own ids. Optional here alone: this result carries
   * the session-start COUNTS, never the decision items themselves, and a count
   * does not depend on which party may answer. Production callers pass it
   * regardless — the cold-read session block on ziggs_inbox does emit
   * `decisions`, and they must be marked correctly.
   */
  self: DecisionSelfIds = { agentId: '' },
): Record<string, unknown> {
  const byScope = reach?.length ? indexReachByScope(reach) : undefined;
  const {
    plan: readPlan,
    truncated: readPlanTruncated,
    unreadable,
  } = buildReadPlan(inbox, byScope, self);
  const origin = resolveWebAppOrigin(webOrigin);
  // This is the news half of the inbox result: counts, not cards. The cold-read
  // session block (decisions, activeWork, sessionChatCard) is layered on top of
  // it by the tool, so a long-poll tick never re-ships the card.
  // omit `activeTasks` so counts come from inbox.tasksAwaitingMe —
  // callers that still pass an array (or []) keep the listTasks-derived path.
  const pending = formatPendingDecisionsPayload(inbox, origin, {
    ...(activeTasks !== undefined ? { activeTasks, activeTasksError } : {}),
    withSessionCard: false,
  });
  const pendingTail =
    pending.hasActionable === true
      ? {
          pendingCount: pending.pendingCount,
          activeWorkCount: pending.activeWorkCount,
          actionCount: pending.actionCount,
          ...(pending.sessionCardHint
            ? { sessionCardHint: pending.sessionCardHint }
            : {}),
        }
      : {};

  const tail = {
    ...pendingTail,
    // always surface a task-fetch failure, even when there is nothing
    // else actionable, so hasActiveWork:false is not read as "no tasks".
    ...(pending.activeTasksFetchError
      ? {
          activeTasksFetchError: pending.activeTasksFetchError,
          workCardOmitted: true,
        }
      : {}),
    ...(readPlan.length ? { readPlan } : {}),
    ...(readPlanTruncated ? { readPlanTruncated } : {}),
    // The row carries the flag and the plan skips it. Which room it is and how
    // to ask for it is the chat list's answer, so the inbox says where to look
    // once instead of repeating every row.
    ...(unreadable.length ? { outOfReachNote: OUT_OF_REACH_NOTE } : {}),
  };
  const { humanAttention, ...rest } = inbox;
  const engagement = inboxEngagement({
    env: {
      creds: { operatorKey: '', agentId: self.agentId },
      surface: 'mcp',
    },
    agentId: self.agentId,
    inbox,
    tasks: hintsFromTasks(activeTasks),
    continuation: { kind: 'manual', canScheduleWake: false },
  });
  const payload: Record<string, unknown> = ack
    ? { ackedUpTo: ack.ackedUpTo, ...rest, ...tail }
    : { ...rest, ...tail };
  if (engagement) payload.engagement = engagement;
  // Decisions on requests this side made, at the top: they are the answer the
  // agent was waiting for, and a refusal among them is work still owed. Only
  // humanAttention outranks them.
  const decidedForMe = buildDecidedForMeItems(inbox);
  const led = decidedForMe.length ? { decidedForMe, ...payload } : payload;
  // The flag, the reason and the counts; the server's prompt line is dropped
  // (see humanAttentionForResult).
  const attention = humanAttentionForResult(humanAttention);
  return attention ? { humanAttention: attention, ...led } : led;
}

/** The caller's own ids, for the rows this result marks as the caller's. */
export interface DecisionSelfIds {
  agentId: string;
  agentIds?: string[];
  ownerUserId?: string | null;
}
