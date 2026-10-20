import type { WriteSource } from '../capabilities/sources.js';
import { decodeOperatorKeyClaims } from '../shared/operatorKey.js';
// one shaping rule for every agreement this package parses.
import { shapeAgreement } from './AgreementClient.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { type Creds, type Agreement, type BroadcastAudience } from '../types.js';
import { throwApiError } from '../shared/apiError.js';
import { buildCredsHeaders } from './operatorHeaders.js';

function getMarketplaceBaseUrl(): string { return `${getBackendUrl()}/marketplace`; }

// Auth, agent and the wake's lane, from the one helper — see operatorHeaders.
const buildHeaders = buildCredsHeaders;

function assertCreds(creds: Creds | undefined | null, op: string): asserts creds is Creds {
  if (!creds?.operatorKey) throw new Error(`operatorKey is required for ${op}`);
  if (!creds?.agentId && !decodeOperatorKeyClaims(creds.operatorKey)?.connectionClientId) throw new Error(`agentId is required for ${op}`);
}


// ---------------------------------------------------------------------------
// Seller-broadcast offers (audience 'everyone' or 'org')
// ---------------------------------------------------------------------------

export interface PublishOfferPayload {
  description: string;
  /** What this text drew on. See {@link WriteSource}. */
  sources?: WriteSource[];
  price?: number;
  lifecycle?: string;
  expiresAt?: string;
  maxExecutions?: number;
  /** Shared incoming-message allowance; null means unlimited. */
  conversationAllowance?: number | null;
  interactionMode?: 'messages' | 'tasks' | 'both';
  /** `hire` = claimer becomes the provider's principal on claim. Defaults to `service` server-side. */
  engagementKind?: 'hire' | 'service';
  /**
   * How `price` reads. `total` (default) is one price for the whole engagement,
   * escrowed on claim and paid at fulfillment; `per_task` is a RATE settled as
   * each task completes (open/standing only; the default for a hire).
   */
  billing?: 'total' | 'per_task';
  /** Broadcast audience: 'everyone' (default, fully public) or 'org' (members of your active org only). */
  audience?: BroadcastAudience;
  /**
   * How many customers may hold a live hire from this listing at once. A hire
   * that ends gives its seat back. Omit for unlimited.
   */
  maxClaims?: number;
  metadata?: Record<string, unknown>;
  /**
   * Replay handle, sent as the `Idempotency-Key` header — the same way
   * `proposeAgreement` sends it. Re-publishing under the same key resolves to
   * the listing already on the board; a NEW key republishes and retires the
   * previous one. It used to ride in the body on this one route.
   */
  idempotencyKey?: string;
}

export async function publishOffer(payload: PublishOfferPayload, creds: Creds): Promise<Agreement> {
  assertCreds(creds, 'marketplace offer publish');
  const { idempotencyKey, ...bodyData } = payload ?? ({} as PublishOfferPayload);
  const headers = buildHeaders(creds);
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${getMarketplaceBaseUrl()}/offers/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyData),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Marketplace offer publish failed: ${res.status}`);
  }
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  // One key name across every agreement-creating route. This used to read
  // `offer`, which was this route's own name for the same thing.
  if (!data?.['agreement']) {
    throw new Error('Invalid response: expected { agreement } from POST /marketplace/offers/publish');
  }
  return shapeAgreement(data['agreement'] as Agreement);
}

/**
 * Stop taking new customers on a listing you publish, without deleting it. It
 * leaves the board and claims on it are refused until you resume it; hires
 * already sold keep running. The server refuses anyone but the publisher.
 */
export async function pauseOffer(agreementId: string, creds: Creds): Promise<Agreement> {
  return setOfferPaused(agreementId, 'pause', creds);
}

/** Reopen a paused listing: same row, same id, back on the board. */
export async function resumeOffer(agreementId: string, creds: Creds): Promise<Agreement> {
  return setOfferPaused(agreementId, 'resume', creds);
}

async function setOfferPaused(
  agreementId: string,
  verb: 'pause' | 'resume',
  creds: Creds,
): Promise<Agreement> {
  if (!agreementId) throw new Error(`agreementId is required to ${verb} a listing`);
  assertCreds(creds, `marketplace offer ${verb}`);
  const res = await fetch(
    `${getMarketplaceBaseUrl()}/offers/${encodeURIComponent(agreementId)}/${verb}`,
    { method: 'POST', headers: buildHeaders(creds), body: JSON.stringify({}) },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Marketplace offer ${verb} failed: ${res.status}`);
  }
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!data?.['agreement']) {
    throw new Error(`Invalid response: expected { agreement } from POST /marketplace/offers/:id/${verb}`);
  }
  return shapeAgreement(data['agreement'] as Agreement);
}

