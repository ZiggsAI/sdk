import { decodeOperatorKeyClaims } from '../shared/operatorKey.js';
import { buildOperatorHeaders } from './operatorHeaders.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';

export interface ListMessagesOptions {
  /** ISO timestamp; only entries with `timestamp > after` are returned. */
  after?: string;
  /** Page size, default 100, hard cap 1000. */
  limit?: number;
}

/**
 * The chat message URL.
 *
 * `after` is a forward delta: the server returns that page only when both
 * `after` and `direction=forward` are set. Omitting both is the newest page,
 * which is how a person asks what just happened without already knowing a time.
 */
export function messagesListUrl(
  base: string,
  chatId: string,
  opts: ListMessagesOptions = {},
): string {
  const url = new URL(
    `${base}/chats/${encodeURIComponent(chatId)}/messages`,
  );
  if (opts.after) {
    url.searchParams.set('direction', 'forward');
    url.searchParams.set('after', opts.after);
  }
  if (opts.limit != null) url.searchParams.set('limit', String(opts.limit));
  return url.toString();
}

export interface ListMessagesResult {
  messages: unknown[];
  latestSequence: string | null;
}

/**
 * Read-side client for forward-delta message reads.
 *
 * Hits the canonical `GET /chats/:chatId/messages?after=&direction=forward&limit=`
 * endpoint and returns a `{ messages, latestSequence }` envelope
 * (`chat-messaging.controller.listMessagesForward` →
 * `MessagesService.listForChat`).
 */
export class MessagesClient {
  private readonly operatorKey: string;
  private readonly agentId: string;

  constructor(operatorKey: string, agentId: string) {
    if (!operatorKey) throw new Error('MessagesClient: operatorKey is required');
    if (!agentId && !decodeOperatorKeyClaims(operatorKey)?.connectionClientId)
      throw new Error(
        'MessagesClient: agentId is required (operator-token impersonation)',
      );
    this.operatorKey = operatorKey;
    this.agentId = agentId;
  }

  async list(
    chatId: string,
    opts: ListMessagesOptions = {},
  ): Promise<ListMessagesResult> {
    if (!chatId) return { messages: [], latestSequence: null };
    // Forward-delta read mode. Backend routes to `listMessagesForward`
    // only when BOTH `after` and `direction=forward` are present; without
    // `after` the same handler falls into backward pagination and returns
    // a different envelope. Default `after` to the unix epoch so the
    // forward branch always wins when callers want "from the beginning".
    const url = messagesListUrl(getBackendUrl(), chatId, {
      after: opts.after || '1970-01-01T00:00:00.000Z',
      limit: opts.limit,
    });
    const res = await fetch(url, { headers: this._headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Callers branch on ApiError.status (404 = chat deleted/not visible).
      throwApiError(res, body, `MessagesClient.list failed: ${res.status}`);
    }
    return (await res.json()) as ListMessagesResult;
  }

  /**
   * Newest page. No `after`, so the server walks backward from now.
   * `list` is the forward delta and cannot answer "what just happened".
   */
  async listLatest(
    chatId: string,
    opts: { limit?: number } = {},
  ): Promise<ListMessagesResult> {
    if (!chatId) return { messages: [], latestSequence: null };
    const res = await fetch(
      messagesListUrl(getBackendUrl(), chatId, { limit: opts.limit }),
      { headers: this._headers() },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throwApiError(res, body, `MessagesClient.listLatest failed: ${res.status}`);
    }
    return (await res.json()) as ListMessagesResult;
  }

  private _headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...buildOperatorHeaders(this.operatorKey, this.agentId),
    };
  }
}
