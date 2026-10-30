import { agreementAppUrl, agreementsListAppUrl, connectionsSettingsAppUrl } from '@ziggs-ai/api-client';
export { resolveWebAppOrigin, agreementAppUrl, agreementsListAppUrl, connectionsSettingsAppUrl, walletAppUrl } from '@ziggs-ai/api-client';
import {
  decisionWords,
  partySideIds,
  speakableActor,
  type DecisionOutcome,
  type InboxConnectionRequestRef,
  type InboxDeliveryRef,
  type InboxEnvelope,
  type InboxHumanAttention,
  type InboxPlanAckRef,
  type InboxProposalRef,
  type InboxTaskRef,
  type PlanStep,
  type Task,
} from '@ziggs-ai/api-client';
import type { ReadPlanCall } from './inboxToolResult.js';

export type PendingDecisionKind = 'proposal' | 'link_request' | 'plan_ack';

/**
 * A reference to a decision somebody is waiting on. Who may answer it is not
 * known here: the inbox lists slots, and a slot is not authority. The
 * agreement read's `approvalAction` says whether this caller may decide.
 */
export interface PendingDecisionItem {
  kind: PendingDecisionKind;
  /**
   * Agreement id for proposals and plans; requestId for link requests.
   */
  agreementId: string;
  /** The task whose plan waits, on a `plan_ack`. */
  taskId?: string;
  title: string;
  subtitle: string | null;
  proposedAt: string | null;
  proposedAtLabel: string | null;
  appUrl: string;
}

export interface ActiveWorkItem {
  taskId: string;
  agreementId: string | null;
  title: string;
  state: string;
  planDone: number;
  planTotal: number;
  appUrl: string | null;
  sayWork: string;
}

/**
 * A decision somebody made on a request this agent (or its person) made,
 * read off an agreement delivery row whose `reason` names it.
 *
 * Everything here is already on the row: the agreement, who answered, when,
 * and the reason. The sentence is the shared one both rails use. Nothing a
 * counterparty wrote is carried.
 */
export interface DecidedForMeItem {
  agreementId: string;
  outcome: DecisionOutcome;
  /** Who answered (the row's actorId); null when the emit did not stamp one. */
  by: string | null;
  /** When it was answered (the row's ts). */
  at: string;
  sentence: string;
  /** Present only when the row names the artifact the decision was about. */
  artifactId?: string;
  /** Runnable next calls: the agreement, and the artifact when its id is known. */
  next: ReadPlanCall[];
}

/**
 * The artifact a decision row is about, when the row names it. Today's row
 * does not (the artifact lives on the agreement's grant request), so this
 * reads defensively and the sentence sends the reader to the agreement.
 */
function artifactIdOf(d: InboxDeliveryRef): string | null {
  const row = d as {
    artifactId?: unknown;
    scope?: { kind?: unknown; id?: unknown } | null;
  };
  if (typeof row.artifactId === 'string' && row.artifactId) return row.artifactId;
  if (row.scope && row.scope.kind === 'artifact' && typeof row.scope.id === 'string' && row.scope.id) {
    return row.scope.id;
  }
  return null;
}

/**
 * One entry per agreement delivery row whose reason names a decision.
 * Refusals first, because those are the ones with work still owed; the rest
 * keep the envelope's order (oldest first).
 */
