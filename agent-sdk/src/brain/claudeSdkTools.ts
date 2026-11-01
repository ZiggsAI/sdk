import { parseMessageCommand } from '@ziggs-ai/contracts';
import { MESSAGING_CAPABILITIES } from '@ziggs-ai/api-client';
import { toolsFromCapabilities } from '../tools/capabilityAdapter.js';
import { defineTool, type ToolDefinition } from '../tools/defineTool.js';
import { listGrantsTool } from '../platform/tools/tier2/grantsTools.js';
import { cancelTaskTool, listTasksTool, delegateTaskTool } from '../platform/tools/tier2/taskTools.js';
import { CHAT_TOOLS } from '../platform/tools/tier2/chatTools.js';
import type { EffectHandler, DeliveryWriteKeys } from '../types.js';
import type { MemoryStore } from '../memory/MemoryStore.js';

export interface ClaudeSdkToolContext extends Record<string, unknown> {
  operatorKey: string;
  agentId: string;
  addressId?: string | null;
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
 * than omitting it — the schema shows `addressId`, the agent has no way to know it,
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

// Named distinctly from ziggs-mcp's per-type `ziggs_context_read`: this is the
// one-shot aggregate snapshot (grant-fenced server-side), not a cursored read.
export const contextSnapshotTool: ToolDefinition = defineTool(
  'context_snapshot',
  {
    addressId: { type: 'string', description: 'Omit this to snapshot the chat you were woken in — that is the usual case, and you do not need to know its id. Only pass a addressId for a different shared conversation. For agreement work, pass agreementId or taskId explicitly.' },
    agreementId: { type: 'string', description: 'Read this explicit work agreement.' },
    taskId: { type: 'string', description: 'Read this explicit task.' },
    messageId: { type: 'string', description: 'Read this exact message without a saved address or work agreement.' },
    artifactId: { type: 'string', description: 'Read this exact artifact context.' },
    includeHistory: { type: 'boolean', description: 'Include optional work message history. Task/work context does not require it; the exact triggering message is read independently.' },
    maxMessages: { type: 'number', description: `Message history cap (default ${DEFAULT_SNAPSHOT_MAX_MESSAGES}). Pass a larger value when you need deeper history.` },
  },
  async (args, ctx) => {
    const c = ctx as ClaudeSdkToolContext;
    if (!c.eff) throw new Error('context_snapshot requires eff in tool context');
    const messageId = firstFilled(args.messageId);
    const artifactId = firstFilled(args.artifactId);
    if ((messageId || artifactId) && [messageId, artifactId, firstFilled(args.addressId), firstFilled(args.agreementId), firstFilled(args.taskId)].filter(Boolean).length > 1)
      throw new Error('context_snapshot: select one exact message or artifact, independently of work and address selection');
    const addressId = firstFilled(args.addressId);
    // The effect's session routes it: the wake's own lane reads the wake's
    // destination; anything named is read as named, never as a lane.
    const sessionId = firstFilled(addressId, messageId, artifactId, args.taskId, args.agreementId, c.sessionId);
    if (!sessionId) {
      throw new Error(
        'context_snapshot: no selected resource. Name messageId, artifactId, taskId, agreementId or addressId, or use the current wake.',
      );
    }
    return c.eff({
      kind: 'read-context',
      sessionId,
      opts: {
        ...(addressId ? { addressId } : {}),
        includeHistory: args.includeHistory === true,
        maxMessages: args.maxMessages != null ? Number(args.maxMessages) : DEFAULT_SNAPSHOT_MAX_MESSAGES,
        ...(messageId || artifactId ? {
          via: messageId ? `message:${messageId}` : `artifact:${artifactId}`,
          workScopes: [{ messageId, artifactId }],
        } : args.agreementId || args.taskId ? {
          via: args.taskId ? `task:${String(args.taskId)}` : `agreement:${String(args.agreementId)}`,
          workScopes: [{ agreementId: firstFilled(args.agreementId), taskId: firstFilled(args.taskId) }],
        } : {}),
      },
    });
  },
  { description: 'Read the current wake or an explicit message, artifact, task or agreement, governing constraints, dependencies and artifact inventory. No chat is required for task work. For chat wakes, the NEWEST maxMessages of history (chronological order), agreements, participants, and a bounded inventory of readable room artifacts. Artifact bodies are not included: read relevant notes with context_read type=artifacts via=address:<addressId>, following pagination, before concluding information is missing. Zero direct artifact grants does not mean no readable room notes. Direct grants absent from that room inventory are grantedArtifacts (id and name only); read a body with context_read type=artifacts via=artifact:<id>.' },
);

export const messageSendTool: ToolDefinition = defineTool(
  'message_send',
  { command: { type: 'object', required: true, description: 'Canonical MessageCommand: operationId, content, audience, deliveries, effect and optional mandate, relationships and exact sources.' } },
  async (args, ctx) => {
    const c = ctx as ClaudeSdkToolContext;
    if (!c.eff || !c.sessionId) throw new Error('message_send requires the current host context');
    return c.eff({ kind: 'send-message', sessionId: c.sessionId, command: parseMessageCommand(args.command) });
  },
  { description: 'Send one canonical message. Readers, deliveries and answer effects are explicit. A reply link alone does not complete an answer request. Use the exact answer action to answer; task results remain task operations. No room required.' },
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
  messageSendTool,
  listGrantsTool,
  listTasksTool,
  cancelTaskTool,
  delegateTaskTool,
  ...toolsFromCapabilities(MESSAGING_CAPABILITIES),
  // store-claim providers must open the buyer chat from the default
  // Claude surface (chat_open was tier-2 / email-agent opt-in only).
  ...CHAT_TOOLS,
];
