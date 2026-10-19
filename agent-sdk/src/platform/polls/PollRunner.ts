/**
 * PollRunner — executes declared external wake sources for agents.
 *
 * Each Agent owns its runner and starts it with its inbox loop. A poll is per
 * (agent, binding), with its own interval, backoff and backpressure. This same
 * lifecycle applies to fleet, MCP-tool, lab and evaluation agents.
 *
 * One loop per (agent, binding), and each loop AWAITS its own wake before
 * scheduling the next tick. That is the whole backpressure story: while an
 * agent is still dealing with what it was woken for, its next poll has not
 * happened yet, so it cannot be woken twice for the same thing. No in-flight
 * bookkeeping, no dedup table — the source is authoritative and a poll that
 * has not run yet cannot report anything stale.
 *
 * A failing source backs off exponentially and recovers on the first success.
 * Without it a source that is down is hit at full rate indefinitely, which is
 * how you get rate-limited by the thing you were trying to read.
 */

import { runtimeLog } from '../../shared/runtimeLog.js';
import { declaredPolls, type PollBinding, type PollKind, type PollRegistry } from './PollKind.js';

/** The slice of ConnectionPool this needs. Kept narrow to avoid a cycle. */
export interface WakeTarget {
  sendTo(
    agentId: string,
    text: string,
    metadata?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<unknown>;
}

export interface PollRunnerOptions {
  pool: WakeTarget;
  registry: PollRegistry;
  /** Registered agent configs — anything carrying `agentId` and maybe `polls`. */
  agents: Record<string, unknown>[];
  operatorKey?: string;
  defaultIntervalMs?: number;
  /** Ceiling on the failure backoff. Default 15 minutes. */
  maxBackoffMs?: number;
  /**
   * How long a woken agent may take before the wake is treated as hung.
   * Defaults to 5 minutes, matching the Claude-brain tick timeout — the pool's
   * own `sendTo` default is 30s, which a legitimate multi-turn wake blows
   * through every single time.
   */
  wakeTimeoutMs?: number;
  /**
   * Most actionable wakes one binding may cause per {@link wakeWindowMs}.
   * Default 20.
   *
   * A poll wakes its agent whenever the source says `actionable`, and each wake
   * is a real model run. Nothing else bounds that: the agent polls the outside
   * world and triggers itself, so the backend never sees it and the agreement
   * wake ceiling never gets a chance to fire. A mailbox that stops being
   * archived keeps answering "yes, there is unhandled mail" forever, at one wake
   * per interval, indefinitely.
   *
   * 20 an hour is far above any healthy agent and roughly 20 minutes of a
   * runaway at the 60s default interval.
   *
   * Deliberately a runner option and NOT read from the PollKind or the binding:
   * a bound that the bounded thing can raise is not a bound.
   */
  maxWakesPerWindow?: number;
  /** Window the wake cap is measured over. Default 1 hour. */
  wakeWindowMs?: number;
  label?: string;
}

interface Loop {
  agentId: string;
  binding: PollBinding;
  kind: PollKind;
  intervalMs: number;
  chatId: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** Consecutive failures; drives the backoff and resets on any success. */
  failures: number;
  inFlight: boolean;
  /** Actionable wakes caused in the current cap window. */
  wakes: number;
  /** When the current cap window opened. */
  windowStartedAt: number;
  /** True while the cap is tripped, so the stop is announced exactly once. */
  capped: boolean;
}

export class PollRunner {
  private readonly pool: WakeTarget;
  private readonly operatorKey?: string;
  private readonly label: string;
  private readonly maxBackoffMs: number;
  private readonly wakeTimeoutMs: number;
  private readonly maxWakesPerWindow: number;
  private readonly wakeWindowMs: number;
  private readonly loops: Loop[] = [];
  private running = false;
  private generation = 0;

  constructor({
    pool,
    registry,
    agents,
    operatorKey,
    defaultIntervalMs = 60_000,
    maxBackoffMs = 15 * 60_000,
    wakeTimeoutMs = Number(process.env.CLAUDE_SDK_TICK_TIMEOUT_MS ?? 300_000),
    maxWakesPerWindow = 20,
    wakeWindowMs = 60 * 60_000,
    label = 'PollRunner',
  }: PollRunnerOptions) {
    this.pool = pool;
    this.operatorKey = operatorKey;
    this.label = label;
    this.maxBackoffMs = maxBackoffMs;
    this.wakeTimeoutMs = wakeTimeoutMs;
    this.maxWakesPerWindow = maxWakesPerWindow;
    this.wakeWindowMs = wakeWindowMs;

    for (const config of agents) {
      const agentId = config['agentId'];
      if (typeof agentId !== 'string' || !agentId) continue;
      for (const binding of declaredPolls(config)) {
        const kind = registry.get(binding.kind);
        if (!kind) {
          // Loud, and does not stop the fleet: an agent declaring a kind nobody
          // registered would otherwise sit there looking healthy and never wake.
          runtimeLog.warn(
            label,
            `${agentId} declares unknown poll kind "${binding.kind}" — it will never be woken by it (registered: ${registry.ids.join(', ') || 'none'})`,
          );
          continue;
        }
        if (!binding.chatId) {
          // Refused at startup rather than dropped per-wake: without a lane the
          // host's session resolver returns null and the wake disappears with
          // only a debug line, which looks exactly like "the source is quiet".
          runtimeLog.warn(
            label,
            `${agentId} declares poll "${binding.kind}" without a chatId — refusing to register it, because every wake would be silently dropped`,
          );
          continue;
        }
        this.loops.push({
          agentId,
          binding,
          kind,
          intervalMs: kind.intervalMs ?? defaultIntervalMs,
          chatId: binding.chatId,
          timer: null,
          failures: 0,
          inFlight: false,
          wakes: 0,
          windowStartedAt: Date.now(),
          capped: false,
        });
      }
    }
  }