export function buildDecidedForMeItems(inbox: InboxEnvelope): DecidedForMeItem[] {
  const items: DecidedForMeItem[] = [];
  for (const d of inbox.deliveries ?? []) {
    // The server removed this assignment because the reader cannot open it.
    // Its remedy already rides on the result's outOfReach list; do not turn
    // it back into work through the parallel decision-summary path.
    if (d.kind !== 'agreement' || d.outOfReach) continue;
    const agreementId = d.agreementId ?? d.resourceId;
    const artifactId = artifactIdOf(d);
    const words = decisionWords({
      reason: d.reason,
      actorId: d.actorId,
      ts: d.ts,
      agreementId,
      scope: artifactId ? { kind: 'artifact', id: artifactId } : null,
      surface: 'mcp',
    });
    if (!words) continue;
    const next: ReadPlanCall[] = [
      { tool: 'ziggs_open', args: { ref: agreementId }, why: words.sentence },
    ];
    if (artifactId && d.reason === 'context_request_fulfilled') {
      next.push({
        tool: 'ziggs_open',
        args: { ref: artifactId },
        why: `open the artifact ${artifactId} the approved grant covers`,
      });
    }
    items.push({
      agreementId,
      outcome: words.outcome,
      by: speakableActor(d.actorId),
      at: d.ts,
      sentence: words.sentence,
      ...(artifactId ? { artifactId } : {}),
      next,
    });
  }
  const refused = items.filter((i) => i.outcome === 'rejected');
  const rest = items.filter((i) => i.outcome !== 'rejected');
  return [...refused, ...rest];
}

/**
 * The one line that counts them for the cold read. Held formations are not
 * decisions on a request, so they are counted apart.
 */
export function decidedForMeSummary(items: DecidedForMeItem[]): string {
  const decided = items.filter((i) => i.outcome !== 'held');
  const held = items.length - decided.length;
  const refused = decided.filter((i) => i.outcome === 'rejected').length;
  const parts: string[] = [];
  if (decided.length) {
    parts.push(
      `${decided.length} ${decided.length === 1 ? 'decision' : 'decisions'} on requests you made, ${refused} of them ${refused === 1 ? 'a refusal' : 'refusals'}`,
    );
  }
  if (held) {
    parts.push(`${held} ${held === 1 ? 'agreement' : 'agreements'} held awaiting a consent`);
  }
  return parts.length ? `${parts.join('; ')}: see decidedForMe.` : '';
}

const TITLE_MAX = 72;
const ACTIVE_TASK_LIMIT = 20;

/**
 * Where the card is, said as a fact, on a response that carries the counts
 * but not the card. Only the long-poll shape does that now: a cold ziggs_inbox
 * is the session start and ships the card itself. What to do with the card is
 * stated once, on connect; this line does not word the reply.
 */
export const SESSION_CARD_POINTER =
  'sessionChatCard is not in this response; it ships on a cold ziggs_inbox without waitSeconds.';

/**
 * humanAttention as the MCP result carries it: the flag, the reason and the
 * counts. The server also authors a `promptUser` line there, and that line
 * interpolates the proposal title, the requester's name and their quoted
 * message inside an imperative: text a counterparty wrote, riding on a
 * directive about what to tell the human. It is dropped here. What to do when
 * the flag is present is said once, on connect.
 */
export function humanAttentionForResult(
  attention: InboxHumanAttention | null | undefined,
): Omit<InboxHumanAttention, 'promptUser'> | null {
  if (!attention) return null;
  const { promptUser: _dropped, ...rest } = attention;
  void _dropped;
  return rest;
}

function truncateText(text: string, max = TITLE_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

function displayTitle(raw: string): string {
  return truncateText(raw.replace(/^\[DEMO\]\s*/i, '').trim() || '(untitled)');
}

function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

function planProgress(plan?: { steps?: PlanStep[] }): {
  done: number;
  total: number;
} {
  const steps = plan?.steps;
  if (!steps?.length) return { done: 0, total: 0 };
  const total = steps.length;
  const done = steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped',
  ).length;
  return { done, total };
}

function linkRequesterHeadline(c: InboxConnectionRequestRef): string {
  // consent cards lead with a readable name + org; ref is
  // a non-addressable psn_* face, never an agent account id.
  const name = c.requesterDisplayName?.trim();
  const org = c.requesterOrgName?.trim();
  if (name && org) return `${name} (${org})`;
  if (name) return name;
  return c.requesterRef;
}

