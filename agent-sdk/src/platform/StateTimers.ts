import { runtimeLog } from '../shared/runtimeLog.js';
import type { WorkScope } from '../runtime/wakeEffects.js';

export interface StateTimeoutEvent {
  type: 'state-timeout';
  state: string;
  waitedMs: number;
  epoch: number;
}

/**
 * An agent asked to be woken at a time, and this is that wake.
 *
 * A separate frame type from `state-timeout` on purpose. `state-timeout` means
 * "the state you parked in has a liveness bound and it elapsed", it carries a
 * state name, and `validateWorkflow` reserves it so no turn can produce one. A
 * check-back is none of that: it belongs to the agent's own plan, not to a
 * state's declared timeout, and the Claude brain has no states at all.
 */
export interface WakeAtEvent extends WorkScope {
  type: 'wake-at';
  /** What the agent said it was waiting for. Free text, for the brain to read. */
  reason: string | null;
  /** When the wake was asked for, epoch ms. */
  scheduledFor: number;
  epoch: number;
}

export type TimerEvent = StateTimeoutEvent | WakeAtEvent;

interface ArmedTimer {
  epoch: number;
  /**
   * `liveness` — armed by the host from a parked state's `timeoutMs`.
   * `wake-at` — armed by the agent itself through the `wake_at` tool.
   *
   * Tracked because the two do not outrank each other equally; see `arm`.
   */
  kind: 'liveness' | 'wake-at';
  state: string;
  reason: string | null;
  timeoutMs: number;
  firesAt: number;
  armedAt: number;
  handle: ReturnType<typeof setTimeout>;
}

/**
 * `setTimeout` stores its delay in a signed 32-bit int. A longer delay does
 * not throw — it overflows and fires (almost) immediately, which for a
 * check-back means a reminder sent the moment it was scheduled a month out.
 * So a wake past this is refused rather than silently brought forward.
 */
export const MAX_WAKE_DELAY_MS = 2 ** 31 - 1;

/**
 * Per-lane liveness timers for parked states declaring timeoutMs. Owned by
 * Agent. A firing timer enqueues a state-timeout frame on the SAME lane
 * (caller-provided enqueue → EventQueue), so it serializes behind any real
 * event and can never race one. Epochs make stale frames identifiable: a
 * queued timeout frame whose epoch is not the lane's currently-armed epoch was
 * cancelled or replaced and must be dropped.
 *
 * The timers themselves live in memory. An agent's own `wake_at` is also
 * written to its memory notes (`WakeLedger`), and the host arms those again
 * when it starts; a host liveness timer is not, and re-arms on the lane's next
 * real event.
 */
export class StateTimers {
  private _timers = new Map<string, ArmedTimer>();
  private _epoch = 0;
  private _enqueue: (event: TimerEvent, laneKey: string) => void;

  constructor(enqueue: (event: TimerEvent, laneKey: string) => void) {
    this._enqueue = enqueue;
  }

  /**
   * Arm the host's liveness timer for a parked state.
   *
   * Re-arm is idempotent — any previously armed LIVENESS timer for the lane is
   * cancelled first. It does NOT replace an agent's own `wake_at`, and that
   * asymmetry is the point: `_armIfTimedParked` runs after every single tick,
   * so if the generic net won, an agent that called `wake_at` inside a timed
   * parked state would have its check-back silently thrown away on the way out
   * of the very tick that asked for it. Nothing is lost by deferring — the
   * wake-at still wakes the lane, and the parked state re-arms then.
   */
  arm(laneKey: string, state: string, timeoutMs: number): void {
    const pending = this._timers.get(laneKey);
    if (pending?.kind === 'wake-at') {
      runtimeLog.debug(
        'StateTimers',
        `keeping wake-at laneKey=${laneKey} firesAt=${new Date(pending.firesAt).toISOString()} over liveness timeout for state=${state}`,
      );
      return;
    }
    this.clear(laneKey);
    const epoch = ++this._epoch;
    const handle = setTimeout(() => {
      runtimeLog.debug('StateTimers', `fired laneKey=${laneKey} state=${state} waitedMs=${timeoutMs} epoch=${epoch}`);
      this._enqueue({ type: 'state-timeout', state, waitedMs: timeoutMs, epoch }, laneKey);
    }, timeoutMs);
    (handle as unknown as { unref?: () => void }).unref?.();
    this._timers.set(laneKey, {
      epoch,
      kind: 'liveness',
      state,
      reason: null,
      timeoutMs,
      firesAt: Date.now() + timeoutMs,
      armedAt: Date.now(),
      handle,
    });
  }

