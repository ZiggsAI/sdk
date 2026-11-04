import { prepareWorkExecution } from '@ziggs-ai/api-client';
import { deliveryHandlingId, withWorkExecution } from '@ziggs-ai/api-client';
import {
  MessageRecordsClient,
  InboxClient,
  planInboxAck,
  planPartialInboxAck,
  type InboxAckResult,
  type InboxDeliveryRef,
  type InboxRequestRef,
  type InboxTaskRef,
  type Creds,
} from '@ziggs-ai/api-client';
import { SeenMessages } from './SeenMessages.js';
import type { TaskInputRef } from '../types.js';
import { runtimeLog } from '../shared/runtimeLog.js';
import { isRateLimited } from '@ziggs-ai/api-client';

/**
 * Per-agent inbox long-poll loop (delivery law, phase 4). This is the ONLY way
 * a hosted agent consumes: `GET /inbox?wait=` → grant-fenced reads of what was
 * addressed to it → deliver into the host's lane/tick machinery →
 * `POST /inbox/ack`. No socket, no push, no separate catch-up channel — a
 * crash-replay is just the next iteration (the watermark is server-side), and
 * writes carry idempotency keys so re-processing a redelivered window is
 * wasteful, never harmful. Act-before-ack is the one ordering rule.
 *
 * The envelope now names the chats directly, so this loop no longer expands
 * scopes into chat ids itself — that cost an extra grant/agreement lookup per
 * scope, per pass, purely to rediscover what the server already knew.
 */

export interface InboxLoopDeps {
  creds: Creds;
  ownAgentId: string;
  baseUrl?: string;
  seen: SeenMessages;
  onMessage: (text: string, metadata: Record<string, unknown>) => Promise<void>;
  onResourceEvent: (event: Record<string, unknown>) => Promise<void>;
  /**
   * An open task assigned to this agent. Delivered from the inbox's
   * own task channel, so work reaches the agent even when no chat row exists
   * for it (chat-less agreement, self-assigned task).
   */
  onTask?: (task: InboxTaskRef, inputs: TaskInputRef[]) => Promise<void>;
  /**
   * A marketplace request doorbell. The host MUST triage with a plain
   * string compare and return without an LLM wake on miss — otherwise every
   * public request burns a full Claude turn per published supplier.
   */
  onRequest?: (request: InboxRequestRef) => Promise<void>;
  /** Host-only control observation for blocked task assignments; never a model wake. */
  onTaskControlCheck?: (taskId: string) => Promise<void>;
  label?: string;
  /**
   * How many assigned wakes run at once. Defaults to
   * `ZIGGS_AGENT_INBOX_CONCURRENCY`, else {@link DEFAULT_INBOX_CONCURRENCY}.
   */
  concurrency?: number;
  /**
   * This process is one of several hosting the agent. Each read says how many
   * more threads this host can start, so the work spreads across hosts.
   * Defaults to `ZIGGS_AGENT_SHARED_INBOX=1`.
   */
  sharedHost?: boolean;
  /**
   * Shared hosts: told after every read whether this host leads (holds the
   * inbox lease). The leader runs the agent's polls and timers.
   */
  onLeadership?: (leader: boolean) => void;
}

/** Whether this process runs as one of several hosts of its agents. */
export function sharedInboxHost(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return /^(1|true|yes|shared)$/i.test(process.env.ZIGGS_AGENT_SHARED_INBOX ?? '');
}

export interface InboxPassResult {
  /** Delivery references this envelope carried. */
  deliveries: number;
  messagesDelivered: number;
  resourceEvents: number;
  /** Assigned open tasks delivered this pass. */
  tasksDelivered: number;
  /** Request refs triaged this pass — includes misses that only ack. */
  requestsTriaged: number;
  /** True when the watermark advanced this pass. */
  acked: boolean;
  /** True when there was more mail than one envelope carries. */
  truncated: boolean;
  /** The latest delivery this envelope answered, to pass back as `seen`. */
  bellAt?: string;
  /**
   * Handovers into the host that failed this pass. Non-zero means the
   * watermark was deliberately held, so the same window arrives again.
   */
  failures: number;
  /**
   * Assigned work this host was not allowed to run: a delivery it cannot open
   * or prepare, a task or decision whose execution was refused. Skipped, not
   * failed: the server keeps it pending, stops ringing for it, and offers it
   * again once it can run, so it neither holds the watermark nor slows the loop.
   */
  blocked: number;
  /** Assigned messages and tasks whose wake this pass started. */
  dispatched: number;
  /**
   * Assigned rows this pass skipped because a wake an earlier pass started for
   * them is still running. The server lists a row until it is handled, so it
   * comes back on every read while its wake runs; it is never handed over twice.
   */
  alreadyRunning: number;
  /** Assigned rows left for a later pass because every wake slot was busy. */
  deferred: number;
}

/** How many assigned wakes one agent runs at once unless told otherwise. */
export const DEFAULT_INBOX_CONCURRENCY = 4;

/**
 * The wake bound for one agent: `explicit`, else `ZIGGS_AGENT_INBOX_CONCURRENCY`,
 * else {@link DEFAULT_INBOX_CONCURRENCY}. Never below one.
 */
