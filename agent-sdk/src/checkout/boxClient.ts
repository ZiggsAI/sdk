import { runtimeLog } from '../shared/runtimeLog.js';
import type {
  CheckoutBoxEndpoint,
  CheckoutPushResult,
  CheckoutRunResult,
  CheckoutTarget,
} from './types.js';

/**
 * The backend door the box's git traffic goes through, and the grant it is
 * spent under. The host presents its own operator credentials; the box never
 * sees them, and the connection owner's token never leaves the backend.
 */
export interface GitDoorTarget {
  backendUrl: string;
  operatorKey: string;
  agentId: string;
  laneId?: string;
  executionContextId?: string;
  connectionId: string;
  grantId: string;
  taskId: string;
  repository: Pick<CheckoutTarget, 'owner' | 'name'>;
}

/** Headers git sends that the door needs to see; anything else stays behind. */
const GIT_REQUEST_HEADERS = ['content-type', 'content-encoding', 'accept', 'git-protocol'];
/** Headers the door answers with that git needs to see. */
const GIT_RESPONSE_HEADERS = ['content-type', 'cache-control', 'content-encoding', 'www-authenticate'];

const BOX_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)(\?.*)?$/;

/** The door path for one of the box's git requests, or null when the request names another repository. */
export function doorPathFor(boxPath: string, door: Pick<GitDoorTarget, 'connectionId' | 'repository'>): string | null {
  const m = BOX_PATH.exec(boxPath);
  if (!m) return null;
  const [, owner, name, tail, query] = m;
  if (owner.toLowerCase() !== door.repository.owner.toLowerCase() || name.toLowerCase() !== door.repository.name.toLowerCase()) {
    return null;
  }
  return `/connections/${encodeURIComponent(door.connectionId)}/git/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${tail}${query ?? ''}`;
}

export function doorHeaders(door: GitDoorTarget, gitHeaders: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {
    authorization: `Bearer ${door.operatorKey}`,
    'x-agent-id': door.agentId,
    'x-grant-id': door.grantId,
    'x-ziggs-task-id': door.taskId,
  };
  if (door.executionContextId) out['x-ziggs-execution'] = door.executionContextId;
  for (const [k, v] of Object.entries(gitHeaders)) {
    if (GIT_REQUEST_HEADERS.includes(k.toLowerCase())) out[k.toLowerCase()] = v;
  }
  return out;
}

export class CheckoutBoxError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'CheckoutBoxError';
  }
}

/**
 * The host's end of the channel. One per box. Every call carries the box's
 * secret; the box answers nothing without it.
 */
export class CheckoutBoxClient {
  private relayStopped = false;
  private relayLoop: Promise<void> | null = null;
  private relayAbort = new AbortController();
  private readonly forwarding = new Set<Promise<void>>();
  private mutation: Promise<unknown> = Promise.resolve();
  private closing = false;
  onMutation?: () => Promise<void>;
  checkpointWarning?: string;

  warnCheckpoint(message: string): void {
    this.checkpointWarning = message;
    runtimeLog.warn('checkout', message);
  }

  private withCheckpointWarning<T>(result: T): T {
    return this.checkpointWarning ? { ...result, checkpointWarning: this.checkpointWarning } : result;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutation.catch(() => {}).then(async () => {
      if (this.closing) throw new CheckoutBoxError('checkout is closing');
      let result: T;
      try { result = await operation(); }
      catch (error) {
        // A lost HTTP response does not prove the command stopped. Quiesce
        // before snapshotting; otherwise a retry could restore a torn archive.
        await this.call('/cancel', {}, 5_000).catch(() => {});
        throw error;
      }
      finally {
        try { await this.onMutation?.(); }
        catch (error) {
          this.warnCheckpoint(`Private checkpoint save failed: ${(error as Error).message}. Only previously saved or pushed work can be recovered.`);
        }
      }
      return this.withCheckpointWarning(result);
    });
    this.mutation = pending;
    return pending;
  }

  async quiesce(): Promise<void> {
    this.closing = true;
    await this.call('/cancel', {}, 5_000).catch(() => {});
    await this.mutation.catch(() => {});
  }