  /**
   * Wake this lane at a time, because the agent asked to be.
   *
   * One armed timer per lane, and this one replaces whatever is there: a
   * check-back rule is a series of single timers, not a schedule, so the agent
   * re-arms the next one when the last one fires. Re-arming before it fires is
   * the agent changing its mind, which is allowed and is why this replaces
   * rather than adds.
   *
   * The timer is in memory; the Agent saves what it needs to arm it again
   * after a restart. Returns what actually got armed so the caller can tell
   * the agent, since "I will wake at X" is a promise the agent will otherwise
   * make on its own.
   */
  armWakeAt(
    laneKey: string,
    at: Date | number,
    reason: string | null = null,
    scope?: WorkScope,
  ): { firesAt: number; delayMs: number } {
    const firesAtRaw = at instanceof Date ? at.getTime() : Number(at);
    if (!Number.isFinite(firesAtRaw)) {
      throw new Error('StateTimers.armWakeAt: `at` must be a Date or epoch ms');
    }
    const wakeScope = { ...scope };
    const now = Date.now();
    // A wake already due fires on the next turn of the event loop rather than
    // being refused: "wake me at 09:00" arriving at 09:00:01 means now, and an
    // error there would just be a check-back the agent never gets.
    const delayMs = Math.max(0, firesAtRaw - now);
    if (delayMs > MAX_WAKE_DELAY_MS) {
      throw new Error(
        `StateTimers.armWakeAt: ${new Date(firesAtRaw).toISOString()} is further out than this timer can hold ` +
          `(${Math.floor(MAX_WAKE_DELAY_MS / 86_400_000)} days). Arm a nearer wake and re-arm from it.`,
      );
    }

    this.clear(laneKey);
    const epoch = ++this._epoch;
    const handle = setTimeout(() => {
      runtimeLog.debug(
        'StateTimers',
        `wake-at fired laneKey=${laneKey} reason=${reason ?? 'none'} epoch=${epoch}`,
      );
      this._enqueue(
        { type: 'wake-at', reason, scheduledFor: firesAtRaw, epoch, ...wakeScope },
        laneKey,
      );
    }, delayMs);
    (handle as unknown as { unref?: () => void }).unref?.();
    this._timers.set(laneKey, {
      epoch,
      kind: 'wake-at',
      state: '',
      reason,
      timeoutMs: delayMs,
      firesAt: now + delayMs,
      armedAt: now,
      handle,
    });
    return { firesAt: now + delayMs, delayMs };
  }

  /** What is armed on this lane, if anything. Read by the specs and by `wake_at`. */
  peek(
    laneKey: string,
  ): { kind: 'liveness' | 'wake-at'; firesAt: number; reason: string | null } | null {
    const t = this._timers.get(laneKey);
    return t ? { kind: t.kind, firesAt: t.firesAt, reason: t.reason } : null;
  }

  /**
   * Consume the timer for a frame that survived stripStale. Liveness tracks
   * inactivity, so any event resets it. An explicit wake is an appointment:
   * unrelated traffic must leave it armed, even after it fired and queued.
   */
  consumeForEvent(event: unknown, laneKey: string): void {
    const pending = this._timers.get(laneKey);
    if (!pending) return;
    const frame = event as { type?: string; epoch?: number; events?: unknown[] } | null;
    const events = frame?.type === 'batch' && Array.isArray(frame.events)
      ? frame.events
      : [event];
    const consumesWake = events.some((entry) => {
      const e = entry as { type?: string; epoch?: number } | null;
      return e?.type === 'wake-at' && e.epoch === pending.epoch;
    });
    if (pending.kind === 'liveness' || consumesWake) this.clear(laneKey);
  }

  clear(laneKey: string): void {
    const t = this._timers.get(laneKey);
    if (!t) return;
    clearTimeout(t.handle);
    this._timers.delete(laneKey);
  }

  clearAll(): void {
    for (const key of [...this._timers.keys()]) this.clear(key);
  }

  /**
   * Drop stale timer events from an incoming frame (single event or an
   * EventQueue-coalesced { type: 'batch', events } frame). Returns null when
   * nothing survives (pure stale-timeout frame — the lane's live timer, if any,
   * must be left untouched by the caller in that case).
   *
   * `wake-at` frames are staled by the same epoch rule as
   * `state-timeout`. They have to be. A wake-at that fired, then got superseded
   * by a real event that re-armed the lane, would otherwise arrive as a
   * second check-back the budget never counted — the exact double-reminder the
   * ticket's stale-frame note is about.
   */
  stripStale(event: unknown, laneKey: string): unknown | null {
    const pending = this._timers.get(laneKey);
    const fresh = (ev: unknown): boolean => {
      const e = ev as { type?: string; epoch?: number };
      if (e?.type !== 'state-timeout' && e?.type !== 'wake-at') return true;
      const ok = pending !== undefined && e.epoch === pending.epoch;
      if (!ok) runtimeLog.debug('StateTimers', `dropping stale ${e.type} laneKey=${laneKey} epoch=${e.epoch} armed=${pending?.epoch ?? 'none'}`);
      return ok;
    };
    const b = event as { type?: string; events?: unknown[] };
    if (b?.type === 'batch' && Array.isArray(b.events)) {
      const kept = b.events.filter(fresh);
      if (kept.length === 0) return null;
      if (kept.length === b.events.length) return event;
      return kept.length === 1 ? kept[0] : { type: 'batch', events: kept };
    }
    return fresh(event) ? event : null;
  }
}
