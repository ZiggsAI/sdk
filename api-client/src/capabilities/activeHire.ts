import {
  AGREEMENT_ENGAGEMENT_KIND,
  isBroadcastTarget,
  type Agreement,
} from '../types.js';

/** One live hire of an agent, as a search row names it. */
export interface ActiveHire {
  agreementId: string;
  /** The workspace the payer bought it in. Null when the row records none. */
  workspace: string | null;
}

type HireRow = Agreement & { payerLane?: string | null };

/**
 * Active hires whose provider is this agent.
 *
 * A listing is not a hire: its payer is still a broadcast. A link and a
 * membership are not hires either. `service` stays, because older hires
 * were written as services with a named payer.
 */
export function activeHiresForAgent(
  agentId: string,
  agreements: readonly HireRow[],
): ActiveHire[] {
  if (!agentId) return [];
  const hires: ActiveHire[] = [];
  for (const row of agreements) {
    if (row.status !== 'active') continue;
    if (
      row.engagementKind !== AGREEMENT_ENGAGEMENT_KIND.HIRE &&
      row.engagementKind !== AGREEMENT_ENGAGEMENT_KIND.SERVICE
    ) {
      continue;
    }
    if (row.parties?.provider?.actor !== agentId) continue;
    const payer = row.parties?.payer?.principal;
    if (typeof payer === 'string' && isBroadcastTarget(payer)) continue;
    hires.push({
      agreementId: row.agreementId,
      workspace: row.payerLane ?? null,
    });
  }
  return hires;
}
