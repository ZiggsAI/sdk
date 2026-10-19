import { SERVER_EVENTS } from '@ziggs-ai/contracts';
import type { AgreementParties } from '@ziggs-ai/api-client';
import type {
  Action,
  AgreementRef,
  Ctx,
  Outcome,
  OutcomeKind,
  ProposalRef,
  TaskRef,
  ToolResultEntry,
} from '../types.js';
import { isProtocolToolName, mapProtocolToolToOperation } from '../tasks/protocolRegistry.js';
import { getBatchEvents, isTaskResultRelevantToAgent } from '../context/batch.js';
import {
  bookForDelegation,
  ensureTaskBook,
  findBookHoldingPending,
  removeTaskBook,
} from './taskBookkeeping.js';

// ── Event shape (untyped wire payload normalized into a small set of types) ──

/** Wire payload from the backend for task/agreement state. */
export interface WireResult {
  taskId?: string;
  state?: string;
  // no `status`. cut the name from the wire; four readers kept
  // accepting it as a `|| r.status` tail, so a backend regression reintroducing
  // `status` would have been absorbed silently instead of failing loudly.
  agreement?: AgreementRef;
  agreementId?: string;
  proposal?: { status?: 'pending' | 'approved' | 'rejected' | 'cancelled' };
  task?: TaskRef;
  success?: boolean;
  error?: string;
  providerIsYou?: boolean;
  [key: string]: unknown;
}

export interface RawEvent {
  type?: string;
  result?: WireResult;
  receiverId?: string;
  senderId?: string;
  text?: string;
  events?: RawEvent[];
  [key: string]: unknown;
}

export interface EmittedEvent {
  type: string;
  tool?: string;
  result?: WireResult;
  error?: string;
  receiverId?: string;
  chatId?: string;
  message?: string;
  text?: string;
  operation?: string;
  senderId?: string;
  [key: string]: unknown;
}

// ── outcomeFromEvent: incoming wire event → Outcome ──────────────────────────

/**
 * Converts a raw incoming event into the single Outcome that re-enters the
 * machine.
 *
 * For batched events, returns the *most significant* outcome (task assignments
 * win over messages). EventQueue already flattened multiple distinct events
 * via re-entry, so a batch here usually means events that arrived together
 * within a single backend frame.
 */
export function outcomeFromEvent(
  rawEvent: RawEvent | null | undefined,
  ownAgentId: string | null,
): Outcome {
  if (!rawEvent) return { kind: 'enter' };

  const events: RawEvent[] = getBatchEvents(rawEvent) as RawEvent[];
  let best: Outcome | null = null;

  for (const ev of events) {
    if (!ev) continue;
    const candidate = singleEventToOutcome(ev, ownAgentId);
    if (!candidate) continue;
    if (!best || outcomeRank(candidate) > outcomeRank(best)) best = candidate;
  }

  return best ?? { kind: 'enter' };
}

