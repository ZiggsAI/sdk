import type { MessageWireDto, WorkMessage } from "@ziggs-ai/contracts";
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

  async get(messageId: string): Promise<MessageWireDto | WorkMessage> {
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
    const row = (await res.json()) as MessageWireDto | WorkMessage;
    if (row?.messageId !== messageId)
      throw new Error("Assigned message does not match its identity");
    return row;
  }
}
