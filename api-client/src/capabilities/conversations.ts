import { sendChatMessage } from '../http/ChatClient.js';
import { SOURCES_PARAM, sourcesArg } from './sources.js';
import { ConversationsClient } from '../http/ConversationsClient.js';
import { fullCreds, type CapabilityDefinition } from './types.js';
export const readConversationCapability: CapabilityDefinition = {
  key: 'conversation_read', names: { sdk: 'conversation_read', mcp: 'ziggs_conversation_read' }, title: 'Read conversation',
  descriptions: { sdk: 'Read a work conversation by agreementId (optional taskId), or a shared space by chatId. Returns recipient refs, which are addresses, not identities; messageId reads one exact inbox delivery. Rows pass current access. Opens no room or membership.' },
  annotation: 'read-only', needsAgentId: true,
  params: {
    agreementId: { type: 'string' }, chatId: { type: 'string', description: 'Shared space.' }, taskId: { type: 'string' }, messageId: { type: 'string' }, before: { type: 'string' }, limit: { type: 'number' },
  },
  handler: async (args, env) => {
    const creds = fullCreds(env); const client = new ConversationsClient(creds.operatorKey, creds.agentId, env.baseUrl);
    if (args['chatId'] && (args['agreementId'] || args['taskId'])) throw new Error('Read chatId as a shared space, or agreementId/taskId as work; executionContextId carries the selected execution.');
    if (args['chatId']) return client.readShared(String(args['chatId']), { messageId: args['messageId'] as string | undefined, before: args['before'] as string | undefined, limit: args['limit'] as number | undefined });
    if (!args['agreementId']) throw new Error('Name agreementId or chatId');
    return args['messageId'] ? client.get(String(args['agreementId']), String(args['messageId'])) : client.read(String(args['agreementId']), { taskId: args['taskId'] as string | undefined, before: args['before'] as string | undefined, limit: args['limit'] as number | undefined });
  },
};
export const sendConversationCapability: CapabilityDefinition = {
  key: 'conversation_send', names: { sdk: 'conversation_send', mcp: 'ziggs_conversation_send' }, title: 'Send in a conversation',
  descriptions: { sdk: 'Send in a work conversation by agreementId (optional taskId), or a shared space by chatId, where agreementId only selects work. Name recipientRef from conversation_read, or replyToMessageId: a reply keeps its task and recipient. Reuse a stable messageId unchanged on retries. Current execution applies; opens no room.' },
  annotation: 'destructive', needsAgentId: true,
  params: {
    sources: SOURCES_PARAM,
    agreementId: { type: 'string' }, chatId: { type: 'string', description: 'Shared space.' }, messageId: { type: 'string', required: true, description: 'Reuse unchanged on retries.' }, text: { type: 'string', required: true }, recipientRef: { type: 'string', description: 'From conversation_read.' }, replyToMessageId: { type: 'string', description: 'Keeps task and recipient.' }, taskId: { type: 'string' },
  },
  handler: async (args, env) => {
    const creds = fullCreds(env);
    if (args['chatId']) {
      if (args['replyToMessageId']) throw new Error('For a shared conversation, name recipientRef from the visible sender or recipient; replyToMessageId is for agreement conversations.');
      return sendChatMessage({ ...sourcesArg(args), chatId: String(args['chatId']), messageId: String(args['messageId']), text: String(args['text']), receiverId: args['recipientRef'] as string | undefined, conversationAgreementId: args['agreementId'] as string | undefined, taskId: args['taskId'] as string | undefined }, creds);
    }
    if (!args['agreementId']) throw new Error('Name agreementId or chatId');
    return new ConversationsClient(creds.operatorKey, creds.agentId, env.baseUrl).send(String(args['agreementId']), { ...sourcesArg(args), messageId: String(args['messageId']), text: String(args['text']), recipientRef: args['recipientRef'] as string | undefined, replyToMessageId: args['replyToMessageId'] as string | undefined, taskId: args['taskId'] as string | undefined });
  },
};
export const CONVERSATION_CAPABILITIES = [readConversationCapability, sendConversationCapability];
