import { isBroadcastTarget, partyActorIds, type AgreementParties } from '@ziggs-ai/api-client';

export function getBatchEvents(rawEvent: unknown): unknown[] {
  if (!rawEvent) return [];
  const e = rawEvent as Record<string, unknown>;
  if (e['type'] === 'batch' && Array.isArray(e['events'])) return e['events'] as unknown[];
  return [rawEvent];
}

export function isTaskResultRelevantToAgent(result: Record<string, unknown>, ownAgentId: string | null): boolean {
  if (!ownAgentId) return true;
  const parties = partiesOf(result);
  return !!(
    result['creatorIsYou'] || result['providerIsYou'] || result['payerIsYou'] || result['proposedToIsYou'] ||
    partyActorIds(parties).includes(ownAgentId) ||
    isBroadcastTarget(parties?.proposedTo?.principal)
  );
}

/** The agreement's party slots on a task_result payload, when it carries one. */
export function partiesOf(result: Record<string, unknown>): AgreementParties | undefined {
  return (result['agreement'] as { parties?: AgreementParties } | undefined)?.parties;
}
