import type { MessageWireDto, WorkMessage, DirectMessage, DirectMessageSend } from "@ziggs-ai/contracts";
import { buildOperatorHeaders } from "./operatorHeaders.js";
import { getBackendUrl } from "../utils/urlUtils.js";
import { throwApiError } from "../shared/apiError.js";

/** Exact resource access; the server derives policy from the stored record. */
export class MessageRecordsClient {
  constructor(
    private readonly operatorKey: string,
    private readonly agentId: string,
    private readonly baseUrl?: string,
  ) {}

  async get(messageId: string): Promise<MessageWireDto | WorkMessage | DirectMessage> {
    const res = await fetch(
      `${this.baseUrl ?? getBackendUrl()}/messaging/messages/${encodeURIComponent(messageId)}`,
      {
        headers: buildOperatorHeaders(this.operatorKey, this.agentId),
      },
    );
    if (!res.ok)
      throwApiError(
        res,
        await res.text().catch(() => ""),
        `Message read failed: ${res.status}`,
      );
    const row = (await res.json()) as MessageWireDto | WorkMessage | DirectMessage;
    if (row?.messageId !== messageId)
      throw new Error("Assigned message does not match its identity");
    return row;
  }
  async replies(messageId: string, options: { before?: string; limit?: number } = {}): Promise<{ messages: Array<MessageWireDto | WorkMessage | DirectMessage>; nextCursor: string | null }> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value));
    const res = await fetch(`${this.baseUrl ?? getBackendUrl()}/messaging/messages/${encodeURIComponent(messageId)}/replies?${query}`, {
      headers: buildOperatorHeaders(this.operatorKey, this.agentId),
    });
    if (!res.ok) throwApiError(res, await res.text().catch(() => ''), `Message history failed: ${res.status}`);
    return await res.json() as { messages: Array<MessageWireDto | WorkMessage | DirectMessage>; nextCursor: string | null };
  }

  async send(input: DirectMessageSend): Promise<{ message: DirectMessage; outcome: 'created' | 'existing' }> {
    const res = await fetch(`${this.baseUrl ?? getBackendUrl()}/messaging/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...buildOperatorHeaders(this.operatorKey, this.agentId) },
      body: JSON.stringify(input),
    });
    if (!res.ok) throwApiError(res, await res.text().catch(() => ''), `Message send failed: ${res.status}`);
    return await res.json() as { message: DirectMessage; outcome: 'created' | 'existing' };
  }

}
