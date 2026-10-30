import type { WorkExecutionContext } from '@ziggs-ai/contracts';
type AssistantHints = {
  executionContext?: WorkExecutionContext;
  executionContextId?: string;
  orgId?: string;
  resource?: string;
  clientSessionId?: string;
  instanceId?: string;
  workspaceIds?: string;
  app?: string;
  sessionName?: string;
};
type AssistantContext = {run<T>(hints: AssistantHints, fn: () => T): T; getStore(): AssistantHints | undefined};
let assistantRequest: AssistantContext | undefined;
let assistantContextLoading: Promise<AssistantContext> | undefined;
/** Node-only, opt-in request context. Ordinary HTTP clients remain browser-safe. */
export async function withAssistantRequest<T>(hints: AssistantHints, run: () => T): Promise<Awaited<T>> {
  assistantContextLoading ??= import('node:async_hooks').then(({AsyncLocalStorage}) => {
    assistantRequest = new AsyncLocalStorage<AssistantHints>();
    return assistantRequest;
  });
  const context = await assistantContextLoading;
  // A workspace router adds its per-operation target inside the caller's
  // session. Preserve that session without sharing it between concurrent calls.
  return await context.run({ ...context.getStore(), ...hints, orgId: hints.orgId, resource: hints.resource }, run);
}
export function assistantRequestHeaders(): Record<string, string> {
  const hints = assistantRequest?.getStore();
  return {
    ...((hints?.executionContextId ?? hints?.executionContext?.contextId) ? { 'X-Ziggs-Execution': (hints?.executionContextId ?? hints?.executionContext?.contextId)! } : {}),
    ...(hints?.orgId ? {'X-Workspace-Id': hints.orgId} : {}),
    ...(hints?.resource ? {'X-Ziggs-Resource': hints.resource} : {}),
    ...(hints?.clientSessionId ? {'X-Ziggs-Session': hints.clientSessionId} : {}),
    ...(hints?.instanceId ? {'X-Ziggs-Instance': hints.instanceId} : {}),
    ...(hints?.workspaceIds ? {'X-Ziggs-Workspaces': hints.workspaceIds} : {}),
    ...(hints?.app ? {'X-Ziggs-App': hints.app} : {}),
    ...(hints?.sessionName ? {'X-Ziggs-Session-Name': hints.sessionName} : {}),
  };
}
/** A presentation routing key; it carries no authority. */
export function laneUnderAgreement(laneId: string, agreementId?: string | null): string {
  if (!agreementId || laneId.startsWith('agrn-') || laneId.includes('@')) return laneId;
  return `${laneId}@${agreementId}`;
}

export function buildOperatorHeaders(
  operatorKey: string,
  agentId?: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Authorization: `Bearer ${operatorKey}`,
    ...assistantRequestHeaders(),
    // `X-Agent-Id` is only sent when an agentId is present — agent-scoped keys
    // identify the agent themselves; fleet keys must pass one.
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
    ...extra,
  };
}

/**
 * The host's own calls (wake gate, telemetry, tool picker) are not work
 * actions: they never carry the selected execution, so they neither need a
 * route that supports one nor record anything into it.
 */
export function withoutExecution(headers: Record<string, string>): Record<string, string> {
  const out = { ...headers };
  delete out['X-Ziggs-Execution'];
  delete out['x-ziggs-execution'];
  return out;
}

/** What a `Creds`-shaped client sends on a JSON call: auth, agent, lane. */
export function buildCredsHeaders(creds: {
  operatorKey: string;
  agentId: string;
  laneId?: string;
  executionContextId?: string;
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(creds.executionContextId ? { 'X-Ziggs-Execution': creds.executionContextId } : {}),
    ...buildOperatorHeaders(creds.operatorKey, creds.agentId),
  };
}

/** Async-local scope: parallel agreement positions never share request headers. */
export async function withWorkExecution<T>(executionContext: WorkExecutionContext | undefined, run: () => T): Promise<Awaited<T>> {
  return withAssistantRequest({ ...assistantRequest?.getStore(), executionContext, executionContextId: executionContext?.contextId }, run);
}
export function currentWorkExecution(): WorkExecutionContext | undefined {
  return assistantRequest?.getStore()?.executionContext;
}

export async function withWorkExecutionId<T>(executionContextId: string | undefined, run: () => T): Promise<Awaited<T>> {
  return withAssistantRequest({ ...assistantRequest?.getStore(), executionContextId: executionContextId ?? assistantRequest?.getStore()?.executionContextId }, run);
}
