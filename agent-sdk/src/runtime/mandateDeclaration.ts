import type { ToolManager } from '../tools/ToolManager.js';

/**
 * Fill in the job an agent is working inside, so it does not have to.
 *
 * The consent gate excuses an agreement an agent forms INSIDE a job its human
 * already approved, and it verifies the claim server-side. What was missing was
 * the claim itself: nothing on the agent surface said "I am doing this as part
 * of job X", so every engagement an agent formed arrived as an outsider and
 * waited on a human — including buying the help the job it was hired for needs.
 *
 * The declaration is made at the CALLER, never resolved on the server: the
 * agreements module must not read the tasks module, and a guessed mandate is a
 * false claim the termination cascade would act on destructively. Here the fact
 * is free — the runtime already knows which task this wake is executing and
 * which agreement that task runs under, which is exactly the answer.
 *
 * The model can still name a job itself (and does, when it is working on
 * something other than its assigned task). An explicit value is never
 * overwritten, including an explicit empty string, which reads as "this belongs
 * to no job" — the difference between saying nothing and saying none.
 */

/**
 * The parameter a tool uses to carry the declaration.
 *
 * Two names, because the doors differ and each name is true at its own door: on
 * a tool that CREATES an agreement the job becomes that row's parent, so the
 * field is the parent id; on a tool that claims a row somebody else posted
 * nothing is re-parented — the lineage stays with the publisher — and the job is
 * only an authority. Listed together here so the runtime has one place that
 * knows both, rather than a name test at each call site.
 */
const MANDATE_PARAM_NAMES = ['mandateAgreementId', 'parentAgreementId'] as const;

/** The mandate parameter this tool declares, if it declares one. */
function mandateParamOf(
  toolName: string | null | undefined,
  toolManager: ToolManager | undefined,
  allowSpendingMandate = true,
): string | null {
  if (!toolName) return null;
  const schema = toolManager?.getTool?.(toolName)?.schema as
    | { function?: { parameters?: { properties?: Record<string, unknown> } } }
    | undefined;
  const properties = schema?.function?.parameters?.properties;
  if (!properties) return null;
  for (const name of (allowSpendingMandate ? MANDATE_PARAM_NAMES : ['parentAgreementId'] as const)) {
    if (Object.prototype.hasOwnProperty.call(properties, name)) return name;
  }
  return null;
}

/**
 * Add the wake's own mandate to a tool call that declares one and left it blank.
 *
 * Returns the args unchanged whenever there is nothing to say: the tool takes no
 * declaration, the model already made one, or this wake is not running inside a
 * job at all.
 */
export function withDeclaredMandate(
  args: Record<string, unknown>,
  toolName: string | null | undefined,
  toolManager: ToolManager | undefined,
  activeAgreementId: string | null | undefined,
  allowSpendingMandate = true,
): Record<string, unknown> {
  if (!activeAgreementId) return args;
  const param = mandateParamOf(toolName, toolManager, allowSpendingMandate);
  if (!param) return args;
  if (args[param] !== undefined) return args;
  return { ...args, [param]: activeAgreementId };
}