function singleEventToOutcome(ev: RawEvent, ownAgentId: string | null): Outcome | null {
  if (ev.type === 'agreement_lifecycle') {
    const operation = ev.operation as string | undefined;
    const agreementId = (ev.agreementId as string | undefined) ?? '';
    const action =
      operation === 'proposal_rejected'
        ? 'reject'
        : operation === 'proposal_approved' || operation === 'proposal_approved_execute'
          ? 'approve'
          : null;
    if (action && agreementId) {
      return {
        kind: 'proposal-resolved',
        action,
        proposal: { agreementId },
        proposedByMe: false, // real value stamped in AgentMachine._handleFrame from ctx (needs pendingProposalAgreementId, unavailable here)
      };
    }
    return null;
  }

  if (ev.type === 'task_result') {
    const result = ev.result || {};
    if (
      ownAgentId &&
      !isTaskResultRelevantToAgent(result, ownAgentId) &&
      ev.receiverId !== ownAgentId
    ) {
      return null;
    }

    // Agreement lifecycle notification routed as task_result by normalizeIncomingEvent.
    // _operation is set to the backend operation name (e.g. 'proposal_approved').
    const inboundOp = result._operation as string | undefined;
    if (inboundOp) {
      const proposalAction = inboundOp === 'proposal_approved' ? 'approve'
        : inboundOp === 'proposal_rejected' ? 'reject'
        : null;
      if (proposalAction) {
        const agId = result.agreementId;
        const proposal: ProposalRef = agId
          ? { agreementId: agId, agreement: result as unknown as AgreementRef }
          : { agreementId: '' };
        return { kind: 'proposal-resolved', action: proposalAction as 'approve' | 'reject', proposal, proposedByMe: false }; // real value stamped in AgentMachine._handleFrame from ctx
      }
      // Other lifecycle ops (countered, expired) treated as enter — no FSM action needed here.
      return null;
    }

    // Tasks are born active in the new model — no `proposal` task state.
    // The wire shape `task_result` always carries an active or terminal task.
    const task: TaskRef = result as unknown as TaskRef;
    const ag: AgreementRef | undefined = result.agreement;
    // The wire sends all four sides; this read tolerates an absent agreement.
    const parties: Partial<AgreementParties> = ag?.parties ?? {};
    const state = result.state;

    // Direct assignment to me (provider) — task spawned, citing an active agreement.
    const isAssignedToMe =
      (result.providerIsYou || parties.provider?.actor === ownAgentId) &&
      (state === 'active' || state === 'in-progress');
    if (isAssignedToMe) {
      return { kind: 'task-assigned', task };
    }

    if (state === 'active' || state === 'in-progress') {
      return { kind: 'task-assigned', task };
    }

    if (state === 'completed' || state === 'failed') {
      return {
        kind: 'subtask-finished',
        status: state === 'completed' ? 'completed' : 'failed',
        task,
        result,
      };
    }

    if (state === 'cancelled') {
      return {
        kind: 'subtask-finished',
        status: 'failed',
        task,
        result,
      };
    }

    // Fallback: addressed to us with no clear state.
    if (ownAgentId && ev.receiverId === ownAgentId) {
      return { kind: 'task-assigned', task };
    }

    return { kind: 'subtask-finished', status: 'completed', task, result };
  }

  if (ev.type === SERVER_EVENTS.resourceChanged) {
    const resource = ((ev as { resource?: Record<string, unknown> }).resource ?? ev) as {
      kind?: string;
      reason?: string;
      resourceId?: string;
      agreementId?: string;
      taskId?: string;
    };
    const reason = resource.reason;
    if (
      resource.kind === 'agreement' &&
      (reason === 'proposal_approved' || reason === 'proposal_rejected')
    ) {
      const agreementId = resource.agreementId ?? resource.resourceId ?? '';
      const proposal: ProposalRef = { agreementId };
      return {
        kind: 'proposal-resolved',
        action: reason === 'proposal_approved' ? 'approve' : 'reject',
        proposal,
        proposedByMe: false, // real value stamped in AgentMachine._handleFrame from ctx
        // resource_changed + proposal_approved is the store-claim
        // fan-out (chat-less). Direct-proposal counterparty approves arrive as
        // agreement_lifecycle and must not set this.
        ...(reason === 'proposal_approved' ? { fromClaimWake: true } : {}),
      };
    }
    if (resource.kind === 'task-state' && reason === 'subtask_completed') {
      const taskId = resource.taskId ?? resource.resourceId ?? '';
      const task = { taskId, state: 'completed' } as TaskRef;
      return { kind: 'subtask-finished', status: 'completed', task, result: task };
    }
    return null;
  }

  if (ev.type === 'state-timeout') {
    // Synthetic frame from Agent's StateTimers — host-constructed, fields always present.
    return { kind: 'state-timeout', state: ev.state as string, waitedMs: ev.waitedMs as number };
  }

  // The agent's own check-back coming due. Also host-constructed.
  if (ev.type === 'wake-at') {
    return {
      kind: 'wake-at',
      reason: (ev.reason as string | null) ?? null,
      scheduledFor: (ev.scheduledFor as number) ?? Date.now(),
    };
  }

  // Only real inbound chat messages should drive the FSM. Backend bookkeeping
  // (presence/heartbeat, raw `batch` outer frames, etc.) are NOT chat traffic.
  if (ev.type !== 'message') return null;

  // Suppress our own messages echoed back through the chat fanout.
  if (ownAgentId && ev.senderId && ev.senderId === ownAgentId) return null;

  const text = typeof ev.text === 'string' ? ev.text : undefined;
  const senderType = typeof ev.senderType === 'string' ? ev.senderType : undefined;
  return { kind: 'message-received', text, senderId: ev.senderId, senderType };
}

