import { buildOperatorHeaders } from './operatorHeaders.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';

/** Reads from the shared audience presentation under its current access rules. */
export class SharedMessagesClient {
  constructor(private readonly operatorKey: string, private readonly agentId: string, private readonly baseUrl?: string) {}
  async read(chatId: string, options: { before?: string; limit?: number } = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (options.before) query.set('cursor', options.before);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const suffix = query.size ? `?${query}` : '';
    const res = await fetch(`${this.baseUrl ?? getBackendUrl()}/conversations/shared/${encodeURIComponent(chatId)}/messages${suffix}`, {
      headers: buildOperatorHeaders(this.operatorKey, this.agentId),
    });
    if (!res.ok) throwApiError(res, await res.text().catch(() => ''), `Conversation request failed: ${res.status}`);
    return await res.json() as unknown;
  }
}