/** one builder for proposal / link_request decision items. */
function decisionToItem(
  kind: PendingDecisionKind,
  id: string,
  fields: {
    title: string;
    subtitle: string | null;
    proposedAt: string | null;
  },
  origin: string,
): PendingDecisionItem {
  return {
    kind,
    agreementId: id,
    title: fields.title,
    subtitle: fields.subtitle,
    proposedAt: fields.proposedAt,
    proposedAtLabel: formatWhen(fields.proposedAt),
    appUrl: agreementAppUrl(origin, id),
  };
}

function proposalToItem(
  p: InboxProposalRef,
  origin: string,
): PendingDecisionItem {
  return decisionToItem(
    'proposal',
    p.agreementId,
    {
      title: displayTitle(p.title?.trim() || '(untitled proposal)'),
      subtitle: null,
      proposedAt: p.proposedAt,
    },
    origin,
  );
}

function linkToItem(
  c: InboxConnectionRequestRef,
  origin: string,
): PendingDecisionItem {
  const note = c.message?.trim() || null;
  const headline = linkRequesterHeadline(c);
  return decisionToItem(
    'link_request',
    c.requestId,
    {
      title: truncateText(`Agent link · ${headline}`),
      subtitle: note
        ? truncateText(note, 96)
        : c.requesterRef && headline !== c.requesterRef
          ? truncateText(`ref: ${c.requesterRef}`, 96)
          : null,
      proposedAt: c.requestedAt,
    },
    origin,
  );
}

/**
 * A plan waiting on the person. The plan is acknowledged signed in on the
 * agreement page, where the task and its plan are shown, so Review goes there.
 */
function planAckToItem(
  a: InboxPlanAckRef,
  origin: string,
): PendingDecisionItem {
  return {
    ...decisionToItem(
      'plan_ack',
      a.agreementId,
      {
        title: displayTitle(a.title?.trim() || '(untitled task)'),
        subtitle:
          a.scope === 'mid_work'
            ? 'The plan changed during the work.'
            : 'Work starts once you acknowledge the plan.',
        proposedAt: a.updatedAt,
      },
      origin,
    ),
    taskId: a.taskId,
  };
}

export function buildPendingDecisionItems(
  inbox: InboxEnvelope,
  webOrigin: string,
): PendingDecisionItem[] {
  const items: PendingDecisionItem[] = [];
  for (const a of inbox.planAcksAwaitingMe ?? []) {
    items.push(planAckToItem(a, webOrigin));
  }
  for (const p of inbox.proposalsAwaitingMe ?? []) {
    items.push(proposalToItem(p, webOrigin));
  }
  for (const c of inbox.connectionRequestsAwaitingMe ?? []) {
    items.push(linkToItem(c, webOrigin));
  }
  return items;
}

/**
 * keep only tasks this delegate (or its principal) is expected to
 * execute. The backend's GET /tasks returns every task reachable in the org,
 * so the session card must not present all of them as "your work".
 *
 * A task is "for me" when:
 * - it is explicitly assigned (`assigneeId`) to one of my ids, or
 * - it has no explicit assignee and one of my ids sits on the executing side
 *   of the task/agreement (executor, agent, or either column of the provider /
 *   proposedTo party sides).
 * Tasks with no assignee and no readable agreement parties are excluded —
 * "can't tell" must not render as "yours".
 */
export function filterTasksForDelegate(
  tasks: Task[],
  selfIds: ReadonlySet<string>,
): Task[] {
  const mine = (id: string | null | undefined): boolean =>
    typeof id === 'string' && id.length > 0 && selfIds.has(id);
  return tasks.filter((t) => {
    if (t.assigneeId) return mine(t.assigneeId);
    if (mine(t.executorId) || mine(t.agentId)) return true;
    const p = t.agreement?.parties;
    if (!p) return false;
    return [...partySideIds(p.provider), ...partySideIds(p.proposedTo)].some(mine);
  });
}