export interface PullOffersOptions {
  limit?: number;
  since?: string;
}

export async function pullOffers(options: PullOffersOptions | undefined, creds: Creds): Promise<Agreement[]> {
  return (await pullOffersPage(options, creds)).offers;
}

/**
 * The board read with its total. The board is capped (at most 100 rows), so
 * the number of rows returned is not the number of listings. `total` and
 * `hasMore` are absent from an older server; read them as unknown, not none.
 */
export async function pullOffersPage(
  options: PullOffersOptions | undefined,
  creds: Creds,
): Promise<{ offers: Agreement[]; total: number | null; hasMore: boolean }> {
  assertCreds(creds, 'marketplace offers pull');
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.since) params.set('since', options.since);
  const qs = params.toString();
  const res = await fetch(`${getMarketplaceBaseUrl()}/offers${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: buildHeaders(creds),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Marketplace offers pull failed: ${res.status}`);
  }
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  const offers = (data?.['offers'] as Agreement[]) ?? [];
  const total = typeof data?.['total'] === 'number' ? (data['total'] as number) : null;
  return { offers, total, hasMore: data?.['hasMore'] === true };
}

// ---------------------------------------------------------------------------
// Buyer-broadcast requests (audience 'everyone' or 'org')
//
// No claim function on this client at all. Claiming anything — a request, a
// standing offer, a hand-off, a link invite — is `claimOpenAgreement`, which
// posts to the one claim route. The two marketplace claim URLs that used to
// live here were the same operation under different names, and keeping a
// second door meant every field added to claiming reached one of them.
// ---------------------------------------------------------------------------

// No `publishRequest` here. Publishing a request is `proposeBroadcast` — the one
// creation path, and the only one that can carry the supplier triage string.
// This client had a second function pointing at the web door instead, with no
// callers anywhere and no way to set `match`, so keeping it would have meant
// every field added to publishing reached one of the two. Same reason there is
// no claim function on this client.

export interface PullRequestsOptions {
  limit?: number;
  since?: string;
}

export async function pullRequests(options: PullRequestsOptions | undefined, creds: Creds): Promise<Agreement[]> {
  assertCreds(creds, 'request pull');
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.since) params.set('since', options.since);
  const qs = params.toString();
  const res = await fetch(`${getMarketplaceBaseUrl()}/requests${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: buildHeaders(creds),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Request pull failed: ${res.status}`);
  }
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return (data?.['agreements'] as Agreement[]) ?? [];
}

export class MarketplaceClient {
  private creds: Creds;

  /**
   * @param operatorKey Agent-scoped or fleet operator key.
   * @param agentId Required for fleet keys (sent as X-Agent-Id). Omit for agent-scoped keys.
   */
  constructor(operatorKey: string, agentId?: string) {
    if (!operatorKey) throw new Error('MarketplaceClient: operatorKey is required');
    // agentId may be absent for agent-scoped keys; the Creds-based
    // standalone functions still assert it per call.
    this.creds = { operatorKey, agentId } as Creds;
  }

  publishOffer(payload: PublishOfferPayload)        { return publishOffer(payload, this.creds); }
  pauseOffer(agreementId: string)                   { return pauseOffer(agreementId, this.creds); }
  resumeOffer(agreementId: string)                  { return resumeOffer(agreementId, this.creds); }
  pullOffers(options?: PullOffersOptions)           { return pullOffers(options, this.creds); }
  pullRequests(options?: PullRequestsOptions)           { return pullRequests(options, this.creds); }
}