  get size(): number {
    return this.loops.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation++;
    if (!this.loops.length) return;
    for (const loop of this.loops) {
      if (!loop.inFlight) this.schedule(loop, 0);
    }
    runtimeLog.info(
      this.label,
      `started — ${this.loops.length} poll(s): ${this.loops.map((l) => `${l.agentId}:${l.kind.id}`).join(', ')}`,
    );
  }

  stop(): void {
    this.running = false;
    this.generation++;
    for (const loop of this.loops) {
      if (loop.timer) clearTimeout(loop.timer);
      loop.timer = null;
    }
    runtimeLog.info(this.label, 'stopped');
  }

  private schedule(loop: Loop, delayMs = this.nextDelay(loop)): void {
    if (!this.running) return;
    loop.timer = setTimeout(() => {
      loop.timer = null;
      loop.inFlight = true;
      void this.tick(loop, this.generation).finally(() => {
        loop.inFlight = false;
        this.schedule(loop);
      });
    }, delayMs);
  }

  /** Interval while healthy; doubling up to the ceiling while failing. */
  private nextDelay(loop: Loop): number {
    if (loop.failures === 0) return loop.intervalMs;
    return Math.min(loop.intervalMs * 2 ** loop.failures, this.maxBackoffMs);
  }

  private async tick(loop: Loop, generation = this.generation): Promise<void> {
    if (!this.running) return;

    let result;
    try {
      result = await loop.kind.poll(loop.binding, {
        agentId: loop.agentId,
        ...(this.operatorKey ? { operatorKey: this.operatorKey } : {}),
      });
      loop.failures = 0;
    } catch (err) {
      loop.failures += 1;
      runtimeLog.error(
        this.label,
        `${loop.agentId}:${loop.kind.id} source failed (${loop.failures}x, next in ${this.nextDelay(loop)}ms): ${(err as Error).message}`,
      );
      return;
    }

    // A source read may finish after disconnect or a new connection.
    if (!this.running || generation !== this.generation) return;

    if (result?.actionable && this.claimWake(loop)) {
      const hint = result.hint ?? `New work from ${loop.kind.id}. Check it.`;
      try {
        // Awaited on purpose — see the header. The next tick waits for the
        // agent to finish, which is what stops a double wake. chatId is what
        // makes the wake resolve to a lane at all, and wakeTimeoutMs has to
        // outlast a real multi-turn wake or the await stops meaning anything.
        await this.pool.sendTo(
          loop.agentId,
          hint,
          { chatId: loop.chatId, pollKind: loop.kind.id },
          { timeoutMs: this.wakeTimeoutMs },
        );
        runtimeLog.info(this.label, `woke ${loop.agentId} for ${loop.kind.id}`);
      } catch (err) {
        // Reported separately from a source failure: the source is fine, the
        // agent is not. Still backs off, because hammering a wedged agent helps
        // nobody.
        loop.failures += 1;
        runtimeLog.error(
          this.label,
          `${loop.agentId} wake failed (${loop.failures}x, next in ${this.nextDelay(loop)}ms): ${(err as Error).message}`,
        );
      }
    }

  }

  /**
   * Take one wake from this binding's budget, or refuse.
   *
   * Refusing is announced once per window, at error level, and resuming is
   * announced too. A poll that simply goes quiet is worse than one that wakes
   * too much: from the outside it is indistinguishable from a mailbox that is
   * genuinely empty, so nobody looks.
   *
   * The source keeps being polled while capped. Stopping the poll as well would
   * mean the first tick after the window rolls is the one that discovers the
   * backlog, and a source that recovered would go unnoticed for a whole window.
   */
  private claimWake(loop: Loop): boolean {
    const now = Date.now();
    if (now - loop.windowStartedAt >= this.wakeWindowMs) {
      if (loop.capped) {
        runtimeLog.info(
          this.label,
          `${loop.agentId}:${loop.kind.id} wake budget reset — waking again (cap ${this.maxWakesPerWindow}/${this.wakeWindowMs}ms)`,
        );
      }
      loop.windowStartedAt = now;
      loop.wakes = 0;
      loop.capped = false;
    }

    if (loop.wakes >= this.maxWakesPerWindow) {
      if (!loop.capped) {
        loop.capped = true;
        runtimeLog.error(
          this.label,
          `${loop.agentId}:${loop.kind.id} hit the wake cap (${this.maxWakesPerWindow} in ${this.wakeWindowMs}ms) and will NOT be woken again until the window rolls. ` +
            `The source keeps reporting actionable, so either it is genuinely that busy or something downstream stopped clearing it.`,
        );
      }
      return false;
    }

    loop.wakes += 1;
    return true;
  }
}