export function buildActiveWorkItems(
  tasks: Task[],
  webOrigin: string,
): ActiveWorkItem[] {
  return tasks
    .filter((t) => t.state === 'active')
    .slice(0, ACTIVE_TASK_LIMIT)
    .map((t) => {
      const { done, total } = planProgress(t.plan);
      const agreementId = t.agreementId?.trim() || null;
      return {
        taskId: t.taskId,
        agreementId,
        title: displayTitle(t.description?.trim() || '(untitled task)'),
        state: t.state,
        planDone: done,
        planTotal: total,
        appUrl: agreementId ? agreementAppUrl(webOrigin, agreementId) : null,
        sayWork: `work on ${t.taskId}`,
      };
    });
}

/**
 * inbox already carries `tasksAwaitingMe` — the open-task work
 * channel. Use that for counts/cards when the caller did not round-trip
 * `listTasks` (ziggs_inbox). Plan progress is absent on the ref; pending_decisions
 * still fetches full Task rows when it needs the richer card.
 */
export function buildActiveWorkItemsFromInbox(
  refs: InboxTaskRef[],
  webOrigin: string,
): ActiveWorkItem[] {
  return refs
    .filter((t) => !t.state || t.state === 'active')
    .slice(0, ACTIVE_TASK_LIMIT)
    .map((t) => {
      const agreementId = t.agreementId?.trim() || null;
      return {
        taskId: t.taskId,
        agreementId,
        title: displayTitle(t.title?.trim() || '(untitled task)'),
        state: t.state || 'active',
        planDone: 0,
        planTotal: 0,
        appUrl: agreementId ? agreementAppUrl(webOrigin, agreementId) : null,
        sayWork: `work on ${t.taskId}`,
      };
    });
}

function kindLabel(kind: PendingDecisionKind): string {
  if (kind === 'proposal') return 'Agreement proposal';
  if (kind === 'plan_ack') return 'Plan to acknowledge';
  return 'Agent link request';
}

function kindHint(kind: PendingDecisionKind): string {
  if (kind === 'proposal') {
    return 'Someone proposed work or terms — your approval opens or rejects it.';
  }
  if (kind === 'plan_ack') {
    return 'Work you are paying for has a plan waiting on you.';
  }
  return 'Another agent wants to link — your approval enables cross-org reach.';
}

function buildDecisionSection(
  items: PendingDecisionItem[],
  opts: {
    truncatedProposals?: number;
    truncatedConnectionRequests?: number;
    truncatedPlanAcks?: number;
    startIndex?: number;
  },
): string[] {
  const truncatedProposals = opts.truncatedProposals ?? 0;
  const truncatedConnectionRequests = opts.truncatedConnectionRequests ?? 0;
  const truncatedPlanAcks = opts.truncatedPlanAcks ?? 0;
  const truncated =
    truncatedProposals + truncatedConnectionRequests + truncatedPlanAcks;
  if (!items.length && truncated === 0) return [];

  const lines: string[] = [];
  let n = opts.startIndex ?? 1;

  for (const item of items) {
    lines.push('---');
    lines.push('');
    lines.push(`#### ${n}. ${kindLabel(item.kind)}`);
    n += 1;
    lines.push('');
    lines.push(`**${item.title}**`);
    lines.push('');
    lines.push(`\`${item.taskId ?? item.agreementId}\`${item.proposedAtLabel ? ` · ${item.proposedAtLabel}` : ''}`);
    lines.push('');
    lines.push(`_${kindHint(item.kind)}_`);
    if (item.subtitle) {
      lines.push('');
      lines.push(`> ${item.subtitle}`);
    }
    lines.push('');
    lines.push(`[Review in Ziggs →](${item.appUrl})`);
    lines.push('');
    if (item.kind === 'plan_ack') {
      lines.push('The person acknowledges the plan in Ziggs, signed in as themselves.');
    } else {
      // No pre-filled respond call: a slot is not authority, and a call that
      // 403s every time is worse than a line that says where the answer is.
      lines.push(
        'Review the terms here. The agent reads approvalAction on the agreement to check whether an existing grant lets it decide; otherwise the accountable party decides in Ziggs.',
      );
    }
    lines.push('');
  }

  if (truncated > 0) {
    lines.push('---');
    lines.push('');
    lines.push(
      `_+${truncated} more pending (${truncatedProposals} proposal(s), ${truncatedConnectionRequests} link(s), ${truncatedPlanAcks} plan(s)) — not listed here._`,
    );
    lines.push('');
  }

  return lines;
}

