import { deliveryHandlingId, withWorkExecution } from '@ziggs-ai/api-client';
import {
  ContextReadClient,
  InboxClient,
  planInboxAck,
  planPartialInboxAck,
  type InboxChatNews,
  type InboxDeliveryRef,
  type InboxRequestRef,
  type InboxTaskRef,
  type Creds,
} from '@ziggs-ai/api-client';
import { SeenMessages } from './SeenMessages.js';
import { runtimeLog } from '../shared/runtimeLog.js';
import { isRateLimited } from '@ziggs-ai/api-client';
import { isPublishProbeChat } from '../probeChat.js';

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
  onTask?: (task: InboxTaskRef) => Promise<void>;
  /**
   * A marketplace request doorbell. The host MUST triage with a plain
   * string compare and return without an LLM wake on miss — otherwise every
   * public request burns a full Claude turn per published supplier.
   */
  onRequest?: (request: InboxRequestRef) => Promise<void>;
  label?: string;
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
  /**
   * Handovers into the host that failed this pass. Non-zero means the
   * watermark was deliberately held, so the same window arrives again.
   */
  failures: number;
}

type WireRow = Record<string, unknown>;

const READ_PAGE = 100;

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
 * A capability probe waits on a `probe_*` chat reply, not inbox ack. Act
 * those rooms before leftover mail so a standing host answers the gate
 * even when the envelope also carries older chats. The prefix only orders
 * the wake — it does not buy a canned answer.
 */
