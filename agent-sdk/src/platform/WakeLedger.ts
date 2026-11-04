import type { WorkExecutionContext } from '@ziggs-ai/api-client';
import { runtimeLog } from '../shared/runtimeLog.js';
import { InMemoryStore, type MemoryStore } from '../memory/MemoryStore.js';
import type { WorkScope } from '../runtime/wakeEffects.js';
import type { LaneBucket } from './laneKey.js';

/** One check-back an agent asked for, as it is kept across a restart. */
export interface SavedWake {
  wakeId: string;
  laneKey: string;
  sessionId: string;
  firesAt: number;
  reason: string | null;
  scope?: WorkScope;
  /** The conversation the lane's own messages came from, when it has one. */
  addressId?: string;
  executionContext?: WorkExecutionContext;
  /** The bucket a bucket lane carries, so a restart names the same lane. */
  bucket?: LaneBucket;
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
 * is written when armed and marked done after successful handover, so on start the
 * host re-arms exactly the ones still waiting, and one that passed while the
 * host was down remains eligible. A failed handover remains pending.
 *
 * The notes live in the agent's own memory store under a prefix no memory
 * section uses (sections are `hire:<id>`), so the agent's memory tools never
 * see them. Writes are chained so a mark can never land before the arm it
 * follows.
 *
 * Concurrent hosts may both discover a pending wake. Exact action claims fence
 * simultaneous execution; the domain owner still decides whether work is due.
 */
export class WakeLedger {
  private inFlight = new Set<Promise<unknown>>();
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

  done(laneKey: string, wakeId: string): void {
    this.writes = this.writes
      .then(async () => {
        const saved = (await this.store.get(PREFIX + laneKey)) as StoredWake | undefined;
        if (saved?.state === 'armed' && saved.wakeId === wakeId) {
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
        wakeId: saved.wakeId,
        sessionId: saved.sessionId,
        firesAt: saved.firesAt,
        reason: saved.reason ?? null,
        ...(saved.scope ? { scope: saved.scope } : {}),
        ...(typeof saved.addressId === 'string' && saved.addressId ? { addressId: saved.addressId } : {}),
        ...(saved.executionContext ? { executionContext: saved.executionContext } : {}),
        ...(isLaneBucket(saved.bucket) ? { bucket: { bucketId: saved.bucket.bucketId, revision: saved.bucket.revision } } : {}),
      });
    }
    return out;
  }

  /** Resolves when every write so far has landed. For tests and shutdown. */
  track(work: Promise<unknown>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work)).catch(() => {});
  }

  async flushed(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
    await this.writes;
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

function isLaneBucket(raw: unknown): raw is LaneBucket {
  const bucket = raw as Partial<LaneBucket> | undefined;
  return typeof bucket?.bucketId === 'string' && !!bucket.bucketId && Number.isInteger(bucket.revision);
}
