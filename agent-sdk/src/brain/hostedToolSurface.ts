/**
 * What the hosted Claude brain mounts into the model.
 *
 * Every tool the agent has is mounted with its own schema. Everyday SDK tools
 * and the agent's own tools load on every wake; every other Ziggs platform
 * tool is deferred, and the Agent SDK's tool search loads its schema when the
 * model looks for it. The model sees each tool by its own name and calls it
 * directly — there is no catalog to read and no dispatcher in between, so the
 * host's per-tool permission and the trace name the real tool.
 */
import { EVERYDAY_SDK_TOOLS, annotationForSdkTool } from '@ziggs-ai/api-client';
import { toolName, type ToolDefinition } from '../tools/defineTool.js';

type Lane = 'read-only' | 'write' | 'destructive';

/**
 * Platform tools written by hand, not as a shared capability. A name here is
 * a platform name, so it is deferred unless it is in the everyday set.
 */
const HAND_LANE: Record<string, Lane> = {
  context_snapshot: 'read-only',
  // Sends, commitments, overwrites, cancellations and revocations are
  // destructive; only private additive writes are plain writes.
  chat_send: 'destructive',
  wake_at: 'write',
  agreement_propose: 'destructive',
  agreement_subcontract: 'destructive',
  agreement_respond: 'destructive',
  agreement_counter: 'destructive',
  agreement_get: 'read-only',
  agreement_revoke: 'destructive',
  agreement_fulfill: 'destructive',
  task_set_result: 'destructive',
  task_update_plan_step: 'destructive',
  task_create: 'write',
  task_replace_plan: 'destructive',
  mcp_tools_list: 'read-only',
  mcp_tool_call: 'destructive',
  connection_list_grants: 'read-only',
};

const EVERYDAY = new Set<string>(EVERYDAY_SDK_TOOLS);

export function hostedToolLane(name: string): Lane {
  const hand = HAND_LANE[name];
  if (hand) return hand;
  const annotation = annotationForSdkTool(name);
  if (annotation === 'read-only' || annotation === 'destructive') return annotation;
  return 'write';
}

function isPlatform(name: string): boolean {
  return name in HAND_LANE || annotationForSdkTool(name) !== undefined;
}

/**
 * A Ziggs platform tool whose schema loads when the model searches for it,
 * rather than on every wake. Everyday tools and the agent's own tools are
 * never deferred.
 */
export function isHostedDeferred(name: string): boolean {
  return isPlatform(name) && !EVERYDAY.has(name);
}

/**
 * The tools the hosted model is offered: every registered tool, each by its
 * own name and schema. Which of them load up front is `isHostedDeferred`.
 */
export function hostedModelTools(all: ToolDefinition[]): ToolDefinition[] {
  const seen = new Set<string>();
  const out: ToolDefinition[] = [];
  for (const tool of all) {
    const name = toolName(tool);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(tool);
  }
  return out;
}
