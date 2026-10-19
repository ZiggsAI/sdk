import { getBackendUrl } from '../utils/urlUtils.js';
import { pollSurfaceError } from '../shared/rateLimit.js';
import { ApiError } from '../types.js';
import type {
  InboxAckResult,
  InboxEnvelope,
  InboxPeek,
  InboxReadOptions,
  InboxChangesOptions,
  InboxChangesResult,
} from '../types.js';
import {
  INBOX_HOST_CLAIMANT_HEADER,
  hostIdentity,
} from '../instanceIdentity.js';

/**
 * The doorbell, not the door: references addressed to this agent
 * since its last ack — never content. Flow: inbox → read → act → ack
 *. Wraps `GET /inbox` and `POST /inbox/ack`.
 */
export class InboxClient {
  private readonly operatorKey: string;
  private readonly agentId?: string;
  private readonly baseUrl: string;
  private readonly instanceId: string;
  private readonly session?: {
    clientSessionId?: string;
    workspaceIds?: string;
    app?: string;
    sessionName?: string;
  };

  /**
   * @param operatorKey Agent-scoped or fleet operator key.
   * @param agentId Required for fleet keys (sent as X-Agent-Id). Omit for agent-scoped keys.
   * @param instanceId This host's stable identity, when the caller knows it
   * better than the process does — see {@link hostIdentity}. A rail whose
   * process is not its host (the CLI, one hosted-MCP connection among many)
   * must pass its own; everything long-lived omits it.
   */
  constructor(
    operatorKey: string,
    agentId?: string,
    baseUrl?: string,
    instanceId?: string,
    session?: {
      clientSessionId?: string;
      workspaceIds?: string;
      app?: string;
      sessionName?: string;
    },
  ) {
    if (!operatorKey) throw new Error('InboxClient: operatorKey is required');
    this.operatorKey = operatorKey;
    this.agentId = agentId;
    this.baseUrl = baseUrl || getBackendUrl();
    this.instanceId = hostIdentity(instanceId);
    this.session = session;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.operatorKey}`,
      'Content-Type': 'application/json',
      // This host, not the API. Two fleets of the same agent share
      // one backend task; without this they both wake.
      [INBOX_HOST_CLAIMANT_HEADER]: this.instanceId,
    };
    if (this.agentId) headers['X-Agent-Id'] = this.agentId;
    if (this.session?.clientSessionId) headers['X-Ziggs-Session'] = this.session.clientSessionId;
    if (this.session?.workspaceIds) headers['X-Ziggs-Workspaces'] = this.session.workspaceIds;
    if (this.session?.app) headers['X-Ziggs-App'] = this.session.app;
    if (this.session?.sessionName) headers['X-Ziggs-Session-Name'] = this.session.sessionName;
    return headers;
  }

  private inboxUrl(path: string, opts: InboxReadOptions): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (opts.waitSeconds != null && opts.waitSeconds > 0) {
      url.searchParams.set('wait', String(opts.waitSeconds));
    }
    return url.toString();
  }

  /** At most 25 retained references per page. Keep cursor for subsequent waits;
   * observation never claims work or acknowledges it. Expired cursors return 410. */
  async getChanges(opts: InboxChangesOptions = {}): Promise<InboxChangesResult> {
    const url = new URL(this.inboxUrl('/inbox/changes', opts));
    if (opts.cursor !== undefined) url.searchParams.set('cursor', opts.cursor);
    const res = await fetch(url.toString(), { headers: this.headers(), signal: opts.signal });
    const body = await res.text().catch(() => '');
    if (!res.ok) throw pollSurfaceError('InboxClient.getChanges', res, body);
    return JSON.parse(body) as InboxChangesResult;
  }

  /** Read without acquiring worker ownership or recording receipts. */
  async getSnapshot(opts: InboxReadOptions & { signal?: AbortSignal } = {}): Promise<InboxEnvelope> {
    const res = await fetch(this.inboxUrl('/inbox/snapshot', opts), {
      method: 'GET', headers: this.headers(), signal: opts.signal,
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) throw pollSurfaceError('InboxClient.getSnapshot', res, body);
    return JSON.parse(body) as InboxEnvelope;
  }

  async getInbox(opts: InboxReadOptions & { signal?: AbortSignal } = {}): Promise<InboxEnvelope> {
    const res = await fetch(this.inboxUrl('/inbox', opts), {
      headers: this.headers(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throw pollSurfaceError('InboxClient.getInbox', res, body);
    }
    return JSON.parse(body) as InboxEnvelope;
  }

  /**
   * Wait for assigned mail without taking the host lease.
   * Still sends X-Ziggs-Instance; the server ignores it on this route.
   */
  async peek(opts: InboxReadOptions = {}): Promise<InboxPeek> {
    const res = await fetch(this.inboxUrl('/inbox/peek', opts), {
      headers: this.headers(),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throw pollSurfaceError('InboxClient.peek', res, body);
    }
    return JSON.parse(body) as InboxPeek;
  }

  /**
   * Advance this agent's watermark — pass the envelope's `ackTo` plus every
   * `resourceId` handled in `(priorAck, upTo]`. Monotonic
   * server-side: an older value is a no-op, so a replayed ack can never
   * redeliver handled work. An ack that would bury unlisted deliveries is
   * refused.
   */
  async ack(
    upTo: string,
    opts: { handledResourceIds?: string[] } = {},
  ): Promise<InboxAckResult> {
    if (!upTo) throw new Error('InboxClient.ack: upTo is required');
    const res = await fetch(`${this.baseUrl}/inbox/ack`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        upTo,
        ...(opts.handledResourceIds
          ? { handledResourceIds: opts.handledResourceIds }
          : {}),
      }),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throw pollSurfaceError('InboxClient.ack', res, body);
    }
    return JSON.parse(body) as InboxAckResult;
  }

  /** The person said to leave this proposal pending. Does not approve or reject. */
  async park(agreementId: string): Promise<{ agreementId: string; parked: true }> {
    if (!agreementId) throw new Error('InboxClient.park: agreementId is required');
    const res = await fetch(`${this.baseUrl}/inbox/park`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ agreementId }),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throw pollSurfaceError('InboxClient.park', res, body);
    }
    return JSON.parse(body) as { agreementId: string; parked: true };
  }

  /**
   * Ack, and if the row still names a host that has already gone away,
   * read once (that is what takes an expired inbox) and ack again.
   * A second host-conflict is a live competitor and is rethrown unchanged.
   */
  async ackOrTakeHost(
    upTo: string,
    opts: { handledResourceIds?: string[] } = {},
  ): Promise<InboxAckResult> {
    try {
      return await this.ack(upTo, opts);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'INBOX_HOST_CONFLICT') {
        throw err;
      }
      await this.getInbox();
      return await this.ack(upTo, opts);
    }
  }

  /**
   * Drop this process's inbox host lease so another client can take
   * GET /inbox on its next read.
   */
  async releaseHost(): Promise<{ released: boolean }> {
    const res = await fetch(`${this.baseUrl}/inbox/host`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throw pollSurfaceError('InboxClient.releaseHost', res, body);
    }
    return JSON.parse(body) as { released: boolean };
  }
}
