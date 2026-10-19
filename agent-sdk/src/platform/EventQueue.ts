import { runtimeLog } from '../shared/runtimeLog.js';

export type ProcessEventFn = (event: unknown, laneKey: string) => Promise<void>;

interface QueuedEntry {
  event: unknown;
  settle: (err?: unknown) => void;
}

interface LaneState {
  events: QueuedEntry[];
  processing: boolean;
}

interface QueueMetrics {
  enqueued: number;
  dropped: number;
  processedBatches: number;
  processedEvents: number;
  errors: number;
}

export interface EventQueueOptions {
  maxQueueLengthPerLane?: number;
}

export interface EventQueueBusyLane {
  laneKey: string;
  queued: number;
  processing: boolean;
}

/** Outcome of `waitForIdle` / `Agent.drain`. Timeout is data, not a throw. */
export interface WaitForIdleResult {
  idle: boolean;
  timedOut: boolean;
  timeoutMs: number;
  queuedEvents: number;
  busyLanes: EventQueueBusyLane[];
}

/**
 * Serializes events per lane and coalesces multiple queued events into one
 * batch dispatch. The runtime sees at most one in-flight processEvent call
 * per laneKey at a time; multiple events arriving while busy are merged
 * into a single { type: 'batch', events: [...] } frame on the next pass.
 *
 * `enqueue` REJECTS when the dispatch failed. It used to log the error
 * and resolve, which made every caller — including the inbox loop, whose next
 * statement is the ack — unable to tell a handled event from a lost one. A
 * caller that has nothing to do with a failure should say so with `.catch()`;
 * the one holding a delivery must not have that decision made for it.
 */
export class EventQueue {
  private _processEvent: ProcessEventFn;
  private _maxQueueLengthPerLane: number;
  private _state: Map<string, LaneState> = new Map();
  private _metrics: QueueMetrics = {
    enqueued: 0, dropped: 0, processedBatches: 0, processedEvents: 0, errors: 0,
  };

  constructor(processEventFn: ProcessEventFn, options: EventQueueOptions = {}) {
    this._processEvent = processEventFn;
    this._maxQueueLengthPerLane = Number.isFinite(options.maxQueueLengthPerLane)
      ? Math.max(1, options.maxQueueLengthPerLane!)
      : 100;
  }

  enqueue(event: unknown, laneKey: string): Promise<void> {
    if (!laneKey) {
      runtimeLog.warn('EventQueue', 'enqueue called without laneKey, skipping');
      return Promise.resolve();
    }

    let state = this._state.get(laneKey);
    if (!state) {
      state = { events: [], processing: false };
      this._state.set(laneKey, state);
    }

    return new Promise<void>((resolve, reject) => {
      this._metrics.enqueued += 1;
      state!.events.push({
        event,
        settle: (err?: unknown) => (err === undefined ? resolve() : reject(err)),
      });
      this._trimQueueIfNeeded(state!, laneKey);
      this._processIfNeeded(laneKey);
    });
  }

  private _processIfNeeded(laneKey: string): void {
    const state = this._state.get(laneKey);
    if (!state || state.processing || state.events.length === 0) return;
    state.processing = true;
    this._processLoop(laneKey);
  }

  private async _processLoop(laneKey: string): Promise<void> {
    const state = this._state.get(laneKey);
    if (!state) return;

    while (state.events.length > 0) {
      const batch = state.events.splice(0, state.events.length);
      const events = batch.map(e => e.event);
      const settlers = batch.map(e => e.settle);

      const coalesced = events.length === 1
        ? events[0]
        : { type: 'batch', events };

      // Coalescing makes the batch the unit of success: the lane ran one tick
      // for all of it, so a failure belongs to every event that was merged in.
      let failure: unknown;
      try {
        await this._processEvent(coalesced, laneKey);
      } catch (error: unknown) {
        failure = error ?? new Error('processEvent failed');
        this._metrics.errors += 1;
        runtimeLog.error('EventQueue', `processEvent error for laneKey=${laneKey}: ${(error as Error)?.message || error}`);
      }
      this._metrics.processedBatches += 1;
      this._metrics.processedEvents += events.length;

      for (const settle of settlers) settle(failure);
    }

    state.processing = false;
  }

  private _trimQueueIfNeeded(state: LaneState, laneKey: string): void {
    while (state.events.length > this._maxQueueLengthPerLane) {
      const dropped = state.events.shift();
      this._metrics.dropped += 1;
      // A dropped event was never handled, so its caller hears about it — the
      // inbox loop holds the ack instead of acking work that fell off the queue.
      dropped?.settle(
        new Error(`EventQueue dropped an event on laneKey=${laneKey} (queue over ${this._maxQueueLengthPerLane})`),
      );
      runtimeLog.warn('EventQueue', `dropped oldest event laneKey=${laneKey} max=${this._maxQueueLengthPerLane}`);
    }
  }

  get isIdle(): boolean {
    return [...this._state.values()].every(s => !s.processing && s.events.length === 0);
  }

  /** Lanes still holding work — a turn in flight, queued events, or both. */
  busyLanes(): EventQueueBusyLane[] {
    const out: EventQueueBusyLane[] = [];
    for (const [laneKey, state] of this._state) {
      if (!state.processing && state.events.length === 0) continue;
      out.push({ laneKey, queued: state.events.length, processing: state.processing });
    }
    return out;
  }

  /**
   * Resolves when every lane is idle, or when `timeoutMs` elapses.
   *
   * Never throws. A timeout is returned as data so the caller can name it
   * (queued count, which lanes) instead of a stray log line the verdict never
   * sees. `timeoutMs <= 0` checks once and returns immediately.
   */
  async waitForIdle(timeoutMs = 30_000): Promise<WaitForIdleResult> {
    const snapshot = (timedOut: boolean): WaitForIdleResult => {
      const busy = this.busyLanes();
      return {
        idle: busy.length === 0,
        timedOut,
        timeoutMs,
        queuedEvents: busy.reduce((n, lane) => n + lane.queued, 0),
        busyLanes: busy,
      };
    };

    if (this.isIdle) return snapshot(false);
    if (timeoutMs <= 0) return snapshot(true);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isIdle) return snapshot(false);
      await new Promise<void>(r => setTimeout(r, 50));
    }
    return snapshot(!this.isIdle);
  }

  getMetrics() {
    return {
      ...this._metrics,
      lanes: this._state.size,
      queuedEvents: [...this._state.values()].reduce((sum, lane) => sum + lane.events.length, 0),
    };
  }
}