export function inboxConcurrency(explicit?: number): number {
  const env = process.env.ZIGGS_AGENT_INBOX_CONCURRENCY;
  const raw = explicit ?? (env ? Number(env) : NaN);
  return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : DEFAULT_INBOX_CONCURRENCY;
}

/** A dispatched job's place in the handover order. */
export interface HandoverTurn {
  /** Resolves once every job dispatched before this one has handed over (or given up). */
  ready: Promise<void>;
  /** Say the handover has started, letting the next job hand over. */
  done: () => void;
}

/**
 * The wakes one inbox loop has handed over and not yet seen finish.
 *
 * Bounded: at most `limit` run at once. Keyed by what the server lists again
 * while the work is pending (a receipt, a task), so a row that comes back on
 * the next read while its wake still runs is never handed over twice. Ordered
 * jobs hand over in the order they were dispatched: messages are dispatched
 * oldest first, so the messages of one thread reach their lane in the order
 * they were sent, and the lane runs them one at a time. Different threads run
 * side by side.
 */
export class InboxDispatch {
  readonly limit: number;
  private readonly running = new Map<string, Promise<void>>();
  private lastTurn: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private failed = 0;

  constructor(limit?: number) {
    this.limit = inboxConcurrency(limit);
  }

  /** Wakes running now. */
  get size(): number {
    return this.running.size;
  }

  get full(): boolean {
    return this.running.size >= this.limit;
  }

  has(key: string): boolean {
    return this.running.has(key);
  }

  /**
   * Run `job` under `key`. It resolves `true` when its work was handed over
   * and finished, `false` when it was not handled. An ordered job waits for
   * `turn.ready` before it hands over and calls `turn.done()` once it has.
   */
  start(key: string, job: (turn: HandoverTurn) => Promise<boolean>, ordered = false): Promise<void> {
    let done!: () => void;
    const handedOver = new Promise<void>((resolve) => { done = resolve; });
    const turn: HandoverTurn = { ready: ordered ? this.lastTurn : Promise.resolve(), done };
    if (ordered) this.lastTurn = handedOver;
    const run = (async () => {
      try {
        if (!(await job(turn))) this.failed++;
      } catch (err) {
        this.failed++;
        runtimeLog.warn('inboxLoop', `${key} failed: ${(err as Error)?.message ?? err}`);
      } finally {
        done();
        this.running.delete(key);
        for (const listener of [...this.listeners]) listener();
      }
    })();
    this.running.set(key, run);
    return run;
  }

  /** Jobs that were not handled since the last call. The loop backs off on them. */
  takeFailures(): number {
    const failed = this.failed;
    this.failed = 0;
    return failed;
  }

