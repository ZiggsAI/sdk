import { SOURCES_PARAM, sourcesArg } from '@ziggs-ai/api-client';
import { isAgreementId, agreementLaneId } from '@ziggs-ai/api-client';
import { randomUUID } from 'node:crypto';
import { credsFromToolContext } from '../tools/toolCreds.js';
import { sendChatMessage, presentSendResult } from '@ziggs-ai/api-client';
import { defineTool, type ToolDefinition } from '../tools/defineTool.js';
import { listGrantsTool } from '../platform/tools/tier2/grantsTools.js';
import { cancelTaskTool, listTasksTool, delegateTaskTool } from '../platform/tools/tier2/taskTools.js';
import { CHAT_TOOLS } from '../platform/tools/tier2/chatTools.js';
import type { EffectHandler, DeliveryWriteKeys } from '../types.js';
import type { MemoryStore } from '../memory/MemoryStore.js';

export interface ClaudeSdkToolContext extends Record<string, unknown> {
  operatorKey: string;
  agentId: string;
  chatId?: string | null;
  sessionId?: string | null;
  eff?: EffectHandler;
  /** Human/agent whose message woke the agent — forwarded to the shared tool executor. */
  senderId?: string;
  senderType?: string;
  /** Agreement this wake acts under — lets a delegated per-user MCP call resolve the originating end-user. */
  onBehalfOfAgreementId?: string;
  /** Exact work scope of the wake that invoked this tool; same-room sends inherit it. */
  serviceAgreementId?: string;
  allowAutomaticMandate?: boolean;
  /** Per-wake id grouping this tick's tool calls in telemetry. Random — never use for idempotency. */
  runId?: string;
  /** Replay-stable write keys for this wake — write tools derive idempotency keys from here, never from the LLM. */
  writeKeys?: DeliveryWriteKeys;
  /** Hire-partitioned memory for this wake. Notes written here stay in this hire. */
  memory?: MemoryStore;
}

// default message-history cap. An uncapped snapshot returns the whole
// chat — in a delegation chat that accumulates notification rows, every wake's
// snapshot ballooned (observed 35–47k input tokens/wake, ~205k/run). 12 recent
// messages cover "what woke me and what was just said"; the model can pass a
// larger maxMessages explicitly when it genuinely needs deeper history.
const DEFAULT_SNAPSHOT_MAX_MESSAGES = 12;

/**
 * First usable string among the candidates, treating blank as absent.
 *
 * a model that does not know a value fills the field with `""` rather
 * than omitting it — the schema shows `chatId`, the agent has no way to know it,
 * so it sends an empty string. Plain `??` let that blank win over the lane
 * default, and the very next line rejected it as missing. Every wake opened with
 * a failed `context_snapshot` and a recovery turn.
 */
