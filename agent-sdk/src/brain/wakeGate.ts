import { buildOperatorHeaders, getBackendUrl } from '@ziggs-ai/api-client';
import { getBatchEvents } from '../context/batch.js';
import type { RawEvent } from '../runtime/buildOutcome.js';
import { runtimeLog } from '../shared/runtimeLog.js';

/**
 * The wake gate: ask the backend whether chat messages need a
 * model turn before the Claude brain starts one.
 *
 * The backend asks Jev (TypeSafe's System One model) one Choice — "asks this
 * agent to act now" or "context to read later" — and answers `wake: false`
 * only on a confident "context". The key lives there, not here: hosts run on
 * customers' machines.
 */

export interface WakeGateMessage {
  text: string;
  senderId?: string;
}

export interface WakeGateRequest {
  messages: WakeGateMessage[];
  agreementId?: string;
  chatId?: string;
}

export interface WakeGateAnswer {
  wake: boolean;
  /** `act` | `context` | `unsure` | `off`, as the backend decided. */
  how?: string;
  confidence?: number;
}

/** Null means "no answer": the caller wakes as it always has. */
export type AskWakeGate = (req: WakeGateRequest) => Promise<WakeGateAnswer | null>;

/** Longer than Jev's own 4s budget on the server, shorter than a turn is worth waiting for. */
const TIMEOUT_MS = 6000;

/**
 * The messages this wake may ask about, or null when it may not ask at all.
 *
 * Only a wake made entirely of chat speech with text is asked about. Anything
 * else in the batch — a task result, an agreement lifecycle event, a notice —
 * wakes as today, decided here in code before Jev is involved: an assigned
 * task, a control request (pause, stop) and a proposal naming this agent must
 * never be skipped, and none of them is a `message`.
 */
export function gateableMessages(event: RawEvent | undefined): WakeGateMessage[] | null {
  const events = getBatchEvents(event) as RawEvent[];
  if (events.length === 0) return null;
  const out: WakeGateMessage[] = [];
  for (const ev of events) {
    if (!ev || ev.type !== 'message') return null;
    const text = typeof ev.text === 'string' ? ev.text.trim() : '';
    if (!text) return null;
    out.push({
      text,
      ...(typeof ev.senderId === 'string' && ev.senderId ? { senderId: ev.senderId } : {}),
    });
  }
  return out;
}

/** The agreement the wake names, for the cost record. First one wins. */
export function wakeAgreementId(event: RawEvent | undefined): string | undefined {
  for (const ev of getBatchEvents(event) as RawEvent[]) {
    const id = ev?.agreementId;
    if (typeof id === 'string' && id) return id;
  }
  return undefined;
}

/**
 * The default gate: `POST /internal/wake-gate` with the agent's operator key.
 * Any failure — network, timeout, a refusal, a body without `wake` — is null,
 * so a backend that predates the route costs one 404 and changes nothing.
 */
export function backendWakeGate(creds: { operatorKey: string; agentId: string }): AskWakeGate {
  return async (req) => {
    if (!creds.operatorKey) return null;
    try {
      const res = await fetch(`${getBackendUrl()}/internal/wake-gate`, {
        method: 'POST',
        headers: {
          ...buildOperatorHeaders(creds.operatorKey, creds.agentId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        runtimeLog.warn('wakeGate', `wake gate answered ${res.status} — waking as usual`);
        return null;
      }
      const data = (await res.json().catch(() => null)) as WakeGateAnswer | null;
      if (!data || typeof data.wake !== 'boolean') return null;
      return data;
    } catch (err) {
      runtimeLog.warn('wakeGate', `wake gate unreachable (${(err as Error)?.name ?? 'error'}) — waking as usual`);
      return null;
    }
  };
}
