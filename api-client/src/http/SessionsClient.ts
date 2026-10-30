import { getBackendUrl } from '../utils/urlUtils.js';
import { pollSurfaceError } from '../shared/rateLimit.js';
import type { Creds } from '../types.js';
import { buildCredsHeaders } from './operatorHeaders.js';

/** One awake window of an assistant. */
export interface AssistantSessionRow {
  sessionId: string;
  name: string;
  app: string;
  startedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  workspaceIds: string[];
  heldChatIds: string[];
  awake: boolean;
}

/**
 * List sibling windows and hold a chat in this one.
 * Uses the same session headers as the inbox so "this window" is the
 * X-Ziggs-Session the host already sends.
 */
export class SessionsClient {
  constructor(private readonly creds: Creds) {
    if (!creds.operatorKey) throw new Error('SessionsClient: operatorKey is required');
    if (!creds.agentId) throw new Error('SessionsClient: agentId is required');
  }

  private headers(): Record<string, string> {
    const headers = buildCredsHeaders({
      operatorKey: this.creds.operatorKey,
      agentId: this.creds.agentId!,
      laneId: this.creds.laneId,
    });
    if (this.creds.clientSessionId) headers['X-Ziggs-Session'] = this.creds.clientSessionId;
    if (this.creds.workspaceIds) headers['X-Ziggs-Workspaces'] = this.creds.workspaceIds;
    if (this.creds.app) headers['X-Ziggs-App'] = this.creds.app;
    if (this.creds.sessionName) headers['X-Ziggs-Session-Name'] = this.creds.sessionName;
    if (this.creds.instanceId) headers['X-Ziggs-Instance'] = this.creds.instanceId;
    return headers;
  }

  private url(path: string): string {
    return `${getBackendUrl()}/agents/${encodeURIComponent(this.creds.agentId!)}${path}`;
  }

  async list(): Promise<AssistantSessionRow[]> {
    const res = await fetch(this.url('/sessions'), {
      method: 'GET',
      headers: this.headers(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw pollSurfaceError('SessionsClient.list', res, body);
    const rows = (body as { sessions?: AssistantSessionRow[] }).sessions;
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * Hold `chatId` in this window (omit sessionId; server resolves from
   * X-Ziggs-Session), move it to `sessionId`, or pass null to release.
   */
  async hold(
    chatId: string,
    sessionId?: string | null,
  ): Promise<{ success: true; chatId: string; sessionId: string | null }> {
    if (!chatId?.trim()) throw new Error('SessionsClient.hold: chatId is required');
    const body: { chatId: string; sessionId?: string | null } = {
      chatId: chatId.trim(),
    };
    if (sessionId !== undefined) body.sessionId = sessionId;
    const res = await fetch(this.url('/sessions/hold'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => ({}));
    if (!res.ok) throw pollSurfaceError('SessionsClient.hold', res, parsed);
    return parsed as {
      success: true;
      chatId: string;
      sessionId: string | null;
    };
  }
}