// Higher rank wins when collapsing batched events into one outcome.
function outcomeRank(o: Outcome): number {
  switch (o.kind) {
    case 'task-assigned': return 100;
    case 'proposal-resolved': return 90;
    case 'subtask-finished': return 80;
    case 'message-received': return 10;
    // Any real event coalesced into the same batch supersedes the timer —
    // waking to "nothing happened" is moot when something did. Must stay below
    // message-received (10).
    case 'state-timeout': return 1;
    default: return 50;
  }
}

// ── outcomeFromActionResult: turn output → Outcome ───────────────────────────

/**
 * Builds the single Outcome that ends a thinking-state turn from the
 * action that ran and the events it emitted.
 *
 * Action's `produces` declares the outcome kind — runtime fills in payload.
 *   - static string: kind is fixed; runtime constructs payload from events.
 *   - function: receives the tool result and args, returns the kind.
 *
 * If `produces` is missing or doesn't match the events, falls back to a
 * best-effort inference.
 */
export function outcomeFromActionResult(
  actionName: string | null,
  action: Action | null,
  args: unknown,
  emittedEvents: EmittedEvent[],
  toolResultsOut: ToolResultEntry[],
): Outcome {
  if (!emittedEvents.length) {
    return { kind: 'error', source: 'unknown', cause: `action "${actionName}" emitted nothing`, retryable: false };
  }

  // Collect tool results in caller's accumulator (used in prompts and ctx).
  for (const e of emittedEvents) {
    if (e?.type === 'tool_result') toolResultsOut.push({ tool: e.tool || '', result: e.result });
    if (e?.type === 'tool_error') toolResultsOut.push({ tool: e.tool || '', error: e.error });
  }

  // Pick the "primary" event the outcome describes.
  //
  // Protocol-level state changes (agreement creation, task assignment/closure,
  // proposal response) outrank EVERYTHING else, including message_sent and
  // waited. Why: when the LLM batches `delegate` + `wait` in one round, the
  // sub-agreement DOES get created server-side, but if `waited` wins the FSM
  // sees `wait` and bounces back to `idle` instead of transitioning to
  // `awaitingSubAgreementApproval` — and the chain stalls. The meaningful
  // turn outcome is the work that landed, not the LLM's terminal decision.
  //
  // Among non-protocol events: message_sent / waited still outrank pure
  // query tool_results (e.g. agent_network search) and tool_errors, because
  // those are the LLM's explicit final intent in turns that did no protocol
  // work.
  const primary =
    emittedEvents.find(e => e.type === 'task_result' && isStateChangingProtocolEvent(e)) ??
    emittedEvents.find(e => e.type === 'tool_result' && isStateChangingProtocolEvent(e)) ??
    emittedEvents.find(e => e.type === 'message_sent') ??
    emittedEvents.find(e => e.type === 'message_duplicate_skipped') ??
    emittedEvents.find(e => e.type === 'waited') ??
    emittedEvents.find(e => e.type === 'tool_result') ??
    emittedEvents.find(e => e.type === 'tool_error') ??
    emittedEvents.find(e => e.type === 'task_result') ??
    emittedEvents.find(e => e.type === 'task_error') ??
    emittedEvents[0];

  // Resolve the kind via produces (preferred) or by inferring from primary.
  let kind: OutcomeKind | null = null;
  if (action?.produces) {
    const p = action.produces;
    const result = primary?.type === 'tool_result' ? primary.result : undefined;
    kind = typeof p === 'function' ? p(result, args) : p;
  }
  if (!kind) kind = inferKindFromEvent(primary);

  return buildOutcomeOfKind(kind, primary, action);
}

