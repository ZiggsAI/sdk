type AssistantHints = {
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
    ...(hints?.orgId ? {'X-Workspace-Id': hints.orgId} : {}),
    ...(hints?.resource ? {'X-Ziggs-Resource': hints.resource} : {}),
    ...(hints?.clientSessionId ? {'X-Ziggs-Session': hints.clientSessionId} : {}),
    ...(hints?.instanceId ? {'X-Ziggs-Instance': hints.instanceId} : {}),
    ...(hints?.workspaceIds ? {'X-Ziggs-Workspaces': hints.workspaceIds} : {}),
    ...(hints?.app ? {'X-Ziggs-App': hints.app} : {}),
    ...(hints?.sessionName ? {'X-Ziggs-Session-Name': hints.sessionName} : {}),
  };
}
/**
 * Auth headers for operator-key HTTP clients.
 *
 * ONE place builds them, because the lane is the header a caller cannot be
 * trusted to remember. Omitting `X-Ziggs-Lane` never fails: the server fences
 * the wake to the agent's own org instead, so a door that forgets it answers
 * short lists and refuses grants the agent's customer gave it — silently, and
 * only for the agents that serve someone other than their owner. A header
 * whose absence is indistinguishable from a legitimate answer has to be built
 * in one place, not copied into each caller.
 */

/** The header the backend's wake fence reads (`access/wake-fence.ts`). */
export const WAKE_LANE_HEADER = 'X-Ziggs-Lane';

/**
 * The header naming the agreement a room wake works under. The backend takes
 * it only for an agreement the agent has mail under in that room, and reads
 * it off that mail when it is absent.
 */
export const WAKE_AGREEMENT_HEADER = 'X-Ziggs-Agreement';

/**
 * A room lane that also names the agreement the wake works under:
 * `<chatId>@<agreementId>`. Every client already carries the lane to
 * {@link laneHeader}, so the agreement travels with it without a second
 * parameter on each of them. An `agrn-` lane already is its agreement.
 */
export function laneUnderAgreement(laneId: string, agreementId?: string | null): string {
  if (!agreementId || laneId.startsWith('agrn-') || laneId.includes('@')) return laneId;
  return `${laneId}@${agreementId}`;
}

/**
 * The lane headers, or nothing. `laneId` is a chat id, `agrn-<agreementId>`
 * for a task with no origin chat, or a chat id with the agreement the wake
 * works under (`<chatId>@<agreementId>`, see {@link laneUnderAgreement}).
 */
export function laneHeader(laneId?: string): Record<string, string> {
  if (!laneId) return {};
  const at = laneId.indexOf('@');
  if (at <= 0) return { [WAKE_LANE_HEADER]: laneId };
  return {
    [WAKE_LANE_HEADER]: laneId.slice(0, at),
    [WAKE_AGREEMENT_HEADER]: laneId.slice(at + 1),
  };
}

export function buildOperatorHeaders(
  operatorKey: string,
  agentId?: string,
  extra?: Record<string, string>,
  /**
   * the lane this call belongs to, sent as `X-Ziggs-Lane`. The
   * backend narrows the wake's reach to the engagement's orgs; omitting it
   * narrows to the agent's own org, so it can never widen reach.
   */
  laneId?: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${operatorKey}`,
    ...assistantRequestHeaders(),
    // `X-Agent-Id` is only sent when an agentId is present — agent-scoped keys
    // identify the agent themselves; fleet keys must pass one.
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
    ...laneHeader(laneId),
    ...extra,
  };
}

/** What a `Creds`-shaped client sends on a JSON call: auth, agent, lane. */
export function buildCredsHeaders(creds: {
  operatorKey: string;
  agentId: string;
  laneId?: string;
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...buildOperatorHeaders(creds.operatorKey, creds.agentId, undefined, creds.laneId),
  };
}