function buildWorkSection(work: ActiveWorkItem[], startIndex = 1): string[] {
  if (!work.length) return [];

  const lines: string[] = [];
  let n = startIndex;

  for (const item of work) {
    lines.push('---');
    lines.push('');
    lines.push(`#### ${n}. 🛠️ Active task — your work`);
    n += 1;
    lines.push('');
    lines.push(`**${item.title}**`);
    lines.push('');
    const meta: string[] = [`\`${item.taskId}\``];
    if (item.agreementId) meta.push(`agreement \`${item.agreementId}\``);
    if (item.planTotal > 0) meta.push(`Plan **${item.planDone}/${item.planTotal}**`);
    lines.push(meta.join(' · '));
    lines.push('');
    lines.push(
      '_Assigned work under an active agreement — implement, test, and report back via artifact or chat. Approve the agreement first if it is still pending._',
    );
    if (item.appUrl) {
      lines.push('');
      lines.push(`[Open agreement in Ziggs →](${item.appUrl})`);
    }
    lines.push('');
    lines.push('| You say in chat | What the agent runs |');
    lines.push('|:----------------|:--------------------|');
    lines.push(`| \`${item.sayWork}\` | read task/agreement context → implement → \`ziggs_artifact_record\` |`);
    lines.push('');
  }

  return lines;
}

/**
 * Combined card: approve/reject + active tasks (what humans actually need at
 * session start). this is the ONE card shipped per session start —
 * the former standalone decision/work cards were removed because
 * `sessionChatCard` already concatenates both sections.
 */
export function buildSessionChatCard(
  decisions: PendingDecisionItem[],
  work: ActiveWorkItem[],
  opts: {
    truncatedProposals?: number;
    truncatedConnectionRequests?: number;
    truncatedPlanAcks?: number;
    agreementsListAppUrl?: string;
  },
): string {
  const truncatedProposals = opts.truncatedProposals ?? 0;
  const truncatedConnectionRequests = opts.truncatedConnectionRequests ?? 0;
  const truncatedPlanAcks = opts.truncatedPlanAcks ?? 0;
  const truncated =
    truncatedProposals + truncatedConnectionRequests + truncatedPlanAcks;
  const planAckCount = decisions.filter((d) => d.kind === 'plan_ack').length;
  const decisionListed = decisions.length + truncated;
  const workCount = work.length;
  const total = decisionListed + workCount;
  if (total === 0) return '';

  const lines: string[] = [
    `### 🔔 Ziggs — **${total}** ${total === 1 ? 'thing needs' : 'things need'} you`,
    '',
    '| | |',
    '|:--|--:|',
    ...(decisionListed > 0
      ? [
          `| Approve / reject / acknowledge | **${decisionListed}** |`,
          `| — proposals | ${decisions.filter((d) => d.kind === 'proposal').length}${truncatedProposals ? ` (+${truncatedProposals} hidden)` : ''} |`,
          `| — link requests | ${decisions.filter((d) => d.kind === 'link_request').length}${truncatedConnectionRequests ? ` (+${truncatedConnectionRequests} hidden)` : ''} |`,
          ...(planAckCount + truncatedPlanAcks > 0
            ? [
                `| — plans to acknowledge | ${planAckCount}${truncatedPlanAcks ? ` (+${truncatedPlanAcks} hidden)` : ''} |`,
              ]
            : []),
        ]
      : []),
    ...(workCount > 0 ? [`| Active tasks (your work) | **${workCount}** |`] : []),
    '',
    '> **Heads-up:** MCP is pull-only — check at session start. **Decisions:** you say approve/reject. **Tasks:** say `work on <taskId>` — the agent implements and reports on Ziggs.',
    '',
  ];

  let sectionIndex = 1;
  if (decisions.length || truncated > 0) {
    lines.push(...buildDecisionSection(decisions, { ...opts, startIndex: sectionIndex }));
    sectionIndex += decisions.length;
  }
  if (work.length) {
    lines.push(...buildWorkSection(work, sectionIndex));
  }

  const listUrl = opts.agreementsListAppUrl;
  if (listUrl) {
    lines.push(`[View all in Ziggs →](${listUrl})`);
  }

  return lines.join('\n').trim();
}