export function chatsInWakeOrder(chats: InboxChatNews[]): InboxChatNews[] {
  return [...chats].sort((a, b) => {
    const ap = isPublishProbeChat(a.chatId) ? 0 : 1;
    const bp = isPublishProbeChat(b.chatId) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.latestAt < b.latestAt ? 1 : -1;
  });
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

/**
 * Read the messages behind one chat's deliveries and hand them to the host.
 *
 * The envelope names exact assigned message ids, not their bodies — so this still
 * reads through `/context/read`, where the agent's own grants fence what it is
 * allowed to see. A delivery reference is an address, never an authorisation.
 */
async function deliverMessagesForChat(
  deps: InboxLoopDeps,
  news: InboxChatNews,
  refs: readonly InboxDeliveryRef[],
  reader: ContextReadClient,
  attempt: (what: string, handover: () => Promise<void>) => Promise<boolean>,
  handledIds: Set<string>,
): Promise<number> {
  const pending = new Map(refs.map(ref => [ref.resourceId, ref]));
  for (const id of pending.keys()) {
    if (deps.seen.has(deliveryHandlingId(pending.get(id)!))) { handledIds.add(deliveryHandlingId(pending.get(id)!)); pending.delete(id); }
  }
  if (!pending.size) return 0;
  let delivered = 0;
  const earliest = refs.map(ref => ref.ts).sort()[0]!;
  let after = new Date(Date.parse(earliest) - 1).toISOString();
  let cursor: string | undefined;
  for (let pages = 0; pending.size && pages < 100; pages++) {
    let page;
    try {
      page = await reader.read<WireRow>('messages', {
        via: `chat:${news.chatId}`, after, direction: 'forward', limit: READ_PAGE,
        ...(cursor ? { cursor } : {}),
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 403 && status !== 404) throw err;
      // This read explicitly establishes that these deliveries are inaccessible.
      // The server also excludes out-of-reach rows from its acknowledgment guard.
      // A context refusal (including changed audience) must be retried, never acknowledged as read.
      if (refs.some(ref => ref.executionContext)) throw err;
      for (const id of pending.keys()) handledIds.add(id);
      return delivered;
    }
    for (const row of page.items) {
      const id = String(row.messageId ?? '');
      const ref = pending.get(id);
      if (!ref) continue;
      const handled = await attempt(`chat ${news.chatId} message ${id}`, () =>
        deps.onMessage(typeof row.text === 'string' ? row.text : '', {
          ...row,
          chatId: news.chatId,
          // Preserve the message's addressee. Assignment separately authorizes
          // this carrier to handle it, including a person's stand-in.
          assigneeId: deps.ownAgentId,
          ...(ref.responsibilityId ? { responsibilityId: ref.responsibilityId, executionContext: ref.executionContext } : {}),
          ...(ref.agreementId ? { agreementId: ref.agreementId } : {}),
        }),
      );
      if (handled) { delivered++; handledIds.add(deliveryHandlingId(ref)); }
      pending.delete(id);
    }
    if (!page.hasMore) break;
    if (page.nextCursor && page.nextCursor !== cursor) cursor = page.nextCursor;
    else if (page.latestSequence && page.latestSequence > after) {
      after = page.latestSequence; cursor = undefined;
    } else break;
  }
  if (pending.size) await attempt(`chat ${news.chatId} missing assigned messages`, async () => {
    throw new Error(`Assigned message(s) not read: ${[...pending.keys()].join(', ')}`);
  });
  return delivered;
}

/**
 * One long-poll pass: hold up to `waitSeconds` for new inbox content, then read
 * the deltas, deliver them into the host, and ack. Returns what it delivered.
 * Reused each iteration of {@link runInboxLoop}; also usable as a single catch-up
 * read (`waitSeconds: 0`) at bootstrap.
 */
export async function pollInboxOnce(
  deps: InboxLoopDeps,
  waitSeconds = 0,
  opts: { forceAck?: boolean; signal?: AbortSignal } = {},
): Promise<InboxPassResult> {
  const label = deps.label ?? 'inboxLoop';
  const inbox = inboxClient(deps);

  const envelope = await inbox.getInbox({
    ...(waitSeconds > 0 ? { waitSeconds } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  // A response may race shutdown. Do not enqueue another wake after stopping;
  // an already-running pass keeps its lease through its final acknowledgement.
  opts.signal?.throwIfAborted();

  let messagesDelivered = 0;
  let resourceEvents = 0;
  let tasksDelivered = 0;
  let requestsTriaged = 0;
  let failures = 0;

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
  const mine = (d: { assigneeId?: string | null }) =>
    d.assigneeId === deps.ownAgentId;

  // Give the mark back in steps instead of once at the end of the pass.
  //
  // A pass that acks only when it finishes freezes the watermark for its whole
  // length, and the server hands an unanswered row to the person's stand-in
  // after 90s. Measured, a single turn is ~19s but an uninterrupted stretch is
  // ~86s median, so the pass — not the turn — is what crosses the window. Each
  // row now carries a token for its own position; `planPartialInboxAck` says
  // how far those tokens can safely be taken given what is finished.
  //
  // A mark is global, so it can only be released in timestamp order, while
  // chats are worked newest-first. One chat in the pass — the ordinary case,
  // and the one the window actually bites — releases as soon as it is done.
  // Several, and the oldest is worked last, so the release waits for it: no
  // worse than acking at the end, which is what this replaced.
  failures += envelope.deliveries.filter(d => mine(d) && d.executionBlocked).length
    + (envelope.tasksAwaitingMe ?? []).filter(t => t.executionBlocked).length
    + envelope.proposalsAwaitingMe.filter(p => p.assignedAgentId === deps.ownAgentId && p.executionBlocked).length;
  const handledSoFar = new Set<string>();
  const acknowledged = new Set<string>();
  const ackWhatIsFinished = async (): Promise<void> => {
    const step = planPartialInboxAck(envelope, handledSoFar, {
      ownAgentId: deps.ownAgentId,
      failures,
    });
    if (!step) return;
    step.handledDeliveryIds = step.handledDeliveryIds.filter(id => !acknowledged.has(id));
    if (!step.handledDeliveryIds.length) return;
    try {
      await inbox.ack(step.ackTo, { handledDeliveryIds: step.handledDeliveryIds });
      step.handledDeliveryIds.forEach(id => acknowledged.add(id));
      log(label, `acked up to ${step.ackTo} (mid-pass)`);
    } catch (err) {
      // Never fatal: the end-of-pass ack is still coming, and the watermark is
      // monotonic, so a lost step costs nothing but the exposure it would have
      // closed.
      warn(label, `mid-pass ack did not land: ${(err as Error)?.message ?? err}`);
    }
  };

  const assignedByChat = new Map<string, InboxDeliveryRef[]>();
  for (const d of envelope.deliveries) {
    if (d.kind !== 'message' || !d.chatId || !mine(d) || d.outOfReach || d.executionBlocked) continue;
    const groupId = d.executionContext?.contextId ?? d.chatId;
    const rows = assignedByChat.get(groupId) ?? [];
    rows.push(d);
    assignedByChat.set(groupId, rows);
  }
  const chats = [...assignedByChat].map(([chatId, refs]) => ({
    chatId, count: refs.length, latestAt: refs.map(ref => ref.ts).sort().at(-1)!,
  }));
  for (const group of chatsInWakeOrder(chats)) {
    const refs = assignedByChat.get(group.chatId)!;
    const news = { ...group, chatId: refs[0]!.chatId! };
    // Read a room's mail as that room's wake would: with the room as the lane.
    // Without it the read is judged in the workspace the key signed in to, and
    // a room another company opened with a listed agent is filed in theirs, so
    // every stranger's message came back 403 and was acked unread.
    const roomReader = new ContextReadClient(deps.creds.operatorKey, deps.creds.agentId, deps.baseUrl);
    const n = await withWorkExecution(refs[0]?.executionContext, () => deliverMessagesForChat(deps, news,
      refs, roomReader, attempt, handledSoFar));
    messagesDelivered += n;
    await ackWhatIsFinished();
  }

  // Everything that is not chat text is handed over as a resource event, from
  // the delivery itself — the reference already carries the ids the host needs,
  // so nothing has to be re-derived to name what changed.
  // Requests must never take this path — even if a pre-cut server
  // left them in `deliveries`, skip so they cannot wake the LLM before triage.
  // Unassigned rows never take it either: waking the brain on a sibling's
  // mail is the N-wakes-per-event cost the party-owned inbox exists to kill.
  for (const d of envelope.deliveries) {
    if (d.kind === 'message' || d.kind === 'request') continue;
    if (!mine(d) || d.executionBlocked || d.outOfReach) continue;
    const key = d.responsibilityId ?? `delivery:${d.kind}:${d.resourceId}:${d.ts}`;
    // Handled on an earlier pass — it still settles this instant, exactly as
    // it does in the end-of-pass list.
    if (deps.seen.has(key)) {
      handledSoFar.add(deliveryHandlingId(d));
      continue;
    }
    deps.seen.mark(key);
    const handled = await attempt(
      `${d.kind} ${d.resourceId}`,
      () =>
        deps.onResourceEvent({
          kind: d.kind,
          ts: d.ts,
          resourceId: d.resourceId,
          ...(d.responsibilityId ? { responsibilityId: d.responsibilityId, executionContext: d.executionContext } : {}),
          ...(d.chatId ? { chatId: d.chatId } : {}),
          ...(d.agreementId ? { agreementId: d.agreementId } : {}),
          ...(d.taskId ? { taskId: d.taskId } : {}),
          // claim/listing wakes carry reason + claimer; host needs
          // both for agrn lane routing, claim kickoff, and chat_open buyer id.
          ...(d.reason != null && d.reason !== '' ? { reason: d.reason } : {}),
          ...(d.actorId ? { actorId: d.actorId } : {}),
          change: 'created',
        }),
      () => deps.seen.unmark(key),
    );
    if (handled) {
      resourceEvents++;
      handledSoFar.add(deliveryHandlingId(d));
    }
  }
  // An older row here may have been holding the mark back behind the chats.
  await ackWhatIsFinished();

  // the work channel. An open assigned task is redelivered on every
  // pass until it closes (that IS the durable-wait contract), so dedup on
  // taskId+updatedAt — a genuinely touched task wakes again, an untouched one
  // doesn't storm the lane every long-poll.
  for (const task of envelope.tasksAwaitingMe ?? []) {
    if (task.executionBlocked) continue;
    const key = `task:${task.taskId}:${task.updatedAt ?? ''}:${task.executionContext?.contextId ?? ''}`;
    if (deps.seen.has(key)) continue;
    deps.seen.mark(key);
    if (deps.onTask) {
      const handled = await attempt(
        `task ${task.taskId}`,
        () => withWorkExecution(task.executionContext, () => deps.onTask!(task)),
        () => deps.seen.unmark(key),
      );
      if (handled) tasksDelivered++;
    }
  }
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
      handledSoFar.add(request.responsibilityId);
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
        handledSoFar.add(request.responsibilityId);
      }
    } else {
      // No handler → still count as handled (ack) so an old host cannot wedge
      // forever on request mail it does not understand.
      requestsTriaged++;
      handledSoFar.add(request.responsibilityId);
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
      () =>
        deps.onResourceEvent({
          kind: 'agreement',
          ts: proposal.proposedAt ?? new Date().toISOString(),
          resourceId: proposal.agreementId,
          agreementId: proposal.agreementId,
          change: 'created',
          reason: 'proposal_pending',
          ...(proposal.executionContext ? { executionContext: proposal.executionContext } : {}),
        }),
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
    if (remaining.length || !acked) await inbox.ack(envelope.ackTo!, { handledDeliveryIds: remaining });
    acked = true;
    log(label, `acked up to ${envelope.ackTo}`);
  } else if (envelope.ackTo) {
    warn(
      label,
      `holding the watermark at ${envelope.ackTo} — ${failures} handover(s) failed this pass, so the ` +
        'window will be redelivered',
    );
  }

  return {
    deliveries: envelope.deliveries.length,
    messagesDelivered,
    resourceEvents,
    tasksDelivered,
    requestsTriaged,
    acked,
    truncated: envelope.deliveriesCapped,
    failures,
  };
}

export interface InboxLoopHandle {
  /**
   * Stop reading. An idle long-poll is cancelled at once; a pass already
   * handed to the host runs on so it can acknowledge what it finished, and
   * the host lease is released after that. A pass still running when
   * `timeoutMs` is up does not hold the lease: it is released anyway, and the
   * next host is handed whatever was not acknowledged. Resolves `true` when
   * the pass finished inside the bound, `false` when the lease was released
   * out from under it.
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
const ERROR_BACKOFF_BASE_MS = 1_000;
const ERROR_BACKOFF_MAX_MS = 30_000;

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
        const pass = await pollInboxOnce(deps, first ? 0 : waitSeconds, { signal: shutdown.signal });
        lastPassAt = Date.now();
        first = false;
        consecutiveErrors = 0;
        heldPasses = heldPassAfter(heldPasses, pass);
        if (heldPasses) await sleep(Math.min(ERROR_BACKOFF_MAX_MS,
          ERROR_BACKOFF_BASE_MS * 2 ** Math.min(heldPasses - 1, 5)), shutdown.signal);
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

  const done = main.finally(releaseOnce);

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
