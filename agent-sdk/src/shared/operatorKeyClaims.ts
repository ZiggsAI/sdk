/**
 * Client-side peek at an operator key. The decoder lives in api-client (it
 * keeps `issuedVia` and ignores a non-string `boundAgentId`, and it does not
 * use Node's Buffer). This file re-exports it and keeps the fleet warning.
 */
import { decodeOperatorKeyClaims } from '@ziggs-ai/api-client';

export { decodeOperatorKeyClaims };
export type { OperatorKeyClaims } from '@ziggs-ai/api-client';

/**
 * The startup check: warn (never refuse — a one-agent launcher on a
 * bound key is legitimate) when the fleet's control key is bound to a single
 * agent while more than one agent is registered. Returns the warning line, or
 * null when the setup is coherent.
 */
export function boundKeyFleetWarning(
  operatorKey: string,
  registeredAgents: number,
): string | null {
  if (registeredAgents <= 1) return null;
  const bound = decodeOperatorKeyClaims(operatorKey)?.boundAgentId;
  if (!bound) return null;
  return (
    `fleet key is bound to agent "${bound}": the operator multiplex covers 1 of ${registeredAgents} registered agents, ` +
    `and per-agent inbox loops for the rest will 403 ("cannot impersonate"). ` +
    `Use an unbound owner key with agents:impersonate to run a fleet.`
  );
}
