import { marketplaceFormation } from '../engagementGuide.js';
import { pullOffersPage, pullRequests } from '../http/MarketplaceClient.js';
import { type CapabilityDefinition, type CapabilityEnv, fullCreds } from './types.js';
import { nextCall } from './nextCall.js';
import { BROADCAST_TARGETS } from '../types.js';
import { LIST_FIELDS_PARAM, listedFieldNote, parseListFields, pickListedRows } from './listedFields.js';

const VIEW_KINDS = ['all', 'requests', 'offers'] as const;

function publishHint(env: CapabilityEnv): string {
  const claim = env.surface === 'mcp' ? 'ziggs_agreement_claim' : 'agreement_claim';
  const publish =
    env.surface === 'mcp'
      ? 'Post a request with ziggs_agreement_request (claimer works, you pay). A standing listing is published by a person or the deploy.'
      : 'Post a request via agreement_propose with proposedTo "everyone"/"org"/"company" and no providerId. A standing listing is published by a person or the deploy.';
  return (
    `Reuse an active agreement that already covers the work. Otherwise claim any row with ${claim} ` +
    `(agreementId) — listings are take-it-or-leave-it, never counter one. ${publish}`
  );
}

/** A broadcast sentinel in a party slot means "open", not a counterparty. */
const BROADCASTS = new Set<string>(BROADCAST_TARGETS);
const named = (id: unknown): string | undefined =>
  typeof id === 'string' && id && !BROADCASTS.has(id) ? id : undefined;

/**
 * One listing, as a browser needs to read it.
 *
 * A whole agreement document is around 30 fields and ~2KB per row, so a default
 * page of 20 is 40KB of context spent mostly on storage bookkeeping — internal
 * versioning, content hashes, write provenance, approval and lane bookkeeping —
 * none of which helps anyone decide whether to claim. This projection is what the
 * decision actually needs: what the work is, who does it, what it costs, on what
 * terms, and the id to claim it with.
 *
 * Deliberately no `raw` escape hatch. The full document is one `agreement_get`
 * away for the row you chose, and an escape hatch here would just restore the
 * cost for every row you did not.
 */
export function toListingRow(a: Record<string, any>, kind: 'request' | 'offer') {
  const terms = a?.terms ?? {};
  const parties = a?.parties ?? {};
  const requiredConnections = terms.requiredConnections ?? [];
  return {
    agreementId: a?.agreementId,
    kind,
    description: terms.description ?? '',
    price: a?.money?.price ?? 0,
    priceUnit: 'hundredths of a point',
    // What that price MEANS: a whole-engagement total, or a rate charged per
    // completed task. Omitting it left a metered standing hire indistinguishable
    // from a flat-priced one at the moment a caller decides to claim, and
    // `per_task` is the default for a hire. Absent on rows written before the
    // field existed, which read as `total`.
    ...(terms.billing ? { billing: terms.billing } : {}),
    engagementKind: a?.engagementKind,
    lifecycle: terms.lifecycle,
    ...(terms.expiresAt ? { expiresAt: terms.expiresAt } : {}),
    ...(terms.conversationAllowance !== undefined ? { conversationAllowance: terms.conversationAllowance } : {}),
    ...(terms.maxExecutions != null ? { maxExecutions: terms.maxExecutions } : {}),
    // Who does the work on an offer, who is paying on a request. The other slot is
    // the open one you would be filling by claiming, so it carries no name yet.
    ...(named(parties.provider?.actor) ? { providerAgent: parties.provider.actor } : {}),
    ...(named(parties.provider?.principal) ? { provider: parties.provider.principal } : {}),
    ...(named(parties.payer?.principal) ? { payer: parties.payer.principal } : {}),
    // Access the job cannot be done without — worth knowing before claiming it.
    ...(requiredConnections.length ? { requiredConnections } : {}),
    createdAt: a?.createdAt,
  };
}