/**
 * Whether a tool_result / task_result represents a protocol state change
 * (agreement creation, task assignment / closure, proposal response). Used
 * to outrank pure query tool_results (e.g. `agent_network search`) when the
 * same turn batches multiple tools.
 */
function isStateChangingProtocolEvent(ev: EmittedEvent): boolean {
  const op = ev.type === 'task_result'
    ? ev.operation
    : (ev.tool && isProtocolToolName(ev.tool) ? mapProtocolToolToOperation(ev.tool) : null);
  if (!op) return false;
  const r: WireResult = ev.result ?? ({} as WireResult);
  if (r.success === false || r.error) return false;
  const ag = r.agreement ?? (r.agreementId ? r : null);
  const task = r.task || (r.taskId ? r : null);
  const proposalStatus = ag?.proposal?.status;
  const state = task?.state || r.state;
  if (op === 'agreement-propose' || op === 'agreement-subcontract') {
    return proposalStatus === 'pending' || proposalStatus === 'approved' || !!ag?.agreementId;
  }
  if (op === 'agreement-respond') return true;
  if (op === 'task-update') {
    return state === 'completed' || state === 'failed' || state === 'cancelled';
  }
  if (op === 'task-spawn') return !!task?.taskId;
  return false;
}

function inferKindFromEvent(primary: EmittedEvent | undefined): OutcomeKind {
  if (!primary) return 'error';
  switch (primary.type) {
    case 'message_sent': return 'message-sent';
    case 'message_duplicate_skipped': return 'message-sent';
    case 'waited': return 'wait';
    case 'tool_error': return 'error';
    case 'task_error': return 'error';
    case 'tool_result': return inferKindFromToolResult(primary);
    case 'task_result': return inferKindFromTaskResult(primary);
    default: return 'tool-result';
  }
}

function inferKindFromToolResult(ev: EmittedEvent): OutcomeKind {
  if (!isProtocolToolName(ev.tool ?? '')) return 'tool-result';
  const op = mapProtocolToolToOperation(ev.tool ?? '');
  return inferKindFromProtocolOp(op ?? undefined, ev.result);
}

function inferKindFromTaskResult(ev: EmittedEvent): OutcomeKind {
  return inferKindFromProtocolOp(ev.operation, ev.result);
}

function inferKindFromProtocolOp(op: string | undefined, result: unknown): OutcomeKind {
  const r: WireResult = (result as WireResult) || ({} as WireResult);
  const ag: AgreementRef | undefined = r.agreement ?? (r.agreementId ? r as unknown as AgreementRef : undefined);
  const task: TaskRef | undefined = r.task || (r.taskId ? r as unknown as TaskRef : undefined);

  // Agreement creation verbs no longer create paired tasks. The caller (creator)
  // has made a proposal awaiting response from the proposedTo party.
  if (
    op === 'agreement-propose' ||
    op === 'agreement-subcontract'
  ) {
    return 'proposal-made';
  }
  if (op === 'task-spawn') {
    // A task was just spawned under an active agreement. From the spawner's
    // side this is a delegation; the executor sees `task-assigned` via the
    // task_result event channel.
    return 'task-delegated';
  }
  if (op === 'task-update') {
    // Same resolution as `isStateChangingProtocolEvent` above — `state` only.
    const state = task?.state || r.state;
    if (state === 'completed' || state === 'failed') return 'task-closed';
    return 'tool-result';
  }
  if (op === 'agreement-respond') {
    // The responder's tool result is the agreement after approve/reject.
    return 'proposal-resolved';
  }
  void ag;
  return 'tool-result';
}

