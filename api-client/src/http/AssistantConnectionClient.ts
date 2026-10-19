import { getBackendUrl } from '../utils/urlUtils.js';
import { hostIdentity } from '../instanceIdentity.js';
import { ApiError, type Creds, type InboxChangesOptions, type InboxChangesResult } from '../types.js';
import { parseErrorCode, parseErrorMessage } from '../shared/apiError.js';

export interface AssistantWorkspace {
  orgId: string;
  name: string;
  agentId: string;
}

export interface McpEventStatus {
  asOf: string;
  enabled: boolean;
  orgId: string;
  event: 'ziggs.inbox.updated';
  receiptMeaning: string;
  truncated: boolean;
  subscriptions: Array<{
    id: string;
    state: 'active' | 'expired' | 'stopped';
    expiresAt: string;
    lastVerifiedAt: string | null;
    lastCheckedAt: string | null;
    lastWorkerErrorAt: string | null;
    lastAcceptedAt: string | null;
    lastAttempt: { at: string; httpStatus: number | null; outcome: 'accepted' | 'retrying' | 'failed' | null } | null;
    lastFailure: { at: string; reason: 'network' | 'http' | 'attempts_exhausted' | null; httpStatus: number | null } | null;
    nextAttemptAt: string | null;
    stoppedReason: 'unsubscribed' | 'access_revoked' | 'connection_changed' | 'receiver_gone' | null;
  }>;
}

/**
 * The reads a connection makes about itself: which workspaces it works in,
 * and its one inbox across all of them. It never remembers a
 * current workspace and never changes shared credentials; the per-call pick
 * is the server's (see `routing.ts`).
 */
export class AssistantConnectionClient {
  constructor(
    private readonly creds: Creds,
    private readonly baseUrl = getBackendUrl(),
  ) {}

  async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.baseUrl}/oauth/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${this.creds.operatorKey}`,
        'Content-Type': 'application/json',
        'X-Ziggs-Instance': hostIdentity(this.creds.instanceId),
        ...(this.creds.clientSessionId ? { 'X-Ziggs-Session': this.creds.clientSessionId } : {}),
        ...(this.creds.workspaceIds ? { 'X-Ziggs-Workspaces': this.creds.workspaceIds } : {}),
        ...(this.creds.app ? { 'X-Ziggs-App': this.creds.app } : {}),
        ...(this.creds.sessionName ? { 'X-Ziggs-Session-Name': this.creds.sessionName } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(
        parseErrorMessage(text, `${path} failed: ${response.status}`),
        response.status,
        text,
        parseErrorCode(text),
      );
    }
    return JSON.parse(text) as T;
  }

  /** Read existing enabled assistant hires. Provisioning is an explicit sync action. */
  async workspaces(): Promise<AssistantWorkspace[]> {
    return (await this.request<{ workspaces: AssistantWorkspace[] }>('workspaces'))
      .workspaces;
  }

  /** Which of the connection's assistants is on an existing thing. */
  resolve(kind: string, id: string) {
    return this.request<{
      workspace: AssistantWorkspace | null;
      choices: AssistantWorkspace[];
    }>(`resolve?${new URLSearchParams({ kind, id })}`);
  }

  inbox(waitSeconds = 0, snapshot = false) {
    return this.request<Record<string, unknown>>(`inbox${snapshot ? "/snapshot" : ""}?wait=${waitSeconds}`);
  }

  getChanges(options: InboxChangesOptions = {}) {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    if (options.waitSeconds !== undefined) query.set('wait', String(options.waitSeconds));
    return this.request<InboxChangesResult>(`inbox/changes?${query}`, undefined, options.signal);
  }

  /** Receipt diagnostics only: this does not subscribe, renew or wake a host. */
  eventStatus(orgId: string, signal?: AbortSignal) {
    return this.request<McpEventStatus>(`events/status?${new URLSearchParams({ orgId })}`, undefined, signal);
  }

  ack(upTo: string, handledResourceIds: string[] = []) {
    return this.request('inbox/ack', { upTo, handledResourceIds });
  }

  park(agreementId: string) {
    return this.request<{ agreementId: string; parked: true }>('inbox/park', { agreementId });
  }
}
