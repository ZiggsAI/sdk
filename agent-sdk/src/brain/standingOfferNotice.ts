import { SERVER_EVENTS } from '@ziggs-ai/contracts';
import { isBroadcastTarget } from '@ziggs-ai/api-client';
import { getBatchEvents } from '../context/batch.js';
import type { RawEvent } from '../runtime/buildOutcome.js';

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordLike : null;
}

function agreementEventIds(event: RawEvent | undefined): string[] {
  const resource = record(event?.resource);
  const result = record(event?.result);
  const candidates = [
    resource?.agreementId,
    resource?.kind === 'agreement' ? resource.resourceId : undefined,
    event?.agreementId,
    result?.agreementId,
  ];
  return [...new Set(candidates.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

export function agreementEventId(event: RawEvent | undefined): string | undefined {
  const ids = agreementEventIds(event);
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * Provider acceptance leaves a standing listing OPEN with its buyer slot still
 * a broadcast. It is not a customer hire. Check the full authoritative row;
 * /status, event actor ids and the word "approved" cannot prove this shape.
 */
export function isOwnUnclaimedStandingOffer(value: unknown, agreementId: string, agentId: string): boolean {
  const row = record(value);
  const parties = record(row?.parties);
  const payer = record(parties?.payer);
  const provider = record(parties?.provider);
  return row?.agreementId === agreementId &&
    row.status === 'open' &&
    row.providerPinned === true &&
    provider?.actor === agentId &&
    typeof payer?.principal === 'string' &&
    isBroadcastTarget(payer.principal);
}

/** Remove only proven listing-acceptance notices; mixed batches keep all real work. */
export async function filterStandingOfferNotices(
  event: RawEvent | undefined,
  agentId: string,
  readAgreement: (agreementId: string) => Promise<unknown>,
): Promise<{ event: RawEvent | undefined; ignoredAgreementIds: string[] }> {
  const events = getBatchEvents(event) as RawEvent[];
  const retained: RawEvent[] = [];
  const ignoredAgreementIds: string[] = [];
  const reads = new Map<string, Promise<unknown>>();
  for (const item of events) {
    const resource = record(item?.resource);
    const reason = resource?.reason ?? item?.reason;
    const id = agreementEventId(item);
    if (item?.type === SERVER_EVENTS.resourceChanged && resource?.kind === 'agreement' &&
        (reason === 'approval:approved' || reason === 'proposal_approved') && id) {
      // Inconclusive reads preserve the wake. An unavailable read must not eat
      // a legitimate customer hire or the answer to an agent's own request.
      if (!reads.has(id)) reads.set(id, Promise.resolve().then(() => readAgreement(id)).catch(() => null));
      if (isOwnUnclaimedStandingOffer(await reads.get(id), id, agentId)) {
        ignoredAgreementIds.push(id);
        continue;
      }
    }
    retained.push(item);
  }
  if (ignoredAgreementIds.length === 0) return { event, ignoredAgreementIds };
  return {
    event: retained.length === 0 ? undefined
      : retained.length === 1 ? retained[0] : { ...event, events: retained },
    ignoredAgreementIds,
  };
}