function buildOutcomeOfKind(
  kind: OutcomeKind,
  primary: EmittedEvent | undefined,
  action: Action | null,
): Outcome {
  const tool = action?.tool || primary?.tool || '';
  const result = primary?.type === 'tool_result' ? primary.result : primary?.result;

  switch (kind) {
    case 'enter':
    case 'wait':
      return { kind };

    case 'state-timeout':
      // Runtime-generated only (validateWorkflow rejects produces:'state-timeout').
      // Break-fast backstop if an action somehow declares it.
      throw new Error(`action produced reserved outcome kind "state-timeout" — runtime-generated only`);

    // Same rule: the host arms the timer and the host builds this
    // outcome from the fired frame. A turn cannot produce one.
    case 'wake-at':
      throw new Error(`action produced reserved outcome kind "wake-at" — runtime-generated only`);

    case 'message-sent':
      return { kind, text: primary?.message, receiverId: primary?.receiverId };

    case 'message-received':
      return { kind, text: primary?.text };

    case 'task-assigned': {
      const task: TaskRef = (result?.task || result || {}) as unknown as TaskRef;
      return { kind, task };
    }
    case 'task-delegated': {
      const task: TaskRef = (result?.task || result || {}) as unknown as TaskRef;
      return { kind, task };
    }
    case 'task-closed': {
      const raw = result?.task?.state || result?.state;
      const status: 'completed' | 'failed' = raw === 'failed' ? 'failed' : 'completed';
      const taskId =
        result?.task?.taskId ||
        (typeof result?.taskId === 'string' ? result.taskId : undefined);
      return { kind, status, taskId, result };
    }
    case 'subtask-finished': {
      const task: TaskRef = (result?.task || result || {}) as unknown as TaskRef;
      const status = (task.state === 'failed' ? 'failed' : 'completed') as 'completed' | 'failed';
      return { kind, status, task, result };
    }
    case 'proposal-made': {
      const ag: AgreementRef | undefined = result?.agreement ?? (result?.agreementId ? result as unknown as AgreementRef : undefined);
      const proposal: ProposalRef = ag
        ? { agreementId: ag.agreementId, agreement: ag }
        : { agreementId: result?.agreementId || '' };
      return { kind, proposal };
    }
    case 'proposal-resolved': {
      const ag: AgreementRef | undefined = result?.agreement ?? (result?.agreementId ? result as unknown as AgreementRef : undefined);
      const status = ag?.proposal?.status;
      const action_: 'approve' | 'reject' = status === 'rejected' ? 'reject' : 'approve';
      const proposal: ProposalRef = ag
        ? { agreementId: ag.agreementId, agreement: ag }
        : { agreementId: result?.agreementId || '' };
      return { kind, action: action_, proposal, proposedByMe: false }; // turn path = our own agreement_respond ran — we are the responder, by definition not the proposer
    }
    case 'tool-result':
      return { kind, tool, result };

    case 'error': {
      const cause = primary?.error || primary?.result || 'unknown error';
      const source = primary?.type === 'tool_error' || primary?.type === 'tool_result' ? 'tool' : 'unknown';
      return { kind, source, cause, retryable: false };
    }
    case 'extension':
      return { kind, name: tool || 'unknown', payload: result };
  }
}

// ── applyOutcomeToCtx: persistent ctx updates from a new outcome ─────────────

/**
 * Mutates ctx to absorb persistent state from a new outcome:
 * - task bookkeeping keyed by taskId — close clears only that entry
 * - focus activeAgreementId/activeTaskId on assignment
 * - pending proposal id on proposal-made, cleared on resolution
 * - delegated children accumulated under the parent engagement's book
 */
