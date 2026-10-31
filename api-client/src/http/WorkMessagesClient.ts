import type { WorkMessage, WorkMessageRead, WorkMessageSend, MessagingControls } from '@ziggs-ai/contracts';
import { buildOperatorHeaders } from './operatorHeaders.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';

/** Shared work messaging operations. No conversation or page lifecycle. */
export class WorkMessagesClient {
  constructor(protected readonly operatorKey: string, protected readonly agentId: string, protected readonly baseUrl?: string) {}
  private async request<T>(agreementId: string, suffix = '', init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl ?? getBackendUrl()}/messaging/work/${encodeURIComponent(agreementId)}${suffix}`, {
      ...init, headers: { 'content-type': 'application/json', ...buildOperatorHeaders(this.operatorKey, this.agentId) },
    });
    if (!res.ok) throwApiError(res, await res.text().catch(() => ''), `Messaging request failed: ${res.status}`);
    return await res.json() as T;
  }
  controls(agreementId: string, taskId?: string): Promise<MessagingControls> {
    const query = new URLSearchParams(taskId ? { taskId } : {});
    return this.request(agreementId, `/controls${query.size ? `?${query}` : ''}`);
  }
  read(agreementId: string, options: { taskId?: string; before?: string; limit?: number } = {}): Promise<WorkMessageRead> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value));
    return this.request(agreementId, `/messages${query.size ? `?${query}` : ''}`);
  }
  send(agreementId: string, input: WorkMessageSend): Promise<{ message: WorkMessage; outcome: 'created' | 'existing' }> {
    return this.request(agreementId, '/messages', { method: 'POST', body: JSON.stringify(input) });
  }
}
export type { WorkMessage, WorkMessageRead, WorkMessageSend, MessageEndpoint } from '@ziggs-ai/contracts';
