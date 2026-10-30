import type { WorkExecutionContext } from '@ziggs-ai/api-client';
import { runtimeLog } from '../shared/runtimeLog.js';
import { InMemoryStore, type MemoryStore } from '../memory/MemoryStore.js';
import type { WorkScope } from '../runtime/wakeEffects.js';

/** One check-back an agent asked for, as it is kept across a restart. */
export interface SavedWake {
  laneKey: string;
  sessionId: string;
  firesAt: number;
  reason: string | null;
  scope?: WorkScope;
  executionContext?: WorkExecutionContext;
}

interface StoredWake extends Omit<SavedWake, 'laneKey'> {
  state: 'armed' | 'done';
}

const PREFIX = 'host:wake-at:';

/**
 * Where an agent's own check-backs are kept, so a restart does not lose them.
 *
 * The timer itself stays in memory (`StateTimers`). This keeps the facts
 * needed to arm it again: which lane, when, why, and under which work. A wake
 * is written when it is armed and marked done when it fires, so on start the
 * host re-arms exactly the ones still waiting, and one that passed while the
 * host was down fires once.
 *
 * The notes live in the agent's own memory store under a prefix no memory
 * section uses (sections are `hire:<id>`), so the agent's memory tools never
 * see them. Writes are chained so a mark can never land before the arm it
 * follows.
 *
 * Two hosts of the same agent running at once, as during a rolling deploy,
 * can both re-arm a wake and both fire it. That costs one extra wake, and the
 * agent checks for an answer before it chases anyone.
 */
export class WakeLedger {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly store: MemoryStore) {}

  /** False when the store is in memory: then a restart loses wakes anyway. */
  get durable(): boolean {
    return !(this.store instanceof InMemoryStore);
  }

  arm(wake: SavedWake): void {
    const { laneKey, ...rest } = wake;
    this.write(laneKey, { ...rest, state: 'armed' });
  }

  done(laneKey: string): void {
    this.writes = this.writes
      .then(async () => {
        const saved = (await this.store.get(PREFIX + laneKey)) as StoredWake | undefined;
        if (saved?.state === 'armed') {
          await this.store.put(PREFIX + laneKey, { ...saved, state: 'done' });
        }
      })
      .catch((err: unknown) => this.warn('mark done', laneKey, err));
  }

  /** The wakes still waiting to fire, for the host to arm again on start. */
  async pending(): Promise<SavedWake[]> {
    await this.writes;
    const rows = await this.store.list(PREFIX);
    const out: SavedWake[] = [];
    for (const { key, value } of rows) {
      const saved = value as StoredWake | undefined;
      if (saved?.state !== 'armed' || typeof saved.sessionId !== 'string') continue;
      if (!Number.isFinite(saved.firesAt)) continue;
      out.push({
        laneKey: key.slice(PREFIX.length),
        sessionId: saved.sessionId,
        firesAt: saved.firesAt,
        reason: saved.reason ?? null,
        ...(saved.scope ? { scope: saved.scope } : {}),
        ...(saved.executionContext ? { executionContext: saved.executionContext } : {}),
      });
    }
    return out;
  }

  /** Resolves when every write so far has landed. For tests and shutdown. */
  flushed(): Promise<void> {
    return this.writes;
  }

  private write(laneKey: string, value: StoredWake): void {
    this.writes = this.writes
      .then(() => this.store.put(PREFIX + laneKey, value))
      .catch((err: unknown) => this.warn('save', laneKey, err));
  }

  private warn(what: string, laneKey: string, err: unknown): void {
    runtimeLog.warn(
      'WakeLedger',
      `could not ${what} the wake for laneKey=${laneKey}: ${(err as Error)?.message || err}`,
    );
  }
}
