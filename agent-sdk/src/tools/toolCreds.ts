/**
 * toolCreds.ts — the credentials a tool acts under, read off its own context.
 *
 * A custom tool builds `{ operatorKey, agentId }` by hand and stops there, so
 * every call it makes runs on the narrowest reach fence there is: the agent's
 * own org. `Agent` already threads the wake's lane into the tool context
 * (as `chatId` / `sessionId`, which is what the capability adapter reads), and
 * the backend's fence is "own org ∪ the orgs of the parties to this lane" — so
 * a tool that does not pass it loses reach it is entitled to, and loses it
 * SILENTLY: enumerations come back short rather than refused.
 *
 * Measured on a five-node graph run: a coordinator asking which tasks it had
 * created saw 0 of 5 with no lane and 5 of 5 with its own lane declared. The
 * `task_list({ createdByMe: true })` convergence check that `lab-hirer`'s prompt
 * recommends would therefore answer "nothing yet" and rebuild the whole graph,
 * billing every worker twice.
 *
 * So: one reader, used by every tool, rather than a field each author has to
 * remember. Omitting the lane can only narrow reach, never widen it, which is
 * why forgetting it never fails loudly.
 */

import { laneUnderAgreement, type Creds } from '@ziggs-ai/api-client';

/** The loose bag `defineTool` hands a handler. */
type ToolContext = Record<string, unknown> | undefined | null;

const str = (ctx: ToolContext, key: string): string | undefined => {
  const value = ctx?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
};

/**
 * The wake's lane, as the backend's `X-Ziggs-Lane` expects it: a chat id, or
 * `agrn-<agreementId>` for an agreement lane. Undefined when the tool is
 * running outside any lane (a bootstrap sweep, a test), which the fence reads
 * as "own org only".
 *
 * A room wake that handles mail under an agreement (`wakeAgreementId`, taken
 * from the delivery itself) names it too, so the backend scopes the wake to
 * that agreement rather than inferring it from the room's mail.
 */
export function laneFromToolContext(ctx: ToolContext): string | undefined {
  const lane = str(ctx, 'chatId') ?? str(ctx, 'sessionId');
  return lane ? laneUnderAgreement(lane, str(ctx, 'wakeAgreementId')) : undefined;
}

/**
 * The creds a tool should act under. Throws when the context is missing what a
 * call needs, rather than building something that 401s later somewhere else.
 */
export function credsFromToolContext(ctx: ToolContext, toolName?: string): Creds {
  const where = toolName ? `${toolName}: ` : '';
  const operatorKey = str(ctx, 'operatorKey');
  if (!operatorKey) throw new Error(`${where}operatorKey missing from tool context`);
  const agentId = str(ctx, 'agentId');
  if (!agentId) throw new Error(`${where}agentId missing from tool context`);
  const laneId = laneFromToolContext(ctx);
  return { operatorKey, agentId, ...(laneId ? { laneId } : {}) };
}
