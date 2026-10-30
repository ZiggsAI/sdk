import { sendChatMessage } from '../http/ChatClient.js';
import { SOURCES_PARAM, sourcesArg } from './sources.js';
import { ConversationsClient } from '../http/ConversationsClient.js';
import { fullCreds, type CapabilityDefinition } from './types.js';
export const readConversationCapability: CapabilityDefinition = {
  key: 'conversation_read', names: { sdk: 'conversation_read', mcp: 'ziggs_conversation_read' }, title: 'Read conversation',
  descriptions: { sdk: 'Read a shared conversation by chatId, or agreement messages by agreementId and optional taskId. Shared message sender/receiver ids are presentation-safe addresses. No room or extra membership. Each row is checked against current access. Pass messageId for one exact inbox delivery.' },
  annotation: 'read-only', needsAgentId: true,
  params: {
    agreementId: { type: 'string' }, chatId: { type: 'string', description: 'Shared space; otherwise agreementId is required.' }, taskId: { type: 'string' }, messageId: { type: 'string' }, before: { type: 'string' }, limit: { type: 'number' },
  },
  handler: async (args, env) => {
    const creds = fullCreds(env); const client = new ConversationsClient(creds.operatorKey, creds.agentId);
    if (args['chatId'] && (args['agreementId'] || args['taskId'])) throw new Error('Read chatId as a shared space, or agreementId/taskId as work; executionContextId carries the selected execution.');
    if (args['chatId']) return client.readShared(String(args['chatId']), { messageId: args['messageId'] as string | undefined, before: args['before'] as string | undefined, limit: args['limit'] as number | undefined });
    if (!args['agreementId']) throw new Error('Name agreementId or chatId');
    return args['messageId'] ? client.get(String(args['agreementId']), String(args['messageId'])) : client.read(String(args['agreementId']), { taskId: args['taskId'] as string | undefined, before: args['before'] as string | undefined, limit: args['limit'] as number | undefined });
  },
};
export const sendConversationCapability: CapabilityDefinition = {
  key: 'conversation_send', names: { sdk: 'conversation_send', mcp: 'ziggs_conversation_send' }, title: 'Send conversation message',
  descriptions: { sdk: 'Send to a shared space with chatId and recipientRef (a visible endpoint id), optionally selecting agreementId as work. Otherwise send under an agreement, optionally a task, using a recipientRef from conversation_read or a replyToMessageId. Replies preserve their task and recipient. Use a stable messageId for retries. Current execution authority still applies; no room is opened.' },
  annotation: 'destructive', needsAgentId: true,
  params: {
    sources: SOURCES_PARAM,
    agreementId: { type: 'string' }, chatId: { type: 'string', description: 'Shared space; otherwise agreementId is required.' }, messageId: { type: 'string', required: true, description: 'Stable send id; reuse unchanged on retries.' }, text: { type: 'string', required: true }, recipientRef: { type: 'string', description: 'From conversation_read, or a known principal id.' }, replyToMessageId: { type: 'string', description: 'Original message; keeps its task and recipient.' }, taskId: { type: 'string' },
  },
  handler: async (args, env) => {
    const creds = fullCreds(env);
    if (args['chatId']) {
      if (args['replyToMessageId']) throw new Error('For a shared conversation, name recipientRef from the visible sender or recipient; replyToMessageId is for agreement conversations.');
      return sendChatMessage({ ...sourcesArg(args), chatId: String(args['chatId']), messageId: String(args['messageId']), text: String(args['text']), receiverId: args['recipientRef'] as string | undefined, conversationAgreementId: args['agreementId'] as string | undefined, taskId: args['taskId'] as string | undefined }, creds);
    }
    if (!args['agreementId']) throw new Error('Name agreementId or chatId');
    return new ConversationsClient(creds.operatorKey, creds.agentId).send(String(args['agreementId']), { ...sourcesArg(args), messageId: String(args['messageId']), text: String(args['text']), recipientRef: args['recipientRef'] as string | undefined, replyToMessageId: args['replyToMessageId'] as string | undefined, taskId: args['taskId'] as string | undefined });
  },
};
export const CONVERSATION_CAPABILITIES = [readConversationCapability, sendConversationCapability];