/** Structured session payload for MCP tools ( + active work). */
export function formatPendingDecisionsPayload(
  inbox: InboxEnvelope,
  webOrigin: string,
  opts?: {
    /**
     * Full Task rows from `listTasks`. Omit (undefined) to derive active work
     * from `inbox.tasksAwaitingMe` instead (ziggs_inbox). Pass `[]`
     * when the list fetch ran and returned nothing.
     */
    activeTasks?: Task[];
    activeTasksError?: string;
    /**
     * whether to embed the full `sessionChatCard`. A cold ziggs_inbox — the one
     * session-start read — passes true; the long-poll shape passes false and
     * gets a `sessionCardHint` pointer instead, so a polling loop does not
     * re-ship the card on every tick.
     */
    withSessionCard?: boolean;
  },
): Record<string, unknown> {
  const withSessionCard = opts?.withSessionCard !== false;
  const decisions = buildPendingDecisionItems(inbox, webOrigin);
  // A task whose plan waits on the person is theirs to acknowledge before it
  // is anyone's work, so it is listed once, as the decision.
  const waitingPlans = new Set(
    (inbox.planAcksAwaitingMe ?? []).map((a) => a.taskId),
  );
  const activeWork = (
    opts?.activeTasks !== undefined
      ? buildActiveWorkItems(opts.activeTasks, webOrigin)
      : buildActiveWorkItemsFromInbox(inbox.tasksAwaitingMe ?? [], webOrigin)
  ).filter((w) => !waitingPlans.has(w.taskId));
  const truncatedProposals = inbox.truncatedProposals ?? 0;
  const truncatedConnectionRequests = inbox.truncatedConnectionRequests ?? 0;
  const truncatedPlanAcks = inbox.truncatedPlanAcks ?? 0;
  const pendingCount =
    decisions.length +
    truncatedProposals +
    truncatedConnectionRequests +
    truncatedPlanAcks;
  const activeWorkCount = activeWork.length;
  const actionCount = pendingCount + activeWorkCount;
  const listUrl = agreementsListAppUrl(webOrigin);

  const cardOpts = {
    truncatedProposals,
    truncatedConnectionRequests,
    truncatedPlanAcks,
    agreementsListAppUrl: listUrl,
  };

  // Only the session-start read ships it. The long-poll shape passes
  // withSessionCard: false, so building it there assembled every decision
  // and up-to-20 work sections just to drop them for a one-line hint.
  const sessionChatCard = withSessionCard
    ? buildSessionChatCard(decisions, activeWork, cardOpts)
    : null;

  const proposalCount = decisions.filter((d) => d.kind === 'proposal').length;
  const linkCount = decisions.filter((d) => d.kind === 'link_request').length;
  const planAckCount = decisions.filter((d) => d.kind === 'plan_ack').length;

  // Decisions somebody made on requests this side made. Counted here and named
  // in the line the model reads; the entries themselves ride the news half of
  // the inbox result (`decidedForMe`), which the cold read already carries.
  const decidedForMe = buildDecidedForMeItems(inbox);
  const decidedNote = decidedForMeSummary(decidedForMe);

  // One line of server state for the model to read: how much of the mailbox
  // this window covers, which reads failed, and the counts. What to DO about
  // any of it is said once, on connect. Nothing here words the reply, and
  // nothing here quotes a counterparty.
  //
  // "nothing pending" is only true about mail the read actually reached. A
  // window that stops short of the present says how far short, and that has
  // to reach the line the model reads, not just a field beside it: an
  // assistant answered "nothing pending" for its person from a window ten
  // days old, while that morning's unanswered question sat outside it.
  const backlog = inbox.backlog;
  const count = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (backlog) {
    parts.push(
      `You are looking at a PARTIAL window: ${backlog.beyondWindow} more ${backlog.beyondWindow === 1 ? 'delivery is' : 'deliveries are'} unread past ${backlog.windowEndsAt}${backlog.newestAt ? `, the newest from ${backlog.newestAt}` : ''}.`,
    );
  }
  if (opts?.activeTasksError) parts.push('Active tasks could not be loaded.');
  if (actionCount === 0) {
    parts.push(
      backlog
        ? 'No pending decisions or active tasks in this window.'
        : 'No pending decisions or active tasks.',
    );
  } else {
    parts.push(
      `${count(pendingCount, 'pending decision', 'pending decisions')} (${count(proposalCount + truncatedProposals, 'proposal', 'proposals')}, ${count(linkCount + truncatedConnectionRequests, 'link request', 'link requests')}${planAckCount + truncatedPlanAcks > 0 ? `, ${count(planAckCount + truncatedPlanAcks, 'plan to acknowledge', 'plans to acknowledge')}` : ''}) and ${count(activeWorkCount, 'active task', 'active tasks')}.`,
    );
  }
  if (decidedNote) parts.push(decidedNote);
  const parkedCount = inbox.parkedProposals?.length ?? 0;
  if (parkedCount > 0) {
    parts.push(
      `${count(parkedCount, 'deferred decision', 'deferred decisions')} left pending on purpose.`,
    );
  }
  const notice = parts.join(' ');
  const attention = humanAttentionForResult(inbox.humanAttention);

  return {
    pendingCount,
    hasPending: pendingCount > 0,
    activeWorkCount,
    hasActiveWork: activeWorkCount > 0,
    actionCount,
    hasActionable: actionCount > 0,
    summary: {
      proposals: proposalCount + truncatedProposals,
      linkRequests: linkCount + truncatedConnectionRequests,
      planAcks: planAckCount + truncatedPlanAcks,
      activeTasks: activeWorkCount,
      listed: decisions.length,
      truncated:
        truncatedProposals + truncatedConnectionRequests + truncatedPlanAcks,
      decidedForMe: decidedForMe.filter((i) => i.outcome !== 'held').length,
      refusals: decidedForMe.filter((i) => i.outcome === 'rejected').length,
    },
    decisions,
    activeWork,
    truncatedProposals,
    truncatedConnectionRequests,
    truncatedPlanAcks,
    agreementsListAppUrl: listUrl,
    connectionsSettingsAppUrl: connectionsSettingsAppUrl(webOrigin),
    // one card per session start. The owner (withSessionCard) embeds
    // the full sessionChatCard; everyone else gets a pointer to it, so the card
    // isn't shipped ~6× across auth_status + pending_decisions + inbox.
    ...(withSessionCard
      ? sessionChatCard
        ? { sessionChatCard }
        : {}
      : actionCount > 0
        ? { sessionCardHint: SESSION_CARD_POINTER }
        : {}),
    ...(attention ? { humanAttention: attention } : {}),
    // when the active-task fetch failed, say so instead of letting
    // hasActiveWork:false read as "no tasks". Mirrors the inbox fetchError signal.
    ...(opts?.activeTasksError
      ? {
          activeTasksFetchError: `Could not load active tasks: ${opts.activeTasksError}`,
          workCardOmitted: true,
        }
      : {}),
    notice,
  };
}
