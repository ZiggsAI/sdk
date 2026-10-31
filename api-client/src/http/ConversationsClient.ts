import { WorkMessagesClient } from './WorkMessagesClient.js';
import { buildOperatorHeaders } from './operatorHeaders.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';

/** Compatibility facade. New work clients use WorkMessagesClient directly. */
export class ConversationsClient extends WorkMessagesClient {
  /** Legacy shared-audience adapter; participation checks remain on the server. */
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
}
export type { ConversationMessage, ConversationRead, ConversationSend, ConversationEndpoint } from '@ziggs-ai/contracts';
