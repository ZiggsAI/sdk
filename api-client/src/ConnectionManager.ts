import { runtimeLog } from './shared/runtimeLog.js';

type OpenFn = () => Promise<unknown>;
type CloseFn = (handle: unknown) => Promise<void>;

interface Entry {
  openFn: OpenFn;
  closeFn: CloseFn;
}

export interface ConnectionManagerMeta {
  domain?: string;
  expertise?: string[];
  tags?: string[];
  [key: string]: unknown;
}

export interface QueryFilter {
  domain?: string;
  expertise?: string[];
  tags?: string[];
}

/**
 * ConnectionManager — the set of agent hosts this process runs.
 *
 * Every registered agent is connected and stays connected. There is
 * no subset, no cap, no idle sweep and no lifecycle policy: an agent is alive
 * because its launcher registered it, and the only thing that takes it down is
 * the process exiting. Whether work has arrived recently is not a fact about
 * whether an agent should exist.
 *
 * What this replaced: an operator long-poll that asked the backend which agents
 * had mail, an LRU that evicted hosts past `maxActive`, an idle timer that slept
 * quiet hosts, and a `pinned` flag to exempt the ones an operator had named.
 * Together they made liveness depend on someone remembering to edit a Terraform
 * string, and cost a fleet-wide sweep per poll to find out nothing had changed.
 */
export class ConnectionManager {
  private _entries: Map<string, Entry>;
  private _active: Map<string, unknown>;
  private _meta: Map<string, ConnectionManagerMeta>;
  private _starting: Map<string, Promise<unknown>>;

  constructor() {
    this._entries = new Map();
    this._active = new Map();
    this._meta = new Map();
    this._starting = new Map();
  }

  register(id: string, openFn: OpenFn, closeFn: CloseFn, meta?: ConnectionManagerMeta): void {
    if (!id) throw new Error('[ConnectionManager] id is required');
    if (typeof openFn !== 'function') throw new Error('[ConnectionManager] openFn must be a function');
    if (typeof closeFn !== 'function') throw new Error('[ConnectionManager] closeFn must be a function');
    this._entries.set(id, { openFn, closeFn });
    if (meta) this._meta.set(id, meta);
  }

  /**
   * Connect every registered agent. One host's failure to come up is reported
   * and does not hold back the rest — its own transport retries, and a fleet
   * where 28 of 29 are live is not a launch worth aborting.
   */
  async connectAll(): Promise<void> {
    const ids = [...this._entries.keys()];
    // The count is the cost: every registered agent is one WS connection plus
    // one inbox long-poll, held for the life of the process. There is no cap,
    // so a registration list that balloons shows up here first — loudly, with
    // the number, before the sockets open.
    runtimeLog.info(
      'ConnectionManager',
      `connecting all ${ids.length} registered agent(s) — one connection + inbox long-poll each, for the life of the process`,
    );
    await Promise.all(
      ids.map((id) =>
        this.startAgent(id).catch((err) =>
          runtimeLog.warn('ConnectionManager', `start("${id}") failed: ${(err as Error).message}`),
        ),
      ),
    );
  }

  async startAgent(id: string): Promise<unknown> {
    const existing = this._active.get(id);
    if (existing) return existing;

    const pending = this._starting.get(id);
    if (pending) return pending;

    const entry = this._entries.get(id);
    if (!entry) throw new Error(`[ConnectionManager] unknown id: "${id}"`);

    const startPromise = (async () => {
      try {
        const handle = await entry.openFn();
        this._active.set(id, handle);
        return handle;
      } finally {
        this._starting.delete(id);
      }
    })();

    this._starting.set(id, startPromise);
    return startPromise;
  }

  async stopAgent(id: string): Promise<void> {
    if (!this._active.has(id)) return;
    const handle = this._active.get(id);
    this._active.delete(id);
    const reg = this._entries.get(id);
    if (reg) await reg.closeFn(handle);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this._active.keys()].map(id => this.stopAgent(id)));
  }

  list(): string[] { return [...this._entries.keys()]; }
  listActive(): string[] { return [...this._active.keys()]; }
  get size(): number { return this._entries.size; }

  query({ domain, expertise, tags }: QueryFilter = {}): string[] {
    const results: string[] = [];
    for (const [id, meta] of this._meta) {
      if (domain && meta.domain !== domain) continue;
      if (expertise?.length && !expertise.some(e => meta.expertise?.includes(e))) continue;
      if (tags?.length && !tags.some(t => meta.tags?.includes(t))) continue;
      results.push(id);
    }
    return results;
  }

  getMeta(id: string): ConnectionManagerMeta | undefined { return this._meta.get(id); }
}
