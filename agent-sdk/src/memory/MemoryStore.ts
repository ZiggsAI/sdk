import { agreementIdFromLane } from '@ziggs-ai/api-client';
/**
 * Agent-private long-term memory.
 *
 * This is the SDK's contract; the *storage* is operator-provided. The agent
 * picks the key shape (often `counterparty:<id>`, sometimes `agreement:<id>:notes`,
 * etc.) — the SDK does not enforce one. Notes are bound to an agreement
 * (Ido, 2026-09-29): the host prefixes every key with the one agreement the
 * wake is under, and a wake under none or several has no notes at all. A
 * room is not a drawer, and neither is the agent as a whole.
 *
 * Reference implementations: `InMemoryStore` (default; non-durable) and
 * `FileMemoryStore` (single JSON file; useful for local dev). Anything
 * production-grade (sqlite, redis, postgres, …) is operator-owned.
 *
 * Aligns with the project's "agents are third-party" framing: an agent's
 * private notes are its own concern, not the backend's.
 */
export interface MemoryStore {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list(prefix: string): Promise<{ key: string; value: unknown }[]>;
  delete?(key: string): Promise<void>;
}

/** Non-durable reference impl. Per-process; lost on restart. */
export class InMemoryStore implements MemoryStore {
  private readonly store = new Map<string, unknown>();

  async get(key: string): Promise<unknown | undefined> {
    return this.store.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async list(prefix: string): Promise<{ key: string; value: unknown }[]> {
    const out: { key: string; value: unknown }[] = [];
    for (const [k, v] of this.store) {
      if (k.startsWith(prefix)) out.push({ key: k, value: v });
    }
    return out;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * Single-file JSON store. Reads on startup, writes on every put — fine for
 * local dev and example agents; not for production (no concurrency control,
 * no atomicity). Operators with serious durability needs ship their own
 * `MemoryStore` (sqlite, redis, …) and pass it via `defineAgent({ memory })`.
 */
export class FileMemoryStore implements MemoryStore {
  private cache: Record<string, unknown> | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly path: string) {}

  private async _ensureLoaded(): Promise<void> {
    if (this.cache) return;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const fs = await import('fs/promises');
          const txt = await fs.readFile(this.path, 'utf-8');
          this.cache = JSON.parse(txt) as Record<string, unknown>;
        } catch {
          this.cache = {};
        }
      })();
    }
    await this.loading;
  }

  private async _flush(): Promise<void> {
    if (!this.cache) return;
    const fs = await import('fs/promises');
    await fs.writeFile(this.path, JSON.stringify(this.cache, null, 2), 'utf-8');
  }

  async get(key: string): Promise<unknown | undefined> {
    await this._ensureLoaded();
    return this.cache![key];
  }

  async put(key: string, value: unknown): Promise<void> {
    await this._ensureLoaded();
    this.cache![key] = value;
    await this._flush();
  }

  async list(prefix: string): Promise<{ key: string; value: unknown }[]> {
    await this._ensureLoaded();
    return Object.entries(this.cache!)
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }

  async delete(key: string): Promise<void> {
    await this._ensureLoaded();
    delete this.cache![key];
    await this._flush();
  }
}

/**
 * Section a wake may read and write.
 *
 * Pick from the hire this wake is acting under — the same fact the
 * server uses for acting-for: a pinned agreement, the delivery / event
 * hire, or an `agrn-` lane. Exactly one agreement gives that agreement's
 * section. None, or several, gives null: notes are bound to an agreement,
 * so such a wake has nowhere to keep them, and says so on a write rather
 * than landing in a room's or the agent's shared drawer.
 */
export function memorySectionForWake(input: {
  sessionId?: string | null;
  activeAgreementId?: string | null;
  /** Hire ids already on this wake (delivery / event / acting-for). */
  wakeAgreementIds?: readonly (string | null | undefined)[];
}): string | null {
  const ids = uniqueHireIds([
    input.activeAgreementId,
    ...(input.wakeAgreementIds ?? []),
    agreementIdFromAgrnSession(input.sessionId),
  ]);
  return ids.length === 1 ? `hire:${ids[0]}` : null;
}

const NO_AGREEMENT_NOTES =
  'Notes are kept per agreement, and this wake is under none or several, so there is nothing to keep them under. Name the work this note belongs to, or keep it in the reply.';

/** The notes of a wake that has no single agreement: nothing to read, and a write says why. */
export function noAgreementMemoryStore(): MemoryStore {
  return {
    get: async () => undefined,
    put: async () => {
      throw new Error(NO_AGREEMENT_NOTES);
    },
    list: async () => [],
    delete: async () => {
      throw new Error(NO_AGREEMENT_NOTES);
    },
  };
}

/** Distinct non-empty hire ids, first-seen order. */
export function uniqueHireIds(
  raw: readonly (string | null | undefined)[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Hire ids the waking event already named. A chat-room message that
 * carries the delivery's `agreementId` is how two customer rooms
 * partition without a pinned ctx.
 */
export function hireIdsFromEvent(event: unknown): string[] {
  if (!event || typeof event !== 'object') return [];
  const rec = event as Record<string, unknown>;
  const resource =
    rec.resource && typeof rec.resource === 'object'
      ? (rec.resource as Record<string, unknown>)
      : {};
  const result =
    rec.result && typeof rec.result === 'object'
      ? (rec.result as Record<string, unknown>)
      : {};
  return uniqueHireIds([
    typeof rec.agreementId === 'string' ? rec.agreementId : null,
    typeof resource.agreementId === 'string' ? resource.agreementId : null,
    typeof result.agreementId === 'string' ? result.agreementId : null,
    rec.kind === 'agreement' && typeof rec.resourceId === 'string'
      ? rec.resourceId
      : null,
  ]);
}

function agreementIdFromAgrnSession(sessionId?: string | null): string | null {
  return agreementIdFromLane(sessionId)?.trim() || null;
}

/**
 * Present a store as if it only contained one section. Agent keys stay
 * unchanged; get/put/list/delete all go through `section:`.
 */
export function partitionMemoryStore(
  store: MemoryStore,
  section: string | null,
): MemoryStore {
  if (section === null) return noAgreementMemoryStore();
  const prefix = `${section}:`;
  const partitioned: MemoryStore = {
    get: (key) => store.get(prefix + key),
    put: (key, value) => store.put(prefix + key, value),
    list: async (keyPrefix) => {
      const rows = await store.list(prefix + keyPrefix);
      return rows.map(({ key, value }) => ({
        key: key.startsWith(prefix) ? key.slice(prefix.length) : key,
        value,
      }));
    },
  };
  if (store.delete) {
    partitioned.delete = (key) => store.delete!(prefix + key);
  }
  return partitioned;
}
