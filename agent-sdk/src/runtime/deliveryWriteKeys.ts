import { createHash } from 'node:crypto';
import type { DeliveryWriteKeys } from '../types.js';
import { getBatchEvents } from '../context/batch.js';

/**
 * Deterministic idempotency keys for hosted-agent writes (delivery law, item 2).
 *
 * A crash between acting and acking redelivers the SAME wake event; the agent
 * re-thinks and re-writes. The backend drops duplicate artifact writes and
 * no-ops duplicate task transitions — but only when the replayed wake derives
 * the SAME key. So keys are a pure function of durable wake inputs (laneKey +
 * the triggering event's delivery identity + a per-wake write ordinal). They
 * are never LLM-supplied and never random: asking the model to invent a key
 * makes replay-stability a matter of sampling temperature.
 *
 * One instance is created per wake (tick) and threaded to every write the wake
 * performs — a second instance created for the same (laneKey, event), as a
 * crash-replay does, reproduces the same key sequence.
 */

/**
 * Durable identity of the event that triggered this wake, or null when it has
 * none. Null means the wake is not a redelivery candidate (timer and other
 * host-synthesized frames fire fresh each time), so its writes carry no key —
 * a derived-anyway key could only collide across genuinely distinct wakes and
 * silently swallow their writes, which is worse than the duplicate it prevents.
 */
function eventIdentity(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as Record<string, unknown>;

  if (e.type === 'batch') {
    // EventQueue coalesces queued events into one frame. Identify the batch by
    // its identifiable members (sorted — arrival order is not replay-stable).
    // Members without identity are ignored rather than nulling the whole batch:
    // an identified member can only recur via redelivery, which is exactly when
    // matching keys are wanted.
    const parts = getBatchEvents(event)
      .map(eventIdentity)
      .filter((p): p is string => p !== null)
      .sort();
    return parts.length > 0 ? parts.join('|') : null;
  }

  // Per-delivery id stamped by the backend on chat rows — present on live
  // pushes and on catch-up redelivery alike, and the most precise identity.
  if (typeof e.messageId === 'string' && e.messageId) return `msg:${e.messageId}`;

  if (e.type === 'task_result') {
    // Host-synthesized task frames (bootstrap of already-assigned tasks) carry
    // no messageId; the task snapshot itself is the identity. Re-bootstrapping
    // the same task in the same state IS re-processing, so the collision this
    // produces is the dedup we want.
    const result = (e.result ?? {}) as Record<string, unknown>;
    const taskId = typeof result.taskId === 'string' ? result.taskId : null;
    if (!taskId) return null;
    const state = typeof result.state === 'string' ? result.state : '';
    const operation = typeof result._operation === 'string' ? result._operation : '';
    return `task:${taskId}:${state}:${operation}`;
  }

  if (e.type === 'agreement_lifecycle') {
    const agreementId = typeof e.agreementId === 'string' ? e.agreementId : null;
    if (!agreementId) return null;
    return `agr:${agreementId}:${typeof e.operation === 'string' ? e.operation : ''}`;
  }

  // state-timeout, resource_changed, and anything else: no per-delivery id on
  // the wire, and never redelivered by catch-up — keyless by design.
  return null;
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Build the per-wake key derivation. Call once per tick with the lane and the
 * raw triggering event, then thread the instance to every write of the wake.
 *
 * Key shapes (all well under the backend's 128-char cap):
 * - artifacts:        `wk_<wake-hash>_a<ordinal>` — ordinal increments per
 *   artifact write, so a wake writing several breadcrumbs keys each one.
 * - task transitions: `wk_<wake-hash>_t_<hash(taskId, state)>` — derived from
 *   the transition itself, so it dedups regardless of the order in which the
 *   replayed wake happens to re-issue its tool calls.
 * - chat messages:    `sdk_idem_wk_<wake-hash>_m_<hash(chat, receiver, text)>`
 *   — used directly as the messageId (the backend dedups on (chatId, messageId),
 *). Content-derived, not ordinal: a wake may emit several
 *   distinct messages without colliding, and a crash-replay that re-sends the
 *   same text reuses the key; a re-think with different text gets a new key
 *   instead of 409-dropping on the old ordinal slot. The prefix matches the
 *   tool-layer convention for deterministic ids (`sdk_idem_<llm-key>`).
 * - task spawns:      `wk_<wake-hash>_s_<hash(agreement, description, …)>` —
 *   derived from what the spawn writes, so it dedups regardless of re-issue
 *   order while still distinguishing multiple spawns in one wake.
 * - agreement create: `wk_<wake-hash>_ap_<hash(…)>` (propose) and
 *   `wk_<wake-hash>_asc_<hash(…)>` (subcontract) — same content-derived scheme
 *   as task spawns; the backend dedups on (creator, key) so a replayed
 *   propose/subcontract resolves to the original agreement.
 */
export function createDeliveryWriteKeys(laneKey: string, event: unknown): DeliveryWriteKeys {
  const identity = eventIdentity(event);
  const wakeHash = identity === null ? null : sha(`${laneKey}\n${identity}`).slice(0, 40);
  let ordinal = 0;

  // one content-hash builder; tags differ, the shape does not.
  const keyed = (
    tag: string,
    material: string,
    opts?: { asMessageId?: boolean },
  ): string | undefined => {
    if (wakeHash === null) return undefined;
    const body = `wk_${wakeHash}_${tag}_${sha(material).slice(0, 16)}`;
    return opts?.asMessageId ? `sdk_idem_${body}` : body;
  };

  return {
    wakeKey: wakeHash === null ? null : `wk_${wakeHash}`,
    artifactKey(content?: unknown): string | undefined {
      if (wakeHash === null) return undefined;
      // Content-derived for the same reason messageKey is: the
      // ordinal restarts at a0 on every wake, so a redelivered event whose
      // re-think writes different artifacts collided with the first wake's
      // and the backend discarded the new write. Harmless for a breadcrumb,
      // not for a result artifact — which is the whole deliverable of an
      // agent like agent-definer. Callers without content keep the ordinal.
      if (content === undefined) return `wk_${wakeHash}_a${ordinal++}`;
      const material =
        typeof content === 'string' ? content : JSON.stringify(content) ?? '';
      return keyed('a', material);
    },
    taskStateKey(taskId: string, state: string): string | undefined {
      return keyed('t', `${taskId}\n${state}`);
    },
    messageKey(fields): string | undefined {
      return keyed(
        'm',
        `${fields.sessionId ?? ''}\n${fields.receiverId ?? ''}\n${fields.text}`,
        { asMessageId: true },
      );
    },
    taskSpawnKey(fields): string | undefined {
      return keyed(
        's',
        `${fields.agreementId}\n${fields.description}\n${fields.assigneeId ?? ''}\n${fields.parentTaskId ?? ''}`,
      );
    },
    agreementProposeKey(fields): string | undefined {
      return keyed(
        'ap',
        `${fields.proposedTo}\n${fields.providerId ?? ''}\n${fields.description}\n${fields.parentAgreementId ?? ''}`,
      );
    },
    agreementSubcontractKey(fields): string | undefined {
      return keyed(
        'asc',
        `${fields.executorId}\n${fields.description}\n${fields.parentAgreementId}`,
      );
    },
  };
}