  /** Resolves when any running job finishes, `ms` passes (if given), or `signal` aborts. */
  settledOr(ms?: number, signal?: AbortSignal): Promise<void> {
    if (this.running.size === 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = ms === undefined ? undefined : setTimeout(finish, Math.max(0, ms));
      this.listeners.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  /** Resolves when nothing is running. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }
}

function log(label: string, msg: string): void {
  runtimeLog.info(label, msg);
}

function inboxClient(deps: InboxLoopDeps): InboxClient {
  return new InboxClient(
    deps.creds.operatorKey,
    deps.creds.agentId,
    deps.baseUrl,
    deps.creds.instanceId,
    {
      clientSessionId: deps.creds.clientSessionId,
      workspaceIds: deps.creds.workspaceIds,
      app: deps.creds.app,
      sessionName: deps.creds.sessionName,
      ...(sharedInboxHost(deps.sharedHost) ? { sharedHost: true } : {}),
    },
  );
}

async function releaseInboxHostBestEffort(deps: InboxLoopDeps): Promise<void> {
  try {
    await inboxClient(deps).releaseHost();
  } catch (err) {
    warn(
      deps.label ?? 'inboxLoop',
      `inbox host release failed: ${(err as Error)?.message ?? err}`,
    );
  }
}

function warn(label: string, msg: string): void {
  runtimeLog.warn(label, msg);
}

/**
 * Standing proposals share the merged inbox visibility model with deliveries,
 * but older envelopes predate an explicit assignee stamp. Prefer the server's
 * role-to-actor assignment. On an older server, wake only for an agent-keyed
 * approval/responder slot — withholding a wake is safer than waking every
 * sibling merely because they share an org principal.
 */
function proposalIsMine(
  proposal: {
    assignedAgentId?: string | null;
    pendingApprovalPartyIds?: string[];
    proposedTo?: string | null;
  },
  ownAgentId: string,
): boolean {
  if (proposal.assignedAgentId !== undefined) {
    return proposal.assignedAgentId === ownAgentId;
  }
  return (
    proposal.pendingApprovalPartyIds?.includes(ownAgentId) === true ||
    proposal.proposedTo === ownAgentId
  );
}

/** Read the exact request this agent was assigned and hand it to the host.
 * Historical lookup is optional context, never handoff. A request's wake is
 * its receipt: one receipt, one wake. The message's thread rides along as
 * `threadRootId`, so the host can keep the thread on one lane. */
async function deliverAssignedMessage(
  deps: InboxLoopDeps,
  ref: InboxDeliveryRef,
  reader: MessageRecordsClient,
  attempt: (what: string, handover: () => Promise<void>) => Promise<boolean>,
  handledIds: Set<string>,
  turn: HandoverTurn,
): Promise<boolean> {
  const receiptId = deliveryHandlingId(ref);
  const handled = await attempt(`message ${ref.resourceId}`, () =>
    (async () => {
      if (!ref.action) throw new Error('Assigned message has no domain action');
      const execution = await prepareWorkExecution(ref.action, deps.creds.operatorKey, deps.ownAgentId, deps.baseUrl);
      return withWorkExecution(execution, async () => {
      const row = await reader.get(ref.resourceId);
      // Every message names its thread; one that does not is refused, not guessed.
      const threadRootId = (row as { rootMessageId?: unknown }).rootMessageId;
      if (typeof threadRootId !== 'string' || !threadRootId)
        throw new Error(`Message ${row.messageId} names no thread root`);
      const metadata = { messageId: row.messageId, ...(row.mandate ?? {}),
        sender: { id: row.sender.ref, type: row.sender.kind }, receiver: { id: deps.ownAgentId, type: 'agent' },
        entryType: 'message', intent: row.intent, timestamp: row.timestamp, roomless: true, threadRootId };
      // Hand over in dispatch order; only the read above runs ahead.
      await turn.ready;
      const handover = deps.onMessage(row.content.text, {
        ...metadata, assigneeId: deps.ownAgentId, receiptId,
        executionContext: execution,
        ...(ref.agreementId ? { agreementId: ref.agreementId } : {}),
        ...(ref.taskId ? { taskId: ref.taskId } : {}),
      });
      turn.done();
      await handover;
      });
    })());
  if (handled) {
    deps.seen.mark(receiptId);
    handledIds.add(receiptId);
  }
  return handled;
}

/**
 * One long-poll pass: hold up to `waitSeconds` for new inbox content, then read
 * the deltas, deliver them into the host, and ack. Returns what it delivered.
 * Reused each iteration of {@link runInboxLoop}; also usable as a single catch-up
 * read (`waitSeconds: 0`) at bootstrap.
 *
 * Assigned messages and tasks run as wakes, up to the agent's bound at once.
 * Without `opts.dispatch` the pass waits for every wake it started before it
 * returns. With one (the loop's own), the pass returns as soon as its wakes
 * are started: each wake acknowledges its own row when it finishes, and rows
 * the dispatch is still running are skipped.
 */
export async function pollInboxOnce(
  deps: InboxLoopDeps,
  waitSeconds = 0,
  opts: { forceAck?: boolean; signal?: AbortSignal; dispatch?: InboxDispatch; seen?: string } = {},
): Promise<InboxPassResult> {
  const label = deps.label ?? 'inboxLoop';
  const inbox = inboxClient(deps);

  const shared = sharedInboxHost(deps.sharedHost);
  const free = opts.dispatch
    ? Math.max(0, opts.dispatch.limit - opts.dispatch.size)
    : inboxConcurrency(deps.concurrency);
  const envelope = await inbox.getInbox({
    ...(waitSeconds > 0 ? { waitSeconds } : {}),
    ...(opts.seen ? { seen: opts.seen } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(shared ? { capacity: free } : {}),
  });
  // A response may race shutdown. Do not enqueue another wake after stopping;
  // an already-running pass keeps its lease through its final acknowledgement.
  opts.signal?.throwIfAborted();
  if (envelope.host) deps.onLeadership?.(envelope.host.leader);

  let messagesDelivered = 0;
  let resourceEvents = 0;
  let tasksDelivered = 0;
  let requestsTriaged = 0;
  let failures = 0;
  let dispatched = 0;
  let alreadyRunning = 0;
  let deferred = 0;
  // A pass with its own dispatch waits for its wakes; the loop's does not.
  const detached = opts.dispatch !== undefined;
  const dispatch = opts.dispatch ?? new InboxDispatch(deps.concurrency);
  /** Wakes this pass started that have not finished. */
  let runningHere = 0;
  /** Whether another wake may start now. A detached pass leaves the row for later. */
  const roomForWake = async (): Promise<boolean> => {
    if (!dispatch.full) return true;
    if (detached) { deferred++; return false; }
    while (dispatch.full) await dispatch.settledOr();
    return true;
  };
  const startWake = (key: string, job: (turn: HandoverTurn) => Promise<boolean>, ordered = false): void => {
    dispatched++;
    runningHere++;
    void dispatch.start(key, job, ordered).finally(() => { runningHere--; });
  };

  // a handover that failed must not be acked, and must not be
  // remembered as seen — otherwise the redelivery the held watermark buys is
  // dropped as a duplicate. One failure does not abandon the rest of the
  // envelope: the others are still delivered, and the watermark waits for all.
  const attempt = async (
    what: string,
    handover: () => Promise<void>,
    forget?: () => void,
  ): Promise<boolean> => {
    try {
      await handover();
      return true;
    } catch (err) {
      // A refused agreement-only wake never recovers by redelivery, and every
      // redelivery spends a wake from the work's budget. Settle it.
      if ((err as { code?: string; settled?: boolean })?.code === 'REQUIRED_CONTEXT_UNAVAILABLE'
        && (err as { settled?: boolean }).settled === true) {
        warn(label, `${what} settled without a turn: this agent cannot read that agreement`);
        return true;
      }
      failures++;
      forget?.();
      warn(label, `${what} was not handled: ${(err as Error)?.message ?? err} — holding the ack`);
      return false;
    }
  };

  if (envelope.deliveriesCapped) {
    // The listed window is the oldest CAP. Acking it slides the cursor; the
    // newer tail stays past ackTo and arrives on the next pass. Holding here
    // was the wedge: the same over-cap window came back forever.
    warn(
      label,
      'inbox deliveriesCapped (more mail than one envelope carries — the tail follows on the next pass)',
    );
  }

  // The single-assign law: a row is MINE to act on iff it carries my stamp.
  // Everything else in the merged view (a sibling carrier's mail, the owner's
  // needs-human rows, granted ambient lanes) is context the host may read on
  // demand — never a wake, never mine to ack as handled.
  //
  // A responsibility is its receipt: without one the server cannot settle the
  // row, so it is not mine to act on. One such row (written by an older
  // server) must not fail the whole pass and stop every other delivery.
  const unreceipted = envelope.deliveries.filter(
    d => d.assigneeId === deps.ownAgentId && !d.receiptId,
  );
  if (unreceipted.length) {
    warn(
      label,
      `${unreceipted.length} assigned deliver${unreceipted.length === 1 ? 'y has' : 'ies have'} no receiptId; skipped (${unreceipted.map(d => `${d.kind} ${d.resourceId}`).join(', ')})`,
    );
  }
  const mine = (d: { assigneeId?: string | null; receiptId?: string | null }) =>
    d.assigneeId === deps.ownAgentId && Boolean(d.receiptId);

  // Give the mark back as each wake finishes instead of once at the end.
  //
  // A pass that acks only when it finishes holds every finished row behind its
  // slowest wake, while the server and the person's stand-in read an
  // unacknowledged row as unanswered. Measured, a single turn is ~19s but an
  // uninterrupted stretch is ~86s median, so the pass, not the turn, is what
  // crosses a 90 s window. A row is settled by its own receipt id, in any
  // order (`planPartialInboxAck`), so each wake acknowledges its row the moment
  // it finishes, whatever else is still running beside it.
  // Blocked work is the server's to retry, not a handover that failed here:
  // it stays pending without ringing, so holding the mark or backing off for
  // it would only delay the work that can run.
  const blocked = envelope.deliveries.filter(d => mine(d) && (d.executionBlocked || d.outOfReach)).length
    + (envelope.tasksAwaitingMe ?? []).filter(t => t.executionBlocked).length
    + envelope.proposalsAwaitingMe.filter(p => p.assignedAgentId === deps.ownAgentId && p.executionBlocked).length;
  if (blocked) {
    log(label, `${blocked} assignment(s) cannot run yet (no access or execution refused); left pending for the server to offer again`);
  }
  if (deps.onTaskControlCheck) {
    const blockedTasks = new Set([
      ...envelope.deliveries.filter(d => mine(d) && d.kind === 'task-state' && d.executionBlocked && !d.outOfReach).map(d => d.resourceId),
      ...(envelope.tasksAwaitingMe ?? []).filter(t => t.executionBlocked).map(t => t.taskId),
    ]);
    for (const taskId of blockedTasks) {
      try { await deps.onTaskControlCheck(taskId); }
      catch (error) { warn(label, `task control observation failed for ${taskId}: ${(error as Error).message}`); }
    }
  }
  // A receipt with no owner action is transport-only: acknowledge observation
  // without creating model work. An FYI never carries this agent's stamp, so
  // it is not even here: the watermark moves past it and nothing wakes.
  const handledSoFar = new Set<string>(envelope.deliveries.filter(d => mine(d) && d.kind !== 'request' && (!d.action || d.actionState === 'settled') && !d.outOfReach && !d.executionBlocked).map(deliveryHandlingId));
  const acknowledged = new Set<string>();
  // A handled id the server would not settle (it lost access mid-wake) stays
  // pending there and comes back once it can run; this pass is not redone.
  const noteRefused = (result: Pick<InboxAckResult, 'refusedDeliveryIds'> | null | undefined | void): void => {
    const refused = result ? result.refusedDeliveryIds : undefined;
    if (refused?.length) {
      warn(label, `ack left ${refused.length} handled assignment(s) pending: ${refused.map(r => `${r.id} (${r.reason})`).join(', ')}`);
    }
  };
  const ackWhatIsFinished = async (): Promise<void> => {
    const step = planPartialInboxAck(envelope, handledSoFar, {
      ownAgentId: deps.ownAgentId,
      failures,
    });
    if (!step) return;
    step.handledDeliveryIds = step.handledDeliveryIds.filter(id => !acknowledged.has(id));
    if (!step.handledDeliveryIds.length) return;
    // Claimed before the call: wakes finish side by side, and each sends only
    // the rows nobody is acknowledging yet.
    step.handledDeliveryIds.forEach(id => acknowledged.add(id));
    try {
      noteRefused(await inbox.ack(step.ackTo, { handledDeliveryIds: step.handledDeliveryIds }));
      log(label, `acked up to ${step.ackTo} (mid-pass)`);
    } catch (err) {
      step.handledDeliveryIds.forEach(id => acknowledged.delete(id));
      // Never fatal: the end-of-pass ack is still coming, and the watermark is
      // monotonic, so a lost step costs nothing but the exposure it would have
      // closed.
      warn(label, `mid-pass ack did not land: ${(err as Error)?.message ?? err}`);
    }
  };

  // A request is the one message that wakes: the server stamps it with this
  // agent and a message action. A message that is a task's input carries the
  // task action instead and reaches the task executor below. Every assigned
  // request is fetched by resource identity; navigation is optional.
  //
  // Oldest first: the messages of one thread must reach their lane in the
  // order they were sent. Each runs as its own wake beside the others.
  const assigned = envelope.deliveries
    .filter(d => d.kind === 'message' && d.action?.kind === 'message' && d.actionState !== 'settled' && d.actionState !== 'waiting' && mine(d) && !d.outOfReach && !d.executionBlocked)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const records = new MessageRecordsClient(deps.creds.operatorKey, deps.creds.agentId, deps.baseUrl);
  let heldBack = false;
  for (const delivery of assigned) {
    const receiptId = deliveryHandlingId(delivery);
    // Before the seen check: the host marks a message seen when its wake
    // starts, and a running wake is not a handled one.
    if (dispatch.has(receiptId)) { alreadyRunning++; continue; }
    if (deps.seen.has(receiptId)) { handledSoFar.add(receiptId); continue; }
    // Once one message is left for later, so is every newer one: a slot that
    // frees meanwhile must not let a later message of its thread overtake it.
    if (heldBack) { deferred++; continue; }
    if (!(await roomForWake())) { heldBack = true; continue; }
    startWake(receiptId, async (turn) => {
      const handled = await deliverAssignedMessage(deps, delivery, records, attempt, handledSoFar, turn);
      if (handled) messagesDelivered++;
      await ackWhatIsFinished();
      return handled;
    }, true);
  }
  if (!detached) await dispatch.idle();

  // Everything that is not chat text is handed over as a resource event, from
  // the delivery itself — the reference already carries the ids the host needs,
  // so nothing has to be re-derived to name what changed.
  // Requests have a dedicated triage path and tasks use their canonical executor.
  // Unassigned rows never take it either: waking the brain on a sibling's
  // mail is the N-wakes-per-event cost the party-owned inbox exists to kill.
  for (const d of envelope.deliveries) {
    if (d.kind === 'message' || d.kind === 'request' || d.action?.kind === 'task') continue;
    if (!mine(d) || d.executionBlocked || d.outOfReach || !d.action || d.actionState === 'settled' || d.actionState === 'waiting') continue;
    const key = deliveryHandlingId(d);
    // Handled on an earlier pass — it still settles this instant, exactly as
    // it does in the end-of-pass list.
    if (deps.seen.has(key)) {
      handledSoFar.add(deliveryHandlingId(d));
      continue;
    }
    deps.seen.mark(key);
    const handled = await attempt(
      `${d.kind} ${d.resourceId}`,
      async () => {
        const executionContext = await prepareWorkExecution(d.action!, deps.creds.operatorKey, deps.ownAgentId, deps.baseUrl);
        return deps.onResourceEvent({
          kind: d.kind,
          ts: d.ts,
          resourceId: d.resourceId,
          ...(d.receiptId ? { receiptId: d.receiptId, executionContext } : {}),
          ...(d.addressId ? { addressId: d.addressId } : {}),
          ...(d.agreementId ? { agreementId: d.agreementId } : {}),
          ...(d.taskId ? { taskId: d.taskId } : {}),
          // claim/listing wakes carry reason + claimer; host needs
          // both for agrn lane routing, claim kickoff, and chat_open buyer id.
          ...(d.reason != null && d.reason !== '' ? { reason: d.reason } : {}),
          ...(d.actorId ? { actorId: d.actorId } : {}),
          change: 'created',
          executionContext,
        });
      },
      () => deps.seen.unmark(key),
    );
    if (handled) {
      resourceEvents++;
      handledSoFar.add(deliveryHandlingId(d));
    }
  }
  // An older row here may have been holding the mark back behind the chats.
  await ackWhatIsFinished();

  // One canonical task action, however many receipts announced changes to it.
  // A receipt is acknowledged only after this action was handed to the task executor.
  const taskActions = new Map<string, { task: InboxTaskRef; receipts: InboxDeliveryRef[] }>();
  for (const task of envelope.tasksAwaitingMe ?? []) {
    taskActions.set(task.taskId, { task, receipts: [] });
  }
  for (const receipt of envelope.deliveries) {
    if (!mine(receipt) || receipt.action?.kind !== 'task' || receipt.outOfReach) continue;
    if (receipt.actionState === 'settled') {
      // Domain state ended or reassigned this work. No model execution is needed.
      handledSoFar.add(deliveryHandlingId(receipt));
      continue;
    }
    if (receipt.executionBlocked || receipt.actionState !== 'ready') continue;
    const id = receipt.action.id;
    const existing = taskActions.get(id);
    const task: InboxTaskRef = {
      taskId: id, agreementId: receipt.agreementId,
      title: existing?.task.title ?? id, state: 'active',
      updatedAt: receipt.actionVersion ?? null,
      executionContext: receipt.executionContext,
    };
    if (!existing) taskActions.set(id, { task, receipts: [receipt] });
    else {
      existing.receipts.push(receipt);
      // Prefer the freshest owner snapshot, not the event's source timestamp.
      if ((task.updatedAt ?? '') >= (existing.task.updatedAt ?? '')) existing.task = task;
    }
  }
  for (const { task, receipts } of taskActions.values()) {
    if (task.executionBlocked) continue;
    // One wake per task at a time. While it runs, the task and its receipts
    // stay listed; they are taken up again once it has finished.
    const runKey = `task:${task.taskId}`;
    if (dispatch.has(runKey)) { alreadyRunning++; continue; }
    const key = `task:${task.taskId}:${task.updatedAt ?? ''}:${task.executionContext?.contextId ?? ''}`;
    const receiptKeys = receipts.map(receipt => `task-receipt:${deliveryHandlingId(receipt)}`);
    // A timestamp is not a causal sequence: a new input can share its owner's
    // version with an earlier handoff. Only suppress receipts actually handled.
    if (deps.seen.has(key) && receiptKeys.every(id => deps.seen.has(id))) {
      receipts.forEach(receipt => handledSoFar.add(deliveryHandlingId(receipt)));
      continue;
    }
    if (!deps.onTask) continue; // Unsupported work stays pending; delivery is not completion.
    if (!(await roomForWake())) continue;
    startWake(runKey, async () => {
      const handled = await attempt(
        `task ${task.taskId}`,
        async () => {
          const executionContext = await prepareWorkExecution({ kind: 'task', id: task.taskId }, deps.creds.operatorKey, deps.ownAgentId, deps.baseUrl);
          return withWorkExecution(executionContext, () => deps.onTask!({ ...task, executionContext },
            receipts.map(receipt => ({ kind: receipt.kind, id: receipt.resourceId, eventId: receipt.eventId ?? receipt.receiptId! })),
          ));
        },
      );
      if (handled) {
        deps.seen.mark(key);
        receiptKeys.forEach(id => deps.seen.mark(id));
        tasksDelivered++;
        receipts.forEach(receipt => handledSoFar.add(deliveryHandlingId(receipt)));
      }
      await ackWhatIsFinished();
      return handled;
    });
  }
  if (!detached) await dispatch.idle();
  await ackWhatIsFinished();
  if (envelope.truncatedTasks) {
    warn(
      label,
      `inbox truncatedTasks=${envelope.truncatedTasks} (more assigned tasks than one pass surfaces — they appear as earlier ones close)`,
    );
  }

  // request channel. Triage is the host's job (exact string compare);
  // a miss must still count as handled so the watermark can advance with 0 tokens.
  for (const request of envelope.openRequestsAwaitingMe ?? []) {
    const key = `request:${request.agreementId}:${request.ts}`;
    if (deps.seen.has(key)) {
      handledSoFar.add(request.receiptId);
      continue;
    }
    deps.seen.mark(key);
    if (deps.onRequest) {
      const handled = await attempt(
        `request ${request.agreementId}`,
        () => deps.onRequest!(request),
        () => deps.seen.unmark(key),
      );
      if (handled) {
        requestsTriaged++;
        handledSoFar.add(request.receiptId);
      }
    } else {
      // No handler → still count as handled (ack) so an old host cannot wedge
      // forever on request mail it does not understand.
      requestsTriaged++;
      handledSoFar.add(request.receiptId);
    }
  }

  // Pending decisions are standing state, not deliveries: they keep appearing
  // until answered, so dedup them the same way tasks are deduped.
  for (const proposal of envelope.proposalsAwaitingMe) {
    if (proposal.executionBlocked) continue;
    // A proposal may be visible because this agent shares the accountable
    // principal's mailbox. Only the role-designated side actor wakes; ambient
    // sibling proposals remain available as context without creating a lane.
    if (!proposalIsMine(proposal, deps.ownAgentId)) continue;
    const key = `proposal:${proposal.agreementId}${proposal.executionContext ? ':' + proposal.executionContext.contextId : ''}`;
    if (deps.seen.has(key)) continue;
    deps.seen.mark(key);
    const handled = await attempt(
      `pending proposal ${proposal.agreementId}`,
      async () => {
        const executionContext = await prepareWorkExecution({ kind: 'agreement', id: proposal.agreementId }, deps.creds.operatorKey, deps.ownAgentId, deps.baseUrl);
        return deps.onResourceEvent({
          kind: 'agreement',
          ts: proposal.proposedAt ?? new Date().toISOString(),
          resourceId: proposal.agreementId,
          agreementId: proposal.agreementId,
          change: 'created',
          reason: 'proposal_pending',
          executionContext,
        });
      },
      () => deps.seen.unmark(key),
    );
    if (handled) resourceEvents++;
  }

  // Act, then ack: everything above has been handed to the host, so the
  // watermark may now move past it. A crash before this point redelivers.
  //
  // Advance only after every assigned id has an explicit disposition.
  // Repeated failures never turn unread mail into an acknowledged delivery.
  // One function, shared with the MCP inbox tool — do not restate the list
  // or the allow-gate here.
  let acked = acknowledged.size > 0;
  const ack = planInboxAck(envelope, {
    ownAgentId: deps.ownAgentId,
    failures,
    forceAck: false,
  });
  if (ack.allowed && ack.handledDeliveryIds.every(id => handledSoFar.has(id))) {
    const remaining = ack.handledDeliveryIds.filter(id => !acknowledged.has(id));
    if (remaining.length || !acked) noteRefused(await inbox.ack(envelope.ackTo!, { handledDeliveryIds: remaining }));
    acked = true;
    log(label, `acked up to ${envelope.ackTo}`);
  } else if (envelope.ackTo && !failures && (runningHere || alreadyRunning || deferred)) {
    // Nothing failed: those rows are still running, or wait for a slot. Each
    // running wake acknowledges its own row when it finishes.
    log(label, `${runningHere + alreadyRunning} assigned wake(s) still running, ${deferred} waiting for a slot; each is acknowledged when it finishes`);
  } else if (envelope.ackTo) {
    warn(
      label,
      `holding the watermark at ${envelope.ackTo} — ${failures} handover(s) failed this pass, so the ` +
        'window will be redelivered',
    );
  }

  return {
    ...(envelope.bellAt ? { bellAt: envelope.bellAt } : {}),
    deliveries: envelope.deliveries.length,
    messagesDelivered,
    resourceEvents,
    tasksDelivered,
    requestsTriaged,
    acked,
    truncated: envelope.deliveriesCapped,
    failures,
    blocked,
    dispatched,
    alreadyRunning,
    deferred,
  };
}

export interface InboxLoopHandle {
  /**
   * Stop reading. An idle long-poll is cancelled at once; a pass and the
   * wakes already handed to the host run on so they can acknowledge what they
   * finished, and the host lease is released after that. Work still running
   * when `timeoutMs` is up does not hold the lease: it is released anyway, and
   * the next host is handed whatever was not acknowledged. Resolves `true`
   * when everything finished inside the bound, `false` when the lease was
   * released out from under it.
   */
  stop(timeoutMs?: number): Promise<boolean>;
  /** True while the loop is running. */
  readonly running: boolean;
  /**
   * When this loop last completed a pass against the server — the one true
   * liveness signal for an agent, and the same fact the store shows as online.
   * Null until the first pass returns.
   */
  readonly lastPassAt: number | null;
  /**
   * When this loop last STARTED an iteration, successful or not. Separate from
   * `lastPassAt` on purpose: a backend outage stops passes while the loop is
   * perfectly healthy, so a restart decision reads this one and a staleness
   * report reads the other. `running` says the loop exists; this says it turns.
   */
  readonly lastAttemptAt: number | null;
}

/**
 * Default long-poll hold for hosted agents. Matches the server's own ceiling,
 * and assumes a proxy idle timeout comfortably above it rather than the 25s
 * some defaults ship with. Lower it if your deployment sits behind a shorter one.
 */
const DEFAULT_WAIT_SECONDS = 110;
/** The shortest gap between two reads that found nothing new. */
const IDLE_REREAD_MS = 1_000;
const ERROR_BACKOFF_BASE_MS = 1_000;
const ERROR_BACKOFF_MAX_MS = 30_000;

/**
 * Whether a pass changed anything. One that only found rows already running
 * (or waiting for a slot) did not, and reading again at once would find them
 * again: the server lists a row until its wake has handled it.
 */
export function passMadeProgress(
  pass: Pick<InboxPassResult, 'dispatched' | 'messagesDelivered' | 'resourceEvents' | 'tasksDelivered' | 'requestsTriaged'>,
): boolean {
  return pass.dispatched + pass.messagesDelivered + pass.resourceEvents + pass.tasksDelivered + pass.requestsTriaged > 0;
}

/** Count held windows so retries can back off without discarding mail. */
export function heldPassAfter(
  prev: number,
  pass: Pick<InboxPassResult, 'acked' | 'failures' | 'truncated'>,
): number {
  return pass.failures > 0 || (!pass.acked && pass.truncated) ? prev + 1 : 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal?.aborted) finish();
    else signal?.addEventListener('abort', finish, { once: true });
  });
}

/** How long `stop()` waits for a pass in flight before releasing the lease anyway. */
export const INBOX_STOP_TIMEOUT_MS = 30_000;

/** Resolves `true` when `promise` settles within `ms`, `false` otherwise. The timer never outlives the answer. */
function withinMs(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, ms));
    promise.then(() => true, () => true).then((settled) => {
      clearTimeout(timer);
      resolve(settled);
    });
  });
}