export function applyOutcomeToCtx(ctx: Ctx, outcome: Outcome): void {
  ctx.lastOutcome = outcome;
  if (!ctx.tasks) ctx.tasks = {};

  switch (outcome.kind) {
    case 'task-assigned': {
      const t = outcome.task || ({} as TaskRef);
      const tid = t.taskId || (t as unknown as Record<string, unknown>).id as string | undefined;
      const agId = t.agreementId || t.agreement?.agreementId || ctx.pendingProposalAgreementId;
      if (tid) {
        ensureTaskBook(ctx, tid, agId ?? null);
        ctx.activeTaskId = tid;
      }
      if (agId) ctx.activeAgreementId = agId;
      ctx.pendingProposalAgreementId = null;
      break;
    }
    case 'task-delegated': {
      const t = outcome.task || ({} as TaskRef);
      const tid = t.taskId;
      const agId = t.agreementId || t.agreement?.agreementId;
      const book = bookForDelegation(ctx);
      if (tid && !(tid in book.pendingSubtasks)) {
        book.pendingSubtasks[tid] = {
          agentId: t.assigneeId ?? t.executorId ?? t.agreement?.parties?.provider?.actor ?? null,
          spawnedAt: Date.now(),
        };
      }
      if (agId && !book.delegatedAgreementIds.includes(agId)) book.delegatedAgreementIds.push(agId);
      break;
    }
    case 'proposal-made': {
      const agId = outcome.proposal?.agreementId;
      if (agId) ctx.pendingProposalAgreementId = agId;
      break;
    }
    case 'proposal-resolved': {
      // Approval of the agent's PRIMARY proposal (the one binding it to its
      // counterparty — e.g. Ziggs ↔ user) promotes the pending id into
      // activeAgreementId so transitions gated on activeAgreementId fire.
      // We only do this when no agreement is currently active, so that
      // approvals of CHILD sub-agreements (e.g. coffee-agent approving the
      // Ziggs-issued subcontract) don't overwrite the root the primary agent
      // is bound to. Sub-agreement bookkeeping lives in delegatedAgreementIds
      // (recorded on task-delegated) — not here.
      if (outcome.action === 'approve' && !ctx.activeAgreementId) {
        const agId = outcome.proposal?.agreementId || ctx.pendingProposalAgreementId;
        if (agId) ctx.activeAgreementId = agId;
      }
      ctx.pendingProposalAgreementId = null;
      break;
    }
    case 'subtask-finished': {
      const t = outcome.task;
      const taskId = t?.taskId;
      const agId = t?.agreementId || t?.agreement?.agreementId;
      if (taskId) {
        const book = findBookHoldingPending(ctx, taskId) ?? bookForDelegation(ctx);
        const pending = book.pendingSubtasks[taskId];
        delete book.pendingSubtasks[taskId];
        const payload = t?.result ?? null;
        const existing = book.collectedResults.find(r => r.taskId === taskId);
        if (!existing) {
          book.collectedResults.push({
            taskId,
            agentId: pending?.agentId ?? t?.assigneeId ?? t?.executorId ?? t?.agreement?.parties?.provider?.actor ?? null,
            status: outcome.status,
            result: payload,
          });
        } else if (existing.result == null && payload != null) {
          // A bare resource_changed(subtask_completed) skeleton ({taskId, state})
          // can arrive BEFORE the full task_result for the same completion.
          // Upgrade the placeholder in place instead of dropping the real payload.
          // The skeleton often lacks executor identity, so also fill agentId
          // from the fuller frame when the placeholder recorded none.
          existing.status = outcome.status;
          existing.result = payload;
          if (existing.agentId == null) {
            existing.agentId = t?.assigneeId ?? t?.executorId ?? t?.agreement?.parties?.provider?.actor ?? null;
          }
        }
        if (agId) {
          book.delegatedAgreementIds = book.delegatedAgreementIds.filter(id => id !== agId);
        }
      }
      break;
    }
    case 'task-closed': {
      // Clear only this task's entry — sibling open tasks keep their books.
      // buildOutcomeOfKind already collapses result.task.taskId /
      // result.taskId into outcome.taskId — do not re-walk the raw result here.
      const closedId = outcome.taskId || ctx.activeTaskId;
      if (closedId) removeTaskBook(ctx, closedId);
      else {
        // No id at all — cannot safely target; leave siblings alone and only
        // drop focus scalars.
        ctx.activeTaskId = null;
        ctx.activeAgreementId = null;
      }
      ctx.pendingProposalAgreementId = null;
      break;
    }
    default:
      break;
  }
}
