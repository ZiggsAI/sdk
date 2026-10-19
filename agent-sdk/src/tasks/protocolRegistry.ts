/**
 * The protocol verbs and the state operation each one performs.
 *
 * This is the single place the set is written down. It used to be
 * restated: the tool definitions passed their operation string to `handlerFor`
 * by hand, and this table listed them again. `agreement_fulfill` was in the
 * first list and not the second, so it dispatched fine but
 * `isProtocolToolName` said no — and at every consumer (applyEffects,
 * routingLabels, buildOutcome) the verb that ends an engagement permanently
 * degraded to an unlabelled plain tool-result whose outcome never reached
 * context.
 *
 * A protocol tool now takes its handler from this table BY TOOL NAME, and a
 * name that is absent throws while the module is loading. Adding a verb in one
 * place can no longer half-register it: the tool cannot be constructed at all
 * until it appears here.
 *
 * This module deliberately imports nothing. It is read from the context and
 * runtime paths, which must not pull in the server tool chain.
 */
export const PROTOCOL_TOOL_TO_OPERATION = Object.freeze({
  agreement_propose:     'agreement-propose',
  agreement_subcontract: 'agreement-subcontract',
  agreement_respond:     'agreement-respond',
  agreement_claim:       'agreement-claim',
  agreement_counter:     'agreement-counter-proposal',
  agreement_get:         'agreement-check-proposal',
  agreement_revoke:      'agreement-revoke',
  agreement_fulfill:     'agreement-fulfill',
  task_create:           'task-spawn',
  task_set_result:       'task-update',
  task_update_plan_step: 'task-update-plan-step',
} as const);

export type ProtocolToolName = keyof typeof PROTOCOL_TOOL_TO_OPERATION;
export type ProtocolOperation = (typeof PROTOCOL_TOOL_TO_OPERATION)[ProtocolToolName];

export const PROTOCOL_TOOL_NAMES = Object.freeze(Object.keys(PROTOCOL_TOOL_TO_OPERATION)) as readonly ProtocolToolName[];

export function mapProtocolToolToOperation(toolName: string): ProtocolOperation | null {
  if (!toolName || typeof toolName !== 'string') return null;
  return (PROTOCOL_TOOL_TO_OPERATION as Record<string, ProtocolOperation>)[toolName] ?? null;
}

export function isProtocolToolName(toolName: string): toolName is ProtocolToolName {
  return mapProtocolToolToOperation(toolName) != null;
}

/**
 * The operation a protocol tool performs, or a throw. Called at module load by
 * the tool definitions, so a verb defined without a registry entry takes the
 * import down instead of shipping half-registered.
 */
export function requireProtocolOperation(toolName: string): ProtocolOperation {
  const operation = mapProtocolToolToOperation(toolName);
  if (!operation) {
    throw new Error(
      `Unknown protocol tool "${toolName}": add it to PROTOCOL_TOOL_TO_OPERATION ` +
        '(agent-sdk/src/tasks/protocolRegistry.ts). Every consumer of the protocol ' +
        'set reads that table — a tool missing from it dispatches but is never ' +
        'recognised as protocol, so its result never reaches context.',
    );
  }
  return operation;
}