/**
 * Run {@link pollInboxOnce} forever (until stopped). Each iteration long-polls
 * for `waitSeconds`; a passing envelope returns instantly, an empty one holds.
 * Errors retry with exponential backoff + jitter and never exit the loop —
 * there is nothing to resynchronize (the watermark is server-side), so recovery
 * is just the next iteration.
 *
 * Wakes do not hold the loop: a pass starts its wakes (up to the agent's
 * bound) and the loop reads again, so a new thread is taken up while another
 * is still being answered. The server lists a row until it is handled, so
 * while wakes run the loop passes back the envelope's `bellAt` as `seen`: the
 * held read then answers only mail delivered after it, and a message from
 * someone else is taken up as soon as it arrives.
 *
 * The FIRST pass is an immediate read. A held poll only answers to new mail, so
 * a host that just started (or restarted after a crash) would otherwise sit
 * waiting while the work it was already assigned — open tasks, pending
 * decisions — went unseen until something unrelated arrived.
 */
export function runInboxLoop(
  deps: InboxLoopDeps,
  opts: { waitSeconds?: number } = {},
): InboxLoopHandle {
  const label = deps.label ?? 'inboxLoop';
  const waitSeconds = opts.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  const dispatch = new InboxDispatch(deps.concurrency);
  // The delivery the last read answered. Passed back while wakes run, so the
  // next held read waits for new mail; never after a failed pass, whose rows
  // must come back on the retry.
  let seen: string | undefined;
  let running = true;
  let consecutiveErrors = 0;
  let heldPasses = 0;
  let lastPassAt: number | null = null;
  let lastAttemptAt: number | null = null;

  let first = true;
  const shutdown = new AbortController();
  // One DELETE, whichever gets there first: the loop's own exit, or a stop
  // that ran out of patience with the pass in flight.
  let released: Promise<void> | null = null;
  const releaseOnce = (): Promise<void> => (released ??= releaseInboxHostBestEffort(deps));

  const main = (async () => {
    while (running) {
      try {
        lastAttemptAt = Date.now();
        const pass = await pollInboxOnce(deps, first ? 0 : waitSeconds, {
          signal: shutdown.signal,
          dispatch,
          ...(seen && dispatch.size > 0 && !heldPasses ? { seen } : {}),
        });
        if (pass.bellAt) seen = pass.bellAt;
        lastPassAt = Date.now();
        first = false;
        consecutiveErrors = 0;
        // A wake that failed after its pass returned still backs the loop off.
        heldPasses = heldPassAfter(heldPasses, { ...pass, failures: pass.failures + dispatch.takeFailures() });
        if (heldPasses) await sleep(Math.min(ERROR_BACKOFF_MAX_MS,
          ERROR_BACKOFF_BASE_MS * 2 ** Math.min(heldPasses - 1, 5)), shutdown.signal);
        else if (dispatch.size > 0 && !passMadeProgress(pass))
          await dispatch.settledOr(IDLE_REREAD_MS, shutdown.signal);
      } catch (err) {
        if (!running) break;
        consecutiveErrors++;
        // a 429 already told us how long to wait, and every refused
        // call still counts against the cap — so the exponential ladder digs
        // the hole deeper (1s, 2s, 4s… of pure refusals). Wait the server's
        // number instead, and do not let a throttle inflate the ladder for the
        // real errors that come after it.
        const throttleMs = isRateLimited(err) ? (err.retryAfterMs ?? 30_000) : null;
        if (throttleMs !== null) {
          consecutiveErrors = 0;
          warn(label, `inbox loop throttled: ${(err as Error)?.message ?? err} — waiting ${Math.round(throttleMs)}ms as instructed`);
          await sleep(throttleMs, shutdown.signal);
          continue;
        }
        const backoff = Math.min(
          ERROR_BACKOFF_MAX_MS,
          ERROR_BACKOFF_BASE_MS * 2 ** (consecutiveErrors - 1),
        );
        const jitter = backoff * (0.5 + (consecutiveErrors % 7) / 14); // deterministic-ish, no Math.random
        warn(label, `inbox loop pass failed (#${consecutiveErrors}): ${(err as Error)?.message ?? err} — retrying in ~${Math.round(jitter)}ms`);
        await sleep(jitter, shutdown.signal);
      }
    }
  })();

  // The lease is released once the loop has stopped and every wake it started
  // has finished and acknowledged (or `stop` ran out of patience).
  const done = main.then(() => dispatch.idle()).finally(releaseOnce);

  return {
    get running() {
      return running;
    },
    get lastPassAt() {
      return lastPassAt;
    },
    get lastAttemptAt() {
      return lastAttemptAt;
    },
    async stop(timeoutMs = INBOX_STOP_TIMEOUT_MS) {
      running = false;
      // Cancel an idle long-poll; a pass already handed to the host keeps
      // going so it can acknowledge what it finished before the lease goes.
      shutdown.abort();
      const finished = await withinMs(done, timeoutMs);
      if (!finished) {
        warn(
          label,
          `inbox pass still running after ${timeoutMs}ms — releasing the host lease now; what it has not acknowledged is redelivered to the next host`,
        );
        await releaseOnce();
      }
      return finished;
    },
  };
}