  async checkpoint(): Promise<Uint8Array> {
    const res = await this.fetchFn(`${this.endpoint.url}/checkpoint`, {
      method: 'POST', headers: this.auth(), signal: AbortSignal.timeout(130_000),
    });
    if (!res.ok) throw new CheckoutBoxError(`checkpoint failed: ${await res.text()}`, res.status);
    const reader = res.body?.getReader();
    if (!reader) throw new CheckoutBoxError('checkpoint has no body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 64 * 1024 * 1024) throw new CheckoutBoxError('checkpoint exceeds 64 MiB');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
  }

  async restore(data: Uint8Array): Promise<void> {
    const res = await this.fetchFn(`${this.endpoint.url}/restore`, {
      method: 'POST', headers: { ...this.auth(), 'content-type': 'application/gzip' },
      body: Buffer.from(data), signal: AbortSignal.timeout(130_000),
    });
    const text = await res.text();
    if (!res.ok) throw new CheckoutBoxError(`restore failed: ${text}`, res.status);
  }

  constructor(private readonly endpoint: CheckoutBoxEndpoint, private readonly fetchFn: typeof fetch = fetch) {}

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.endpoint.secret}` };
  }

  private async call<T>(path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const res = await this.fetchFn(`${this.endpoint.url}${path}`, {
      method: 'POST',
      headers: { ...this.auth(), 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text }; }
    if (!res.ok) {
      const error = (parsed as { error?: string } | null)?.error ?? text ?? `HTTP ${res.status}`;
      throw new CheckoutBoxError(`box ${path} failed: ${error}`, res.status);
    }
    return parsed as T;
  }

  /** Poll the box until it answers, or give up. */
  async waitReady(timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    let lastError = 'no answer';
    while (Date.now() < until) {
      try {
        const res = await this.fetchFn(`${this.endpoint.url}/health`, {
          headers: this.auth(),
          signal: AbortSignal.timeout(3_000),
        });
        if (res.ok) {
          await res.text();
          return;
        }
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = (err as Error).message;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new CheckoutBoxError(`box did not come up within ${Math.round(timeoutMs / 1000)}s (${lastError})`);
  }

  /**
   * Forward the box's git requests to the door, one at a time as git makes
   * them, until {@link stopRelay}. The box queues what git asks; this end
   * long-polls, performs each request against the door under the hire's
   * grant, and posts the answer back for git to read.
   */
  startRelay(door: GitDoorTarget): void {
    if (this.relayLoop) return;
    this.relayStopped = false;
    this.relayAbort = new AbortController();
    this.relayLoop = this.relay(door).catch((err) => {
      runtimeLog.warn('checkout', `git relay stopped: ${(err as Error).message}`);
    });
  }

  async stopRelay(): Promise<void> {
    this.relayStopped = true;
    this.relayAbort.abort();
    await Promise.allSettled(this.forwarding);
    await this.relayLoop?.catch(() => {});
    this.relayLoop = null;
  }

  private async relay(door: GitDoorTarget): Promise<void> {
    while (!this.relayStopped) {
      let next: Response;
      try {
        next = await this.fetchFn(`${this.endpoint.url}/relay/next`, {
          headers: this.auth(),
          signal: AbortSignal.any([this.relayAbort.signal, AbortSignal.timeout(40_000)]),
        });
      } catch {
        if (this.relayStopped) return;
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (next.status === 204) {
        await next.text().catch(() => {});
        continue;
      }
      if (!next.ok) {
        await next.text().catch(() => {});
        if (next.status === 401) throw new CheckoutBoxError('box refused the channel secret', 401);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const forwarding = this.forward(next, door).catch((err) => {
        if (!this.relayStopped) runtimeLog.warn('checkout', `git relay request failed: ${(err as Error).message}`);
      });
      this.forwarding.add(forwarding);
      void forwarding.finally(() => this.forwarding.delete(forwarding));
    }
  }

  private async forward(next: Response, door: GitDoorTarget): Promise<void> {
    const id = next.headers.get('x-relay-id') ?? '';
    const method = (next.headers.get('x-relay-method') ?? 'GET').toUpperCase();
    const boxPath = next.headers.get('x-relay-path') ?? '/';
    let gitHeaders: Record<string, string> = {};
    try { gitHeaders = JSON.parse(next.headers.get('x-relay-headers') ?? '{}'); } catch { gitHeaders = {}; }

    const reply = async (status: number, headers: Record<string, string>, body: BodyInit | null): Promise<void> => {
      const res = await this.fetchFn(`${this.endpoint.url}/relay/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: {
          ...this.auth(),
          'x-relay-status': String(status),
          'x-relay-headers': JSON.stringify(headers),
          'content-type': 'application/octet-stream',
        },
        body,
        // Streaming request bodies need half duplex in Node's fetch.
        ...({ duplex: 'half' } as Record<string, unknown>),
        signal: AbortSignal.any([this.relayAbort.signal, AbortSignal.timeout(10 * 60_000)]),
      });
      await res.text().catch(() => {});
    };

    const doorPath = doorPathFor(boxPath, door);
    if (!doorPath) {
      await next.body?.cancel().catch(() => {});
      await reply(403, { 'content-type': 'text/plain' }, `this box is checked out for ${door.repository.owner}/${door.repository.name} only`);
      return;
    }
    let upstream: Response;
    try {
      upstream = await this.fetchFn(`${door.backendUrl}${doorPath}`, {
        method,
        headers: doorHeaders(door, gitHeaders),
        body: method === 'POST' ? next.body : undefined,
        ...({ duplex: 'half' } as Record<string, unknown>),
        redirect: 'manual',
        signal: AbortSignal.any([this.relayAbort.signal, AbortSignal.timeout(10 * 60_000)]),
      });
    } catch (err) {
      await reply(502, { 'content-type': 'text/plain' }, `git door unreachable: ${(err as Error).message}`);
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of GIT_RESPONSE_HEADERS) {
      const v = upstream.headers.get(name);
      if (v) headers[name] = v;
    }
    await reply(upstream.status, headers, upstream.body);
  }

  setup(spec: { repository: string; baseBranch: string | null; branch: string }): Promise<{ baseBranch: string; branch: string; head: string; resumed: boolean }> {
    return this.call('/setup', spec, 15 * 60_000);
  }

  async read(path: string): Promise<{ path: string; content: string; bytes: number; truncated: boolean; checkpointWarning?: string }> {
    return this.withCheckpointWarning(await this.call<{ path: string; content: string; bytes: number; truncated: boolean }>('/read', { path }));
  }

  write(path: string, content: string): Promise<{ path: string; bytes: number; checkpointWarning?: string }> {
    return this.mutate(() => this.call('/write', { path, content }));
  }

  run(command: string, timeoutSeconds?: number): Promise<CheckoutRunResult> {
    const seconds = Math.max(1, Math.min(timeoutSeconds ?? 600, 1_800));
    return this.mutate(() => this.call('/run', { command, timeoutSeconds: seconds }, (seconds + 30) * 1000));
  }

  push(message: string): Promise<CheckoutPushResult> {
    return this.mutate(() => this.call('/push', { message }, 10 * 60_000));
  }

  /** Ask the box to exit. Best effort: a box that is already gone is the goal. */
  async stop(): Promise<void> {
    try {
      await this.call('/stop', {}, 5_000);
    } catch {
      /* already gone, or never came up */
    }
  }
}
