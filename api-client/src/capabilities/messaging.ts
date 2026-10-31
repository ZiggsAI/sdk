import { MessageRecordsClient } from "../http/MessageRecordsClient.js";
import { sendChatMessage } from "../http/ChatClient.js";
import { SOURCES_PARAM, sourcesArg } from "./sources.js";
import { WorkMessagesClient } from "../http/WorkMessagesClient.js";
import { SharedMessagesClient } from "../http/SharedMessagesClient.js";
import { fullCreds, type CapabilityDefinition } from "./types.js";
export const readConversationCapability: CapabilityDefinition = {
  key: "conversation_read",
  names: { sdk: "conversation_read", mcp: "ziggs_conversation_read" },
  title: "Read conversation",
  descriptions: {
    sdk: "Read a work conversation by agreementId (optional taskId), or a shared space by addressId. Returns recipient refs, which are addresses, not identities; Use message_read for an exact inbox delivery. Rows pass current access. Opens no room or membership.",
  },
  annotation: "read-only",
  needsAgentId: true,
  params: {
    agreementId: { type: "string" },
    addressId: { type: "string", description: "Shared space." },
    taskId: { type: "string" },
    before: { type: "string" },
    limit: { type: "number" },
  },
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const client = new WorkMessagesClient(
      creds.operatorKey,
      creds.agentId,
      env.baseUrl,
    );
    if (args["addressId"] && (args["agreementId"] || args["taskId"]))
      throw new Error(
        "Read addressId as a shared space, or agreementId/taskId as work; executionContextId carries the selected execution.",
      );
    if (args["addressId"])
      return new SharedMessagesClient(
        creds.operatorKey,
        creds.agentId,
        env.baseUrl,
      ).read(String(args["addressId"]), {
        before: args["before"] as string | undefined,
        limit: args["limit"] as number | undefined,
      });
    if (!args["agreementId"]) throw new Error("Name agreementId or addressId");
    return client.read(String(args["agreementId"]), {
      taskId: args["taskId"] as string | undefined,
      before: args["before"] as string | undefined,
      limit: args["limit"] as number | undefined,
    });
  },
};
export const sendConversationCapability: CapabilityDefinition = {
  key: "conversation_send",
  names: { sdk: "conversation_send", mcp: "ziggs_conversation_send" },
  title: "Send in a conversation",
  descriptions: {
    sdk: "Send in a work conversation by agreementId (optional taskId), or a shared space by addressId, where agreementId only selects work. Name recipientRef from conversation_read, or replyToMessageId: a reply keeps its task and recipient. Reuse a stable messageId unchanged on retries. Current execution applies; opens no room.",
  },
  annotation: "destructive",
  needsAgentId: true,
  params: {
    sources: SOURCES_PARAM,
    intent: {
      type: "string",
      enum: ["request", "notify", "contribute"],
      description:
        "request asks for a reply; notify is FYI; contribute advances agreementId/taskId. New work uses task_create.",
    },
    agreementId: { type: "string" },
    addressId: { type: "string", description: "Shared space." },
    messageId: {
      type: "string",
      required: true,
      description: "Reuse unchanged on retries.",
    },
    text: { type: "string", required: true },
    recipientRef: { type: "string", description: "From conversation_read." },
    replyToMessageId: {
      type: "string",
      description: "Keeps task and recipient.",
    },
    taskId: { type: "string" },
  },
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const intent = args["intent"] as "request" | "notify" | "contribute" | undefined;
    if (intent !== undefined && !["request", "notify", "contribute"].includes(intent))
      throw new Error("Unsupported message intent");
    if (args["addressId"]) {
      if (intent === "contribute")
        throw new Error("Contribute directly to agreementId/taskId without an addressId");
      if (args["replyToMessageId"])
        throw new Error(
          "For a shared conversation, name recipientRef from the visible sender or recipient; replyToMessageId is for agreement conversations.",
        );
      return sendChatMessage(
        {
          ...sourcesArg(args),
          ...(intent ? { intent } : {}),
          addressId: String(args["addressId"]),
          messageId: String(args["messageId"]),
          text: String(args["text"]),
          receiverId: args["recipientRef"] as string | undefined,
          workAgreementId: args["agreementId"] as string | undefined,
          taskId: args["taskId"] as string | undefined,
        },
        creds,
      );
    }
    if (!args["agreementId"]) throw new Error("Name agreementId or addressId");
    return new WorkMessagesClient(
      creds.operatorKey,
      creds.agentId,
      env.baseUrl,
    ).send(String(args["agreementId"]), {
      ...sourcesArg(args),
      ...(intent ? { intent } : {}),
      messageId: String(args["messageId"]),
      text: String(args["text"]),
      recipientRef: args["recipientRef"] as string | undefined,
      replyToMessageId: args["replyToMessageId"] as string | undefined,
      taskId: args["taskId"] as string | undefined,
    });
  },
};
export const readMessageCapability: CapabilityDefinition = {
  key: "message_read",
  names: { sdk: "message_read", mcp: "ziggs_message_read" },
  title: "Read exact message",
  descriptions: {
    sdk: "Read an exact message by messageId. The server checks its current access, historical bounds and selected execution. Does not read a conversation or acknowledge delivery.",
  },
  annotation: "read-only",
  needsAgentId: true,
  params: {
    messageId: {
      type: "string",
      required: true,
      description:
        "Exact message identity from the delivery or a source reference.",
    },
  },
  handler: async (args, env) => {
    const creds = fullCreds(env);
    return new MessageRecordsClient(
      creds.operatorKey,
      creds.agentId,
      env.baseUrl,
    ).get(String(args["messageId"]));
  },
};
export const sendMessageCapability: CapabilityDefinition = {
  key: "message_send",
  names: { sdk: "message_send", mcp: "ziggs_message_send" },
  title: "Send exact message",
  descriptions: { sdk: "Send without a group address. Readers control access; recipients get delivery; request names one assignee to answer, notify wakes nobody. A reply reference grants no access and selects no recipients. Reuse messageId unchanged on retries. Task inputs use conversation_send with contribute." },
  annotation: "destructive",
  needsAgentId: true,
  params: {
    messageId: { type: "string", required: true },
    text: { type: "string", required: true },
    readers: { type: "array", items: { type: "string" }, required: true },
    recipients: { type: "array", items: { type: "string" }, required: true },
    assigneeId: { type: "string" },
    intent: { type: "string", enum: ["request", "notify"], required: true },
    replyToMessageId: { type: "string" },
    sources: SOURCES_PARAM,
  },
  handler: async (args, env) => {
    const creds = fullCreds(env);
    if (args["intent"] !== "request" && args["intent"] !== "notify") throw new Error("Choose request or notify");
    for (const key of ["readers", "recipients"])
      if (!Array.isArray(args[key]) || !(args[key] as unknown[]).every(id => typeof id === "string" && id.length))
        throw new Error(`${key} must be explicit principal or endpoint references`);
    return new MessageRecordsClient(creds.operatorKey, creds.agentId, env.baseUrl).send({
      messageId: String(args["messageId"]), text: String(args["text"]),
      readers: args["readers"] as string[], recipients: args["recipients"] as string[],
      assigneeId: args["assigneeId"] as string | undefined,
      intent: args["intent"], replyToMessageId: args["replyToMessageId"] as string | undefined,
      ...sourcesArg(args),
    });
  },
};
export const readRepliesCapability: CapabilityDefinition = {
  key: "message_replies", names: { sdk: "message_replies", mcp: "ziggs_message_replies" },
  title: "Read message replies",
  descriptions: { sdk: "Read authorized replies to an exact message. Each reply checks current access; a parent link grants nothing. History survives delivery acknowledgment. Continue with nextCursor as before." },
  annotation: "read-only", needsAgentId: true,
  params: { messageId: { type: "string", required: true }, before: { type: "string" }, limit: { type: "number" } },
  handler: async (args, env) => {
    const creds = fullCreds(env);
    return new MessageRecordsClient(creds.operatorKey, creds.agentId, env.baseUrl).replies(String(args["messageId"]), {
      before: args["before"] as string | undefined, limit: args["limit"] as number | undefined,
    });
  },
};
export const MESSAGING_CAPABILITIES = [
  readMessageCapability,
  readRepliesCapability,
  sendMessageCapability,
  readConversationCapability,
  sendConversationCapability,
];
