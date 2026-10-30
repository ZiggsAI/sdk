import type { ConversationMessage, ConversationRead, ConversationSend } from '@ziggs-ai/contracts';
import { buildOperatorHeaders } from './operatorHeaders.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';

/** Agreement messages. Never creates or looks up a room. */
export class ConversationsClient {
  constructor(private readonly operatorKey: string, private readonly agentId: string, private readonly baseUrl?: string) {}
  private async request<T>(agreementId: string, suffix = '', init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl ?? getBackendUrl()}/conversations/${encodeURIComponent(agreementId)}/messages${suffix}`, {
      ...init, headers: { 'content-type': 'application/json', ...buildOperatorHeaders(this.operatorKey, this.agentId) },
    });
    if (!res.ok) throwApiError(res, await res.text().catch(() => ''), `Conversation request failed: ${res.status}`);
    return await res.json() as T;
  }
  /** Shared-space reads retain participation and contribution boundaries. */
  async readShared(chatId: string, options: { before?: string; limit?: number; messageId?: string } = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (options.before) query.set('cursor', options.before);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const suffix = options.messageId ? `/${encodeURIComponent(options.messageId)}` : query.size ? `?${query}` : '';
    const res = await fetch(`${this.baseUrl ?? getBackendUrl()}/conversations/shared/${encodeURIComponent(chatId)}/messages${suffix}`, {
      headers: buildOperatorHeaders(this.operatorKey, this.agentId),
    });
    if (!res.ok) throwApiError(res, await res.text().catch(() => ''), `Conversation request failed: ${res.status}`);
    return await res.json() as unknown;
  }
  read(agreementId: string, options: { taskId?: string; before?: string; limit?: number } = {}): Promise<ConversationRead> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value));
    return this.request(agreementId, query.size ? `?${query}` : '');
  }
  get(agreementId: string, messageId: string): Promise<ConversationMessage> {
    return this.request(agreementId, `/${encodeURIComponent(messageId)}`);
  }
  send(agreementId: string, input: ConversationSend): Promise<{ message: ConversationMessage; outcome: 'created' | 'existing' }> {
    return this.request(agreementId, '', { method: 'POST', body: JSON.stringify(input) });
  }
}
export type { ConversationMessage, ConversationRead, ConversationSend, ConversationEndpoint } from '@ziggs-ai/contracts';