function firstFilled(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

/**
 * Accept the agreement id an agent was woken on where a chat id is wanted.
 *
 * An agent woken on an agreement reaches for its context with the only id that
 * wake gave it — the agreement's. That is not a chat id, so the snapshot came
 * back empty: no history, no agreements, the agent itself as the only participant,
 * and a bare `chatMissing`. Observed on the FIRST wake of every two-agent run,
 * and once it sent the provider off to chat instead of to its own task.
 *
 * An agreement's implicit notification chat is `agrn-<agreementId>` — the lane
 * the backend itself routes agreement traffic through — so the id the agent has
 * does name a readable room, one prefix away. Mapping it is the difference
 * between a wasted turn and an answer.
 */
function asChatLane(id: string | undefined): string | undefined {
  return isAgreementId(id) ? agreementLaneId(id) : id;
}

// Named distinctly from ziggs-mcp's per-type `ziggs_context_read`: this is the
// one-shot aggregate snapshot (grant-fenced server-side), not a cursored read.
export const contextSnapshotTool: ToolDefinition = defineTool(
  'context_snapshot',
  {
    chatId: { type: 'string', description: 'Omit this to snapshot the chat you were woken in — that is the usual case, and you do not need to know its id. Only pass a chatId to snapshot a DIFFERENT chat. An agreement id is accepted too, and reads that agreement\'s lane.' },
    maxMessages: { type: 'number', description: `Message history cap (default ${DEFAULT_SNAPSHOT_MAX_MESSAGES}). Pass a larger value when you need deeper history.` },
  },
  async (args, ctx) => {
    const c = ctx as ClaudeSdkToolContext;
    if (!c.eff) throw new Error('context_snapshot requires eff in tool context');
    const sessionId = asChatLane(firstFilled(args.chatId, c.chatId, c.sessionId));
    if (!sessionId) {
      throw new Error(
        'context_snapshot: this wake carries no chat to snapshot. Call it with no arguments ' +
          'to read the chat you were woken in; if this wake is on an agreement lane with no ' +
          'single chat, read the agreement instead and pass a chatId from one of its chats.',
      );
    }
    return c.eff({
      kind: 'read-context',
      sessionId,
      opts: {
        maxMessages: args.maxMessages != null ? Number(args.maxMessages) : DEFAULT_SNAPSHOT_MAX_MESSAGES,
      },
    });
  },
  { description: 'Read the current wake’s exact task or agreement, governing constraints, dependencies and artifact inventory. No chat is required for task work. For chat wakes, the NEWEST maxMessages of history (chronological order), agreements, participants, and a bounded inventory of readable room artifacts. Artifact bodies are not included: read relevant notes with context_read type=artifacts via=chat:<chatId>, following pagination, before concluding information is missing. Zero direct artifact grants does not mean no readable room notes. Direct grants absent from that room inventory are grantedArtifacts (id and name only); read a body with context_read type=artifacts via=artifact:<id>.' },
);

export const chatSendTool: ToolDefinition = defineTool(
  'chat_send',
  {
    taskId: { type: 'string', description: 'Work task; the backend resolves its governing agreement.' },
    conversationAgreementId: { type: 'string', description: 'The agreement this message is under. In the room you were woken in, leave it out unless you mean a different agreement than this wake. When a send is refused with WORK_SELECTION_REQUIRED, name one of its choices.' },
    underAgreementId: { type: 'string', description: 'Your run authority, defaulting to the current run in every destination room.' },
    chatId: { type: 'string', description: 'Omit this to send in the chat you were woken in — that is the usual case. Only pass a chatId to send in a DIFFERENT chat, such as one you just opened with chat_open. When chatId is set it wins over `to`.' },
    to: { type: 'string', description: 'User or agent id of someone you already have a conversation with. Sends in that pair room. Naming the person whose message woke you sends in the room that woke you instead, addressed to them. Does not open contact — first contact still needs chat_open. Ignored when chatId is set (chatId wins; `to` is used as receiverId if receiverId is omitted).' },
    receiverId: { type: 'string', description: 'Name someone only when you mean them. Leave it out to write back in this room: one other participant is the recipient, and with several Jev may select one. Otherwise the message stays in the room with no specific wake. To name a masked party, pass its rpb_ ref as it came. Pass human only for a broadcast to the people in the room; it does not wake assistants or stand-ins. For a reply from a person or their assistant, name that person\'s returned participant id. This does not grant their assistant access or guarantee a reply.' },
    text: { type: 'string', required: true },
    idempotencyKey: { type: 'string', description: 'Reuse for retry-safe resend of the same logical message.' },
    sources: SOURCES_PARAM,
  },
  async (args, ctx) => {
    const c = ctx as ClaudeSdkToolContext;
    const sources = sourcesArg(args);
    const explicitChatId = asChatLane(firstFilled(args.chatId));
    const to = firstFilled(args.to);
    const text = String(args.text);

    // Naming the person who woke you is an answer, not a new conversation: it
    // goes in the room that woke you, addressed to them. A probe room or a
    // stranger's room has no pair room with that person, and asking the server
    // for one only bought a refusal and a chat_open round trip.
    const wakeChat = asChatLane(firstFilled(c.chatId, c.sessionId));
    const answersWakeSender = !!to && !!wakeChat && to === c.senderId;
    // Existing conversation with a person: resolve their pair room server-side.
    // Does not open contact. An explicit chatId still wins.
    if (!explicitChatId && to && !answersWakeSender) {
      const creds = credsFromToolContext(c, 'chat_send');
      const messageId = args.idempotencyKey
        ? `sdk_idem_${String(args.idempotencyKey)}`
        : c.writeKeys?.messageKey({ text, sessionId: `to:${to}`, receiverId: to }) ?? `sdk_${randomUUID()}`;
      const namedReceiver = firstFilled(args.receiverId);
      const sent = await sendChatMessage(
        {
          to,
          text,
          messageId,
          conversationAgreementId: firstFilled(args.conversationAgreementId),
          underAgreementId: firstFilled(args.underAgreementId, c.serviceAgreementId),
          taskId: firstFilled(args.taskId),
          ...(namedReceiver ? { receiverId: namedReceiver } : {}),
          ...sources,
        },
        creds,
      );
      // Never presented as a send that happened: the message does not exist,
      // so whoever was waiting for it is still waiting. Retrying with the same
      // idempotencyKey is safe — it is the key the backend dedups on, so a
      // resend of the same logical message cannot double-post it.
      if (!sent.success)
        throw new Error(
          'chat_send: the server did not accept this message, so nothing was delivered and nobody was woken. ' +
            'Retry the same send with the same idempotencyKey; if it keeps failing, say so where the work is tracked rather than reporting the answer as sent.',
        );
      return presentSendResult(sent, { creds, surface: 'sdk' });
    }

    if (!c.eff) throw new Error('chat_send requires eff in tool context');
    // Same agreement-id-where-a-chat-id-goes slip as context_snapshot, and the
    // same mapping: an agreement's traffic lane is `agrn-<agreementId>`.
    const sessionId = asChatLane(firstFilled(args.chatId, c.chatId, c.sessionId));
    if (!sessionId) {
      throw new Error(
        'chat_send: this wake carries no chat to send in. Pass chatId of the room, or to naming a person you already have a conversation with (first contact still needs chat_open).',
      );
    }
    const receiverId = firstFilled(args.receiverId, args.to);
    // Default to the wake's content-derived key: a crash-replay that
    // re-sends the same text re-derives the same messageId and the backend drops
    // the duplicate; a re-think with different text gets a new key
    // instead of colliding on a per-wake ordinal. An explicit LLM idempotencyKey
    // still wins (retry-safe resend of the same logical message across wakes);
    // random only when the wake has no durable identity.
    const messageId = args.idempotencyKey
      ? `sdk_idem_${String(args.idempotencyKey)}`
      : c.writeKeys?.messageKey({ text, sessionId, receiverId }) ?? `sdk_${randomUUID()}`;
    return c.eff({
      kind: 'send-message',
      ...(firstFilled(args.taskId) ? { taskId: firstFilled(args.taskId) } : {}),
      ...(firstFilled(args.conversationAgreementId) ? { conversationAgreementId: firstFilled(args.conversationAgreementId) } : {}),
      ...(firstFilled(args.underAgreementId, c.serviceAgreementId) ? { underAgreementId: firstFilled(args.underAgreementId, c.serviceAgreementId) } : {}),
      sessionId,
      ...(receiverId ? { receiverId } : {}),
      text,
      messageId,
      ...sources,
    });
  },
  // This line used to read "Conversation only — never use for
  // finished-work reporting", while the protocol two files over told the agent
  // to send the human its deliverable in chat. One of the two had to be wrong
  // in front of the model on every wake. The protocol is right: a person reads
  // what you did in the room; an agent reads the task result. Chat never
  // REPLACES task_set_result — that is what "reporting" meant here — but for a
  // human counterparty it is the delivery, not a breach of it.
  { description: 'Send a user-visible chat message. This is conversation, and it is how a PERSON receives finished work: when the human who set the goal is your counterparty, send them the deliverable here as well. It is not how another AGENT collects one — that one reads the task result — and it never replaces task_set_result on a task that is open. To reach someone you already talk to, pass to= their user or agent id. First contact still needs chat_open, then chat_send in the chat that returns.' },
);

// Inbox read/ack are deliberately NOT here: the host owns the pull/ack cycle
// (its per-agent inbox long-poll loop). A brain-side ack would race the host's,
// and a per-turn inbox poll fed the tool-operation echo loop.
//
// grant_list IS here: the hosted agent must always be able to answer
// "what grants of mine do you hold?" across every rail. Without the tool an
// agent tells its principal the lookup does not exist. It reads
// operatorKey/agentId straight off the tool context.
//
// task_list IS here: MCP delegates have ziggs_task_list; the hosted
// Claude surface previously had no way to enumerate its own open tasks (reads
// were prompt-injected only). Same GET /tasks capability as the MCP tool.
export { listTasksTool, cancelTaskTool, delegateTaskTool };

export const CLAUDE_SDK_TOOLS: ToolDefinition[] = [
  contextSnapshotTool,
  chatSendTool,
  listGrantsTool,
  listTasksTool,
  cancelTaskTool,
  delegateTaskTool,
  // store-claim providers must open the buyer chat from the default
  // Claude surface (chat_open was tier-2 / email-agent opt-in only).
  ...CHAT_TOOLS,
];