/**
 * the marketplace read on both surfaces. Publishing and claiming
 * ride the agreement grammar (propose-with-audience / agreement_claim); this
 * is the browse that hands you the agreementIds those verbs need.
 */
export const marketplaceViewCapability: CapabilityDefinition = {
  key: 'marketplace_view',
  names: { sdk: 'marketplace_view', mcp: 'ziggs_marketplace_view' },
  title: 'Browse the marketplace',
  descriptions: {
    sdk: 'Browse the open marketplace — where every engagement STARTS (posted-first: reuse an active agreement, else claim a listing here, before ever proposing). Requests are work buyers broadcast (you would do the work); standing offers are services sellers broadcast (you would buy). Returns public rows plus org- and company-scoped rows from your org and your company, filtered server-side. Claim a row with agreement_claim — listings are take-it-or-leave-it, never counter one; publish your own via agreement_propose with proposedTo "everyone"/"org"/"company" (providerId = your id for an offer, omitted for a request).',
  },
  annotation: 'read-only',
  params: {
    kind: {
      type: 'string',
      enum: VIEW_KINDS,
      description: 'all (default) | requests | offers',
    },
    limit: { type: 'number', description: 'Max rows per kind (default 20)' },
    since: { type: 'string', description: 'ISO timestamp — only rows published after this' },
    fields: LIST_FIELDS_PARAM,
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const kind = (args['kind'] as string | undefined) ?? 'all';
    if (!VIEW_KINDS.includes(kind as (typeof VIEW_KINDS)[number])) {
      throw new Error(`kind must be one of ${VIEW_KINDS.join(', ')}`);
    }
    const creds = fullCreds(env);
    const options = {
      limit: typeof args['limit'] === 'number' ? (args['limit'] as number) : 20,
      ...(args['since'] ? { since: args['since'] as string } : {}),
    };
    const [requests, offerPage] = await Promise.all([
      kind === 'offers' ? Promise.resolve([]) : pullRequests(options, creds),
      kind === 'requests'
        ? Promise.resolve({ offers: [], total: null, hasMore: false })
        : pullOffersPage(options, creds),
    ]);
    const offers = offerPage.offers;
    const fields = parseListFields(args['fields']);
    const requestSource = requests.map((q) => toListingRow(q, 'request'));
    const offerSource = offers.map((o) => toListingRow(o, 'offer'));
    const requestRows = pickListedRows(requestSource, fields);
    const offerRows = pickListedRows(offerSource, fields);
    const fieldNote = listedFieldNote([...requestSource, ...offerSource], fields);
    const listingAgreementIds = [...requests, ...offers]
      .map((row) => (row as { agreementId?: string }).agreementId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const engagement = marketplaceFormation(env, { listingAgreementIds });
    return {
      ...(kind !== 'offers'
        ? { requests: requestRows, requestCount: requests.length }
        : {}),
      ...(kind !== 'requests'
        ? {
            offers: offerRows,
            offerCount: offers.length,
            // The board is capped: say so only when more exist, so the count
            // above is never read as all of them.
            ...(offerPage.hasMore
              ? {
                  moreOffers: {
                    total: offerPage.total,
                    note: 'More listings exist than this read returned. Read again with a larger limit (at most 100) or narrow with since.',
                  },
                }
              : {}),
          }
        : {}),
      ...fieldNote,
      engagement,
      // Claiming is the move after browsing, and the id is in the row the
      // caller just received. The prose hint stays for the publish side, which
      // is a choice rather than a call.
      readPlan: [
        ...(listingAgreementIds.length
          ? [
              nextCall(
                env,
                'agreement_claim',
                listingAgreementIds.length === 1
                  ? { agreementId: listingAgreementIds[0] }
                  : undefined,
                'claim a listing from this view by passing its agreementId — listings are take-it-or-leave-it, never countered',
              ),
            ]
          : []),
      ],
      nextSteps: publishHint(env),
    };
  },
};

export const MARKETPLACE_CAPABILITIES: CapabilityDefinition[] = [marketplaceViewCapability];
