import { parseMessageCommand } from '@ziggs-ai/contracts';
import { MESSAGING_CAPABILITIES } from '@ziggs-ai/api-client';
import { toolsFromCapabilities } from '../tools/capabilityAdapter.js';
import { defineTool, type ToolDefinition } from '../tools/defineTool.js';
import { listGrantsTool } from '../platform/tools/tier2/grantsTools.js';
import { cancelTaskTool, listTasksTool, delegateTaskTool } from '../platform/tools/tier2/taskTools.js';
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
  /** Exact work scope of the wake that invoked this tool. */
  serviceAgreementId?: string;
  allowAutomaticMandate?: boolean;
  /** Per-wake id grouping this tick's tool calls in telemetry. Random — never use for idempotency. */
  runId?: string;
  /** Replay-stable write keys for this wake — write tools derive idempotency keys from here, never from the LLM. */
  writeKeys?: DeliveryWriteKeys;
  /** Hire-partitioned memory for this wake. Notes written here stay in this hire. */
  memory?: MemoryStore;
}

// Optional message history stays bounded; deeper history is an explicit read.
const DEFAULT_SNAPSHOT_MAX_MESSAGES = 12;

/** Blank selectors do not replace the current wake's exact resource scope. */
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
    agreementId: { type: 'string', description: 'Read this explicit work agreement.' },
    taskId: { type: 'string', description: 'Read this explicit task.' },
    messageId: { type: 'string', description: 'Read this exact message without a saved address or work agreement.' },
    artifactId: { type: 'string', description: 'Read this exact artifact context.' },
    includeHistory: { type: 'boolean', description: 'Message wakes include bounded conversation context by default. Set false to read only the trigger. Set true to include optional message history for a task or agreement without a message trigger.' },
    maxMessages: { type: 'number', description: `Message history cap (default ${DEFAULT_SNAPSHOT_MAX_MESSAGES}). Pass a larger value when you need deeper history.` },
  },
  async (args, ctx) => {
    const c = ctx as ClaudeSdkToolContext;
    if (!c.eff) throw new Error('context_snapshot requires eff in tool context');
    const messageId = firstFilled(args.messageId);
    const artifactId = firstFilled(args.artifactId);
    const agreementId = firstFilled(args.agreementId), taskId = firstFilled(args.taskId);
    if ((messageId || artifactId) && [messageId, artifactId, agreementId, taskId].filter(Boolean).length > 1)
      throw new Error('context_snapshot: select one exact message or artifact, independently of work selection');
    if ('addressId' in args) throw new Error('context_snapshot: addressId is not supported; select a message, artifact, task or agreement');
    // The effect's session routes it: the wake's own lane reads the wake's
    // destination; anything named is read as named, never as a lane.
    const sessionId = firstFilled(messageId, artifactId, taskId, agreementId, c.sessionId);
    if (!sessionId) {
      throw new Error(
        'context_snapshot: no selected resource. Name messageId, artifactId, taskId or agreementId, or use the current wake.',
      );
    }
    return c.eff({
      kind: 'read-context',
      sessionId,
      opts: {
        ...(typeof args.includeHistory === 'boolean' ? { includeHistory: args.includeHistory } : {}),
        maxMessages: args.maxMessages != null ? Number(args.maxMessages) : DEFAULT_SNAPSHOT_MAX_MESSAGES,
        ...(messageId || artifactId ? {
          via: messageId ? `message:${messageId}` : `artifact:${artifactId}`,
          workScopes: [{ messageId, artifactId }],
        } : agreementId || taskId ? {
          via: taskId ? `task:${taskId}` : `agreement:${agreementId}`,
          workScopes: [{ agreementId, taskId }],
        } : {}),
      },
    });
  },
  { description: 'Read the current wake or an explicit message, artifact, task or agreement, including governing constraints, dependencies and permitted artifact inventory. Optional message history is bounded by maxMessages. Artifact bodies are not included: follow the returned exact artifact or work readPlan with context_read. Snapshot and history reads preserve selected-work authority; an unrelated session or conversation grants no access.' },
);

export const messageSendTool: ToolDefinition = defineTool(
  'message_send',
  { command: { type: 'object', required: true, description: 'Canonical MessageCommand: operationId, content, audience, deliveries, intent (fyi or request) and optional mandate, relationships and exact sources.' } },
  async (args, ctx) => {
    const c = ctx as ClaudeSdkToolContext;
    if (!c.eff || !c.sessionId) throw new Error('message_send requires the current host context');
    return c.eff({ kind: 'send-message', sessionId: c.sessionId, command: parseMessageCommand(args.command) });
  },
  { description: 'Send one canonical message. Readers, deliveries and intent are explicit. intent request wakes the agents it reaches; intent fyi is filed and never wakes anyone. A reply is a message with relationships.replyToMessageId; nothing records whether a request was answered; task results remain task operations. No room required.' },
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
];
