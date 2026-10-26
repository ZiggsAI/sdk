import type { WriteSource } from '../capabilities/sources.js';
import { decodeOperatorKeyClaims } from '../shared/operatorKey.js';
import type { AgreementRead } from '@ziggs-ai/contracts';
import { runtimeLog } from '../shared/runtimeLog.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { ApiError, type Creds, type Agreement, type AgreementPartySide, type EngagementKind, type BroadcastAudience, OPEN_AGREEMENT_TARGET, ORG_AGREEMENT_TARGET, isBroadcastTarget, partySideIds } from '../types.js';
import { throwApiError } from '../shared/apiError.js';
import { buildCredsHeaders } from './operatorHeaders.js';

// Lazy: read at call time so a `configureApiClient` call that lands after this
// module is imported still takes effect. Baking it at module-load time would
// freeze the URL before the host has configured one.
function getAgreementBaseUrl(): string {
  return `${getBackendUrl()}/agreements`;
}

// Auth, agent and the wake's lane, from the one helper — see operatorHeaders.
const buildHeaders = buildCredsHeaders;

function assertCreds(creds: Creds | undefined | null, op: string): asserts creds is Creds {
  if (!creds?.operatorKey) throw new Error(`operatorKey is required for ${op}`);
  if (!creds?.agentId && !decodeOperatorKeyClaims(creds.operatorKey)?.connectionClientId) throw new Error(`agentId is required for ${op}`);
}


// ---------------------------------------------------------------------------
// Proposal lifecycle
// ---------------------------------------------------------------------------

/**
 * Shared proposal terms. When `engagementKind` is omitted the server defaults to `service`.
 * For an open buyer-broadcast request, set `proposedTo` to a broadcast sentinel —
 * `OPEN_AGREEMENT_TARGET` (`"everyone"`, fully public) or `ORG_AGREEMENT_TARGET`
 * (`"org"`, scoped to your org). Prefer `proposeBroadcast({ audience })` over
 * setting `proposedTo` by hand.
 */
export interface ProposeTerms {
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
  /**
   * How `price` reads. `total` (default) escrows one price for the whole
   * engagement and pays at fulfillment; `per_task` is a RATE settled as each
   * task completes (standing/open agreements only, and the default for a hire).
   */
  billing?: 'total' | 'per_task';
  agreementDescription?: string;
  parentAgreementId?: string;
  /**
   * Who does the work. Required on direct proposals (your own id = you offer;
   * the proposedTo id = you commission the recipient); forbidden on
   * broadcasts. The payer is always derived server-side as the non-providing
   * side — there is no payer input.
   */
  providerId?: string;
  /** Resolve the authorized active parent hire's provider on the server. */
  useParentProvider?: boolean;
  /** Defaults to `service` on the server when omitted. Set `hire` for representation contracts. */
  engagementKind?: EngagementKind;
  idempotencyKey?: string;
}

/** 1:1 proposal to a specific user or agent (`proposedTo` = their id). */
export interface ProposeDirectInput extends ProposeTerms {
  proposedTo: string;
  /**
   * The room the terms are discussed in, when there is one.
   *
   * Optional, matching the server, which has always accepted a proposal
   * without one. Delivery does not depend on it: the create-time agreement
   * event targets the party slots, so the counterparty is told either way; a
   * room only gives them somewhere to talk about it. Required here was what
   * forced a bookkeeping agreement between parties with no conversation to
   * invent a chat id in order to exist.
   */
  chatId?: string;
}

/**
 * Open buyer-broadcast. `audience` selects who may see/claim it:
 * 'everyone' (default) = fully public; 'org' = members of the creator's active
 * org only. Sets `proposedTo` to the matching sentinel server-side. When
 * `audience: 'org'` the creator must have an active org or the server 400s.
 */
export type ProposeBroadcastInput = Omit<ProposeDirectInput, 'proposedTo'> & {
  audience?: BroadcastAudience;
  /**
   * Exact-match triage for supplier hosts: a plain string they compare
   * verbatim, no LLM turn. Absent or empty still delivers the request; the
   * supplier just has nothing to triage on.
   */
  match?: string;
};

/**
 * A trust link's agreement, as every caller sees it.
 *
 * A link is reach, not commerce: it carries no money, no escrow, no execution
 * state and no approvals ledger. Handing the raw document over anyway puts
 * storage bookkeeping in front of an LLM, which is what this summary exists to
 * prevent.
 *
 * Lives here rather than in `capabilities/links.ts` because this is where the
 * rule is applied; that module re-exports it so the public name is
 * unchanged.
 */
export function linkSummary(a: Agreement): Record<string, unknown> {
  const side = (s: AgreementPartySide | undefined): AgreementPartySide => ({
    principal: s?.principal ?? null,
    actor: s?.actor ?? null,
  });
  return {
    agreementId: a.agreementId,
    // Kept deliberately: callers branch on this, and a summary that hides what
    // kind of thing it describes breaks the code it is meant to protect.
    engagementKind: a.engagementKind,
    status: a.status,
    proposalStatus: a.proposalStatus,
    // No `payer`: a link carries no money, so the paying side is never occupied.
    parties: {
      creator: side(a.parties?.creator),
      provider: side(a.parties?.provider),
      proposedTo: side(a.parties?.proposedTo),
    },
    // The one id on a link that can be acted on. `parties` is display state —
    // masked per viewer, so the peer arrives as a face that every addressing
    // verb refuses — which left a link summary carrying nobody you could open a
    // chat with. Dropping it here is what that looked like: the server sent the
    // peer and the allow-list ate it before any caller saw it.
    ...(a.peer ? { peer: a.peer } : {}),
    ...(a.approvalAction ? { approvalAction: a.approvalAction } : {}),
    ...(a.description ? { description: a.description } : {}),
    // Seat bookkeeping on an open invite — link state, not commerce.
    ...(a.linkInvite ? { linkInvite: a.linkInvite } : {}),
    createdAt: (a as { createdAt?: unknown }).createdAt,
  };
}

/**
 * Every agreement document this client parses passes through here.
 *
 * The rule — a link is returned as its summary, anything else verbatim — used to
 * be written out at six call sites across the SDK runner, the MCP tools and the
 * capability layer, and three verbs never got it: `agreement_counter`,
 * `agreement_fulfill` and `agreement_subcontract` returned the raw document
 *. Applying it at the parse boundary means a new verb inherits the
 * rule instead of remembering to opt in, and no surface can word its own verdict.
 *
 * Typed as `Agreement` on the way out: every key the summary keeps IS an
 * Agreement field, so this narrows a document rather than returning a different
 * shape.
 */
/**
 * Lift the fields the wire nests, then summarise a link.
 *
 * `Agreement` offers `description`, `proposalStatus`, `lifecycle`,
 * `expiresAt`, `maxExecutions` and `linkInvite` at the top level. The wire
 * does not: it sends them under `terms` and `proposal`, and calls the seats
 * `claimSeats`. This function is the only thing between the two and it used
 * to map NONE of them, so every one of those reads answered `undefined` —
 * silently, because the hand-written type promised they would be there.
 *
 * Filled here rather than by changing the type, because ~78 call sites across
 * the SDK, ziggs-mcp and the agents read them at the top level. They keep
 * reading them; they now get the value.
 *
 * The nested fields stay where the server put them. This adds a view, it does
 * not move anything.
 */
export function shapeAgreement(a: Agreement): Agreement {
  const wire = a as Agreement & Partial<AgreementRead>;
  const conversationAllowance = (wire.terms as { conversationAllowance?: number | null } | undefined)?.conversationAllowance;
  const lifted: Agreement = {
    ...a,
    ...(wire.terms?.description != null
      ? { description: wire.terms.description }
      : {}),
    ...(wire.terms?.lifecycle != null
      ? { lifecycle: wire.terms.lifecycle }
      : {}),
    ...(wire.terms?.expiresAt != null
      ? { expiresAt: wire.terms.expiresAt }
      : {}),
    ...(wire.terms?.maxExecutions != null
      ? { maxExecutions: wire.terms.maxExecutions }
      : {}),
    ...(conversationAllowance !== undefined ? { conversationAllowance } : {}),
    // A price with no billing mode is two different offers. Lifted
    // beside the executions cap because they are read together: "ϟ5 a task, up
    // to 10" and "ϟ5 for the lot" are the same three fields otherwise.
    ...(wire.terms?.billing != null ? { billing: wire.terms.billing } : {}),
    ...(wire.proposal?.status != null
      ? { proposalStatus: wire.proposal.status as Agreement['proposalStatus'] }
      : {}),
    ...(wire.claimSeats
      ? {
          linkInvite: {
            ...(wire.claimSeats.maxClaims != null
              ? { maxClaims: wire.claimSeats.maxClaims }
              : {}),
            claimsUsed: wire.claimSeats.claimsUsed,
          },
        }
      : {}),
  };
  return lifted.engagementKind === 'link'
    ? (linkSummary(lifted) as unknown as Agreement)
    : lifted;
}

/** @deprecated Alias for {@link ProposeDirectInput}. */
export type ProposeAgreementData = ProposeDirectInput;

export async function proposeAgreement(
  proposalData: ProposeDirectInput,
  creds: Creds,
): Promise<Agreement> {
  if (!proposalData) throw new Error('Proposal data is required for proposal creation');
  assertCreds(creds, 'proposal creation');

  const { idempotencyKey, ...bodyData } = proposalData;
  const headers = buildHeaders(creds);
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  // canonical REST path. Backend keeps /propose serving the
  // identical handler with a Deprecation/Sunset header until PR-F removes it.
  const res = await fetch(`${getAgreementBaseUrl()}/proposals`, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyData),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Proposal creation failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!data?.['agreement']) {
    throw new Error('Invalid response: expected { agreement } from POST /agreements/proposals');
  }
  return shapeAgreement(data['agreement'] as Agreement);
}

/** Propose a contract to one party (user or agent). Server defaults `engagementKind` to `service`. */
export async function proposeDirectTo(
  input: ProposeDirectInput,
  creds: Creds,
): Promise<Agreement> {
  return proposeAgreement(input, creds);
}

/**
 * Propose an open request. `audience` ('everyone' default | 'org') picks the
 * broadcast sentinel written to `proposedTo`. Server defaults `engagementKind`
 * to `service`.
 */
export async function proposeBroadcast(
  input: ProposeBroadcastInput,
  creds: Creds,
): Promise<Agreement> {
  const { audience, ...terms } = input;
  const proposedTo =
    audience === ORG_AGREEMENT_TARGET ? ORG_AGREEMENT_TARGET : OPEN_AGREEMENT_TARGET;
  return proposeAgreement({ ...terms, proposedTo }, creds);
}

export interface DelegateAgreementData {
  description: string;
  /** What this text drew on. See {@link WriteSource}. */
  sources?: WriteSource[];
  executorId: string;
  /** Omit it and the server uses the parent agreement's own chat. */
  chatId?: string;
  parentAgreementId: string;
  price?: number;
  lifecycle?: string;
  expiresAt?: string;
  maxExecutions?: number;
  /** Shared incoming-message allowance; null means unlimited. */
  conversationAllowance?: number | null;
  interactionMode?: 'messages' | 'tasks' | 'both';
  agreementDescription?: string;
  payerId?: string;
  idempotencyKey?: string;
}

export async function delegateAgreement(
  proposalData: DelegateAgreementData,
  creds: Creds,
): Promise<Agreement> {
  if (!proposalData) throw new Error('Proposal data is required for delegation');
  if (!proposalData.parentAgreementId)
    throw new Error('parentAgreementId is required for delegation');
  assertCreds(creds, 'proposal creation');

  const { idempotencyKey, parentAgreementId } = proposalData;
  const headers = buildHeaders(creds);
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  // parentAgreementId in path AND body. Backend's
  // `DelegateTaskDto` validates `parentAgreementId` as a required string;
  // controller (`POST /agreements/:parentAgreementId/delegations`) merges
  // path over body, so duplicating the value is harmless. Stripping it
  // from the body (as #72 did) trips DTO validation and returns
  // `400: parentAgreementId must be a string` → infinite retry loop in
  // `agreement_subcontract`. Send both, let the path win.
  const bodyWithParent = { ...proposalData };
  delete (bodyWithParent as { idempotencyKey?: string }).idempotencyKey;
  const res = await fetch(
    `${getAgreementBaseUrl()}/${encodeURIComponent(parentAgreementId)}/delegations`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyWithParent),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Delegation failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!data?.['agreement']) {
    throw new Error('Invalid response: expected { agreement } from POST /agreements/:parentAgreementId/delegations');
  }
  return shapeAgreement(data['agreement'] as Agreement);
}

/**
 * Approve or reject a pending agreement (canonical client path).
 *
 * Routes to `POST /claim` (open or org-scoped broadcast) or
 * `PUT /approvals/:partyId` (ledger). Legacy rows without approvals[] are
 * backfilled server-side on PUT. The server rejects a /claim from a non-member
 * of an org-scoped broadcast's org.
 */
export async function respondToAgreement(
  agreementId: string,
  action: 'approve' | 'reject',
  creds: Creds,
  opts: {
    ownerUserId?: string | null;
    agreement?: Agreement | null;
    /** Where to send the human when the decision is theirs. */
    appUrl?: string;
  } = {},
): Promise<Agreement> {
  if (!agreementId || !action) throw new Error('Agreement ID and action are required for proposal response');
  assertCreds(creds, 'proposal response');

  // Unshaped on purpose: the approvals ledger below is exactly what the link
  // summary drops, and resolving the caller's slot from a summary would fail
  // every link approval with "no pending approval entry".
  const agreement =
    opts.agreement ?? (await getAgreementDocument(agreementId, creds));
  if (!agreement) {
    throw new ApiError(`Agreement ${agreementId} not found`, 404);
  }

  const approval = agreement.approvalAction;
  if (approval && (approval.state !== 'available' || !approval.partyId)) {
    throw new ApiError(`${approval.explanation}${opts.appUrl ? ` Review: ${opts.appUrl}` : ''}`, 403);
  }
  const partyId = approval?.partyId ?? resolveMyPendingApprovalPartyId(agreement, {
    ownerUserId: opts.ownerUserId,
    agentId: creds.agentId,
  });

  const proposedTo = agreement.parties?.proposedTo?.principal;
  if (isBroadcastTarget(proposedTo) || isBroadcastTarget(agreement.parties?.payer?.principal)) {
    // respond is approve/reject on DIRECT proposals only. An open
    // broadcast (request, standing offer, link invite) has no per-recipient
    // approval slot — a BYSTANDER can neither approve nor reject it
    //; their move is to claim it, which has its own verb.
    //
    // with one exception — the caller who HOLDS a pending approval
    // on the row. A hand-off pins its provider and that provider's consent
    // is a real ledger slot even on an open broadcast; this guard
    // used to reject before looking, so the provider could not consent
    // through ANY surface and the hand-off sat unclaimable forever. The
    // backend keeps a consented broadcast OPEN for claims.
    if (!partyId) {
      throw new ApiError(
        `Agreement ${agreementId} is an open broadcast and has no personal approval slot — respond cannot ${action} it. Claim it with the claim tool (agreement_claim / ziggs_agreement_claim), or ignore it to pass.`,
        403,
      );
    }
  } else if (!partyId) {
    throw new ApiError(
      `No pending approval entry for this operator on agreement ${agreementId}`,
      403,
    );
  }

  // If the slot is the principal's, the server accepts
  // only under a live approval-authority grant (else 403). Do not pre-refuse
  // here; the PUT is the source of truth.

  return approveAgreementAsParty(
    agreementId,
    partyId,
    action === 'approve' ? 'approved' : 'rejected',
    creds,
  );
}

/**
 * The approval facts a "who decides this?" question is answered from: the party
 * ids still owing a decision, plus the named responder slot.
 *
 * Split out so the inbox card and the respond call answer that
 * question with ONE rule. The card had no rule at all — it offered the respond
 * tool for every pending proposal, including the ones only the human can
 * answer, and the agent found out by 403.
 */
export interface PendingApprovalFacts {
  /** Party ids with a pending entry on the approvals ledger. */
  pendingPartyIds: readonly string[];
  /**
   * The direct responder slot, when the proposal names one. A side names up to
   * two ids — the accountable principal and the delegate acting for it — and
   * either may be the one holding the decision.
   */
  proposedToIds?: readonly string[];
}

/**
 * Which of `candidateIds` holds the pending approval slot, first match wins —
 * so pass them in preference order (agent id before owner principal).
 */
export function resolvePendingApprovalPartyId(
  facts: PendingApprovalFacts,
  candidateIds: ReadonlyArray<string | null | undefined>,
): string | null {
  const actorIds = candidateIds.filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  for (const id of actorIds) {
    if (facts.pendingPartyIds.includes(id)) return id;
  }
  // A row with no pending ledger entries is a legacy one (approvals[] predates
  //), and there the named responder slot IS the decision.
  if (facts.pendingPartyIds.length === 0) {
    const responderIds = facts.proposedToIds ?? [];
    for (const id of actorIds) {
      if (responderIds.includes(id)) return id;
    }
  }
  return null;
}

/**
 * resolve which approvals.partyId the current operator may submit.
 * Checks pending ledger entries against impersonated agent id and owner principal.
 */
export function resolveMyPendingApprovalPartyId(
  agreement: Agreement,
  opts: { ownerUserId?: string | null; agentId?: string | null },
): string | null {
  return resolvePendingApprovalPartyId(
    {
      pendingPartyIds: (agreement.approvals ?? [])
        .filter((a) => a.status === 'pending' || a.status === 'PENDING')
        .map((a) => a.partyId),
      proposedToIds: partySideIds(agreement.parties?.proposedTo),
    },
    [opts.agentId, opts.ownerUserId],
  );
}

/**
 * Record this party's approval decision on an agreement
 * (`PUT /agreements/:agreementId/approvals/:partyId`).
 *
 * Use the partyId from the server's approvalAction. Agents need covering
 * approval authority even for their own slot; the server rechecks it on PUT.
 * Canonical for hire, service, link, and request proposals.
 */
export async function approveAgreementAsParty(
  agreementId: string,
  partyId: string,
  status: 'approved' | 'rejected',
  creds: Creds,
): Promise<Agreement> {
  if (!agreementId) throw new Error('agreementId is required for approval');
  if (!partyId) throw new Error('partyId (caller owner principal) is required for approval');
  assertCreds(creds, 'agreement approval');

  const res = await fetch(
    `${getAgreementBaseUrl()}/${encodeURIComponent(agreementId)}/approvals/${encodeURIComponent(partyId)}`,
    {
      method: 'PUT',
      headers: buildHeaders(creds),
      body: JSON.stringify({ status }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Agreement approval failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!data?.['agreement']) {
    throw new Error('Invalid response: expected { agreement } from PUT /agreements/:id/approvals/:partyId');
  }
  return shapeAgreement(data['agreement'] as Agreement);
}

export interface CounterAgreementData {
  price?: number;
  agreementDescription?: string;
  expiresAt?: string;
  lifecycle?: string;
  maxExecutions?: number;
  /** Shared incoming-message allowance; null means unlimited. */
  conversationAllowance?: number | null;
  interactionMode?: 'messages' | 'tasks' | 'both';
  description?: string;
  /** What this text drew on. See {@link WriteSource}. */
  sources?: WriteSource[];
}

export async function counterAgreement(
  agreementId: string,
  counter: CounterAgreementData,
  creds: Creds,
): Promise<Agreement> {
  if (!agreementId) throw new Error('agreementId is required for counter-offer');
  assertCreds(creds, 'counter proposal');

  const res = await fetch(`${getAgreementBaseUrl()}/${agreementId}/counter`, {
    method: 'POST',
    headers: buildHeaders(creds),
    body: JSON.stringify(counter || {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Counter proposal failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!data?.['agreement']) {
    throw new Error('Invalid response: expected { agreement } from /agreements/:id/counter');
  }
  return shapeAgreement(data['agreement'] as Agreement);
}


export async function getAgreementStatus(agreementId: string, creds: Creds): Promise<unknown | null> {
  if (!agreementId) return null;
  assertCreds(creds, 'proposal status read');

  try {
    const res = await fetch(`${getAgreementBaseUrl()}/${agreementId}/status`, {
      method: 'GET',
      headers: buildHeaders(creds),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      runtimeLog.warn('AgreementClient', `⚠️ Proposal status read failed: ${res.status} ${res.statusText} ${body}`);
      return null;
    }
    return await res.json().catch(() => null);
  } catch (e) {
    runtimeLog.warn('AgreementClient', `⚠️ Proposal status read failed: ${(e as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface ListAgreementsFilters {
  status?: string;
  engagementKind?: EngagementKind;
  proposalStatus?: string;
  hasTask?: boolean;
}

export async function listAgreements(filters: ListAgreementsFilters = {}, creds: Creds): Promise<Agreement[]> {
  assertCreds(creds, 'list agreements');

  // return an empty array only for a genuine empty 200 result. Any
  // failure (non-2xx / network) throws so the MCP tool reports a real error
  // instead of "you have no agreements". HTTP failures are ApiError.
  // Canonical query path: GET /agreements?scope=&status=&engagementKind=&..
  const url = new URL(getAgreementBaseUrl());
  if (filters.status) url.searchParams.set('status', filters.status);
  if (filters.engagementKind) url.searchParams.set('engagementKind', filters.engagementKind);
  if (filters.proposalStatus) url.searchParams.set('proposalStatus', filters.proposalStatus);
  if (filters.hasTask != null) url.searchParams.set('hasTask', String(filters.hasTask));

  let res: Response;
  try {
    res = await fetch(url.toString(), { method: 'GET', headers: buildHeaders(creds) });
  } catch (e) {
    runtimeLog.warn('AgreementClient', `⚠️ List agreements failed: ${(e as Error).message}`);
    throw new Error(`GET /agreements network error: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    runtimeLog.warn('AgreementClient', `⚠️ List agreements failed: ${res.status} ${res.statusText} ${body?.slice(0, 200)}`);
    throwApiError(res, body, `GET /agreements failed: ${res.status}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return Array.isArray(data?.['agreements'])
    ? (data['agreements'] as Agreement[]).map(shapeAgreement)
    : [];
}

export interface GetMyAgreementsFilters {
  engagementKind?: EngagementKind;
  proposalStatus?: string;
  hasTask?: boolean;
  /**
   * `scope=mine` alone returns every agreement the caller's grant can
   * read in the active org — including ones the caller is not a party to
   * (`isYou` all-false). Pass `partyOnly: true` for a true "mine": only
   * agreements where the caller (key owner or impersonated agent) is a party.
   */
  partyOnly?: boolean;
}

export async function getMyAgreements(filters: GetMyAgreementsFilters = {}, creds: Creds): Promise<Agreement[]> {
  assertCreds(creds, 'get my agreements');

  // empty array only for a genuine empty 200; any failure throws so
  // the tool surfaces a real error rather than "no agreements" (see listAgreements).
  // Canonical query path: GET /agreements?scope=mine returns the enriched
  // shape (tasks + originChatId + isYou flags).
  const url = new URL(getAgreementBaseUrl());
  url.searchParams.set('scope', 'mine');
  if (filters.engagementKind) url.searchParams.set('engagementKind', filters.engagementKind);
  if (filters.proposalStatus) url.searchParams.set('proposalStatus', filters.proposalStatus);
  if (filters.hasTask != null) url.searchParams.set('hasTask', String(filters.hasTask));
  if (filters.partyOnly) url.searchParams.set('partyOnly', 'true');

  let res: Response;
  try {
    res = await fetch(url.toString(), { method: 'GET', headers: buildHeaders(creds) });
  } catch (e) {
    runtimeLog.warn('AgreementClient', `⚠️ Get my agreements failed: ${(e as Error).message}`);
    throw new Error(`GET /agreements?scope=mine network error: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    runtimeLog.warn('AgreementClient', `⚠️ Get my agreements failed: ${res.status} ${res.statusText} ${body?.slice(0, 200)}`);
    throwApiError(res, body, `GET /agreements?scope=mine failed: ${res.status}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return Array.isArray(data?.['agreements'])
    ? (data['agreements'] as Agreement[]).map(shapeAgreement)
    : [];
}

/**
 * The full agreement document, unshaped — for this client's OWN reads.
 *
 * `respondToAgreement` resolves which approvals slot the caller may fill, and
 * `claimOpenAgreement` routes on the broadcast's open side; both need fields the
 * link summary deliberately drops. Callers outside this module get the shaped
 * `getAgreement`.
 */
async function getAgreementDocument(agreementId: string, creds: Creds): Promise<Agreement | null> {
  if (!agreementId) return null;
  assertCreds(creds, 'get agreement');

  // a genuine 404 (and 200-with-no-agreement) is a real "not found"
  // and returns null. Every other failure (403/5xx/network) must throw so the
  // caller can tell "does not exist" from "could not fetch" instead of a 403
  // masquerading as not-found. thrown as ApiError for toolError.
  let res: Response;
  try {
    res = await fetch(`${getAgreementBaseUrl()}/${agreementId}`, {
      method: 'GET',
      headers: buildHeaders(creds),
    });
  } catch (e) {
    runtimeLog.warn('AgreementClient', `⚠️ Get agreement failed: ${(e as Error).message}`);
    throw new Error(`GET /agreements/${agreementId} network error: ${(e as Error).message}`);
  }

  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    runtimeLog.warn('AgreementClient', `⚠️ Get agreement failed: ${res.status} ${res.statusText} ${body?.slice(0, 200)}`);
    throwApiError(res, body, `GET /agreements/${agreementId} failed: ${res.status}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return (data?.['agreement'] as Agreement) ?? null;
}

/** One agreement, shaped: a link comes back as its summary. */
export async function getAgreement(agreementId: string, creds: Creds): Promise<Agreement | null> {
  const agreement = await getAgreementDocument(agreementId, creds);
  return agreement ? shapeAgreement(agreement) : null;
}

export interface CreateLinkBody {
  /**
   * Who to connect with: an email address, or the id of an agent that answers
   * to them. Either way the link is with the PERSON — an id is only a way to
   * find its owner, and an agent that answers to an org is refused. Omit for an
   * open invite you share yourself.
   */
  to?: string;
  /** Message shown to whoever is asked to approve or claim it. */
  description?: string;
  /** Open invites only: how many people may claim this one link. Default 1. */
  maxClaims?: number;
}

/**
 * The route's answer.
 *
 * `status` is constant — it went — and the two null-able fields are per-ARM,
 * chosen by what the caller put in `to` and therefore known to it before the
 * call. `shareUrl` is present exactly for an open invite.
 *
 * `agreementId` names the row for an agent id and for an open invite, and is
 * null for an EMAIL. That split is what keeps the answer from becoming an
 * existence oracle: the knock returns nothing for "no such person", "already
 * linked", "already knocked" and "that is yourself" alike, so an id on some of
 * those and not others would answer the one question the route refuses to
 * answer. An agent id is different — the route resolves it through root
 * authority and refuses a name that answers to nobody, so it already discloses
 * that target's existence.
 *
 * Without it a caller could not reference what it had just created, check on it
 * later, or tell a repeat from a first attempt.
 */
export interface CreateLinkResult {
  ok: boolean;
  status: 'sent';
  /** The link row, for a named agent id or an open invite. Null for an email. */
  agreementId: string | null;
  shareUrl: string | null;
}

/**
 * Connect with someone — by email, by agent id, or with a shareable invite.
 *
 * This posts to `POST /agreements/links`. It used to post to `POST /agreements`,
 * which also created work agreements inline and skipped the gates the proposal
 * and marketplace paths run. Work agreements go through `proposeAgreement`
 * (`POST /agreements/proposals`) and the marketplace claim routes; this rail
 * carries links and nothing else.
 */
export async function createLink(
  body: CreateLinkBody,
  creds: Creds,
): Promise<CreateLinkResult> {
  if (!body) throw new Error('Body is required for link creation');
  assertCreds(creds, 'link creation');

  const res = await fetch(`${getAgreementBaseUrl()}/links`, {
    method: 'POST',
    headers: buildHeaders(creds),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => '');
    throwApiError(res, responseBody, `Link creation failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (data?.['status'] !== 'sent') {
    throw new Error(
      'Invalid response: expected { ok, status: "sent", shareUrl } from POST /agreements/links',
    );
  }
  const shareUrl = data['shareUrl'];
  const agreementId = data['agreementId'];
  return {
    ok: data['ok'] === true,
    status: 'sent',
    agreementId: typeof agreementId === 'string' ? agreementId : null,
    shareUrl: typeof shareUrl === 'string' ? shareUrl : null,
  };
}

export async function revokeAgreement(
  agreementId: string,
  creds: Creds,
): Promise<{ ok: boolean; agreement: Agreement }> {
  if (!agreementId) throw new Error('agreementId is required for revocation');
  assertCreds(creds, 'agreement revocation');

  // canonical REST verb. Legacy POST /agreements/:id/revoke stays
  // serving the identical handler (with Deprecation headers) until PR-F.
  const res = await fetch(`${getAgreementBaseUrl()}/${encodeURIComponent(agreementId)}`, {
    method: 'DELETE',
    headers: buildHeaders(creds),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Agreement revocation failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!data?.['agreement']) {
    throw new Error('Invalid response: expected { ok, agreement } from DELETE /agreements/:id');
  }
  const envelope = data as unknown as { ok: boolean; agreement: Agreement };
  return { ...envelope, agreement: shapeAgreement(envelope.agreement) };
}

/** mark an agreement fulfilled (complete). A provider closing its own
 * delivered work — party-gated server-side. */
export async function fulfillAgreement(
  agreementId: string,
  creds: Creds,
): Promise<{ ok: boolean; agreement: Agreement }> {
  if (!agreementId) throw new Error('agreementId is required to fulfill');
  assertCreds(creds, 'agreement fulfillment');

  const res = await fetch(`${getAgreementBaseUrl()}/${encodeURIComponent(agreementId)}/fulfill`, {
    method: 'POST',
    headers: buildHeaders(creds),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Agreement fulfillment failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!data?.['agreement']) {
    throw new Error('Invalid response: expected { ok, agreement } from POST /agreements/:id/fulfill');
  }
  const envelope = data as unknown as { ok: boolean; agreement: Agreement };
  return { ...envelope, agreement: shapeAgreement(envelope.agreement) };
}

/** What an open-broadcast claim resolved to. ⚠️ Mirrors the server; it is authoritative. */
export type ClaimedKind = 'link' | 'offer' | 'request' | 'hand-off';

/**
 * Claim an open agreement. Three shapes are claimable:
 * - open link invite (`engagementKind: link`, proposedTo everyone)
 * - open broadcast request (proposedTo 'everyone', status open)
 * - org-scoped broadcast request (proposedTo 'org') — the server rejects the
 *   claim with 403 if the caller is not a member of the agreement's orgId
 *
 * POST /agreements/:id/claim — canonical; no partyId in body.
 */
/**
 * What a claimer can say about WHY it is claiming.
 *
 * A claim binds a party to terms somebody else posted, so the only thing there
 * is to declare is the authority behind it: the job the claiming agent is
 * already doing. Nothing here changes the row — the lineage of a posted
 * agreement belongs to whoever posted it.
 */
export interface ClaimOptions {
  parentAgreementId?: string;
  /**
   * The active agreement whose work this claim is part of. An agent acting
   * inside a job its human approved does not need a second consent for the
   * engagements that job requires, but it has to NAME the job — the server
   * verifies the claim against the acting agent and never guesses one.
   */
  mandateAgreementId?: string;
  /**
   * The room a hire of a listing is made in. On activation its
   * agent joins that room; the claimer must take part in it.
   */
  chatId?: string;
  /**
   * Your connection for each kind of access the listing asks for,
   * `{ <kind>: <connectionId> }`. The hire is granted exactly that connection. A claim made inside a job (mandateAgreementId)
   * takes the job's and names none.
   */
  connections?: Record<string, string>;
  /**
   * Who a hire of a listing is for. `me` (the default) keeps its room to the
   * person; `workspace` makes the workspace the payer and shows the room to
   * every member.
   */
  hireFor?: 'me' | 'workspace';
}

/**
 * Where a hire made in a room stands on getting its agent in.
 * `ready` only once the agent is in; `admission_failed` names the action that
 * resumes it without hiring or charging again.
 */
export interface ClaimRoom {
  chatId?: string;
  status: 'awaiting_approval' | 'ready' | 'admission_failed' | 'preparation_failed' | 'unavailable';
  message?: string;
  recovery?: { method: string; path: string; tool?: string; args?: Record<string, unknown> };
}

export async function claimAgreement(
  agreementId: string,
  creds: Creds,
  opts: ClaimOptions = {},
): Promise<{ ok: boolean; agreement: Agreement; kind?: ClaimedKind; room?: ClaimRoom }> {
  if (!agreementId) throw new Error('agreementId is required to claim an open agreement');
  assertCreds(creds, 'open agreement claim');

  const res = await fetch(
    `${getAgreementBaseUrl()}/${encodeURIComponent(agreementId)}/claim`,
    {
      method: 'POST',
      headers: buildHeaders(creds),
      body: JSON.stringify(
        { ...(opts.mandateAgreementId ? { mandateAgreementId: opts.mandateAgreementId } : {}), ...(opts.parentAgreementId ? { parentAgreementId: opts.parentAgreementId } : {}), ...(opts.chatId ? { chatId: opts.chatId } : {}), ...(opts.connections && Object.keys(opts.connections).length ? { connections: opts.connections } : {}), ...(opts.hireFor === 'workspace' ? { hireFor: 'workspace' } : {}) },
      ),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Open agreement claim failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!data?.['agreement']) {
    throw new Error('Invalid response: expected { ok, agreement } from POST /agreements/:id/claim');
  }
  // the route reports which kind of broadcast this turned out to be.
  // A caller cannot work it out from the row — post-claim no sentinel is left,
  // and a request (you do the work) reads the same shape as a standing offer (you
  // pay for it) unless you know which slot you landed in.
  const envelope = data as unknown as {
    ok: boolean;
    agreement: Agreement;
    kind?: ClaimedKind;
    room?: ClaimRoom;
  };
  return { ...envelope, agreement: shapeAgreement(envelope.agreement) };
}

// ---------------------------------------------------------------------------
// Chat links
// ---------------------------------------------------------------------------

/**
 * Link types a caller may ask for. `origin` and `delegation` are workflow-owned;
 * callers may only pin an agreement into a chat as a reference (`mention`).
 */
export const CHAT_LINK_TYPES = ['mention'] as const;
export type ChatLinkType = (typeof CHAT_LINK_TYPES)[number];

export async function linkAgreementToChat(
  agreementId: string,
  chatId: string,
  linkType: ChatLinkType = 'mention',
  creds: Creds,
): Promise<unknown | null> {
  if (!agreementId || !chatId) return null;
  assertCreds(creds, 'link agreement to chat');

  try {
    const res = await fetch(`${getAgreementBaseUrl()}/${agreementId}/link`, {
      method: 'POST',
      headers: buildHeaders(creds),
      body: JSON.stringify({ chatId, linkType }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      runtimeLog.warn('AgreementClient', `⚠️ Link agreement to chat failed: ${res.status} ${res.statusText} ${body?.slice(0, 200)}`);
      return null;
    }

    return await res.json().catch(() => null);
  } catch (e) {
    runtimeLog.warn('AgreementClient', `⚠️ Link agreement to chat failed: ${(e as Error).message}`);
    return null;
  }
}

export async function getChatsForAgreement(agreementId: string, creds: Creds): Promise<unknown[]> {
  if (!agreementId) return [];
  assertCreds(creds, 'get chats for agreement');

  try {
    const res = await fetch(`${getAgreementBaseUrl()}/${agreementId}/chats`, {
      method: 'GET',
      headers: buildHeaders(creds),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      runtimeLog.warn('AgreementClient', `⚠️ Get chats for agreement failed: ${res.status} ${res.statusText} ${body?.slice(0, 200)}`);
      return [];
    }

    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    return Array.isArray(data?.['links']) ? data['links'] : [];
  } catch (e) {
    runtimeLog.warn('AgreementClient', `⚠️ Get chats for agreement failed: ${(e as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Artifact links
// ---------------------------------------------------------------------------

export const ARTIFACT_LINK_TYPES = ['produced', 'referenced'] as const;
export type ArtifactLinkType = (typeof ARTIFACT_LINK_TYPES)[number];

export async function linkArtifactToAgreement(
  agreementId: string,
  artifactId: string,
  linkType: ArtifactLinkType = 'produced',
  creds: Creds,
): Promise<unknown | null> {
  if (!agreementId || !artifactId) return null;
  assertCreds(creds, 'link artifact to agreement');

  try {
    const res = await fetch(`${getAgreementBaseUrl()}/${agreementId}/artifacts`, {
      method: 'POST',
      headers: buildHeaders(creds),
      body: JSON.stringify({ artifactId, linkType }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      runtimeLog.warn('AgreementClient', `⚠️ Link artifact failed: ${res.status} ${res.statusText} ${body?.slice(0, 200)}`);
      return null;
    }

    return await res.json().catch(() => null);
  } catch (e) {
    runtimeLog.warn('AgreementClient', `⚠️ Link artifact failed: ${(e as Error).message}`);
    return null;
  }
}

export async function getArtifactsForAgreement(agreementId: string, creds: Creds): Promise<unknown[]> {
  if (!agreementId) return [];
  assertCreds(creds, 'get artifacts for agreement');

  try {
    const res = await fetch(`${getAgreementBaseUrl()}/${agreementId}/artifacts`, {
      method: 'GET',
      headers: buildHeaders(creds),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      runtimeLog.warn('AgreementClient', `⚠️ Get artifacts failed: ${res.status} ${res.statusText} ${body?.slice(0, 200)}`);
      return [];
    }

    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    return Array.isArray(data?.['artifacts']) ? data['artifacts'] : [];
  } catch (e) {
    runtimeLog.warn('AgreementClient', `⚠️ Get artifacts failed: ${(e as Error).message}`);
    return [];
  }
}

export class AgreementClient {
  private creds: Creds;

  /**
   * @param operatorKey Agent-scoped or fleet operator key.
   * @param agentId Required for fleet keys (sent as X-Agent-Id). Omit for agent-scoped keys.
   */
  constructor(operatorKey: string, agentId?: string) {
    if (!operatorKey) throw new Error('AgreementClient: operatorKey is required');
    // agentId may be absent for agent-scoped keys; the Creds-based
    // standalone functions still assert it per call.
    this.creds = { operatorKey, agentId } as Creds;
  }

  propose(data: ProposeDirectInput)                                              { return proposeAgreement(data, this.creds); }
  proposeDirect(data: ProposeDirectInput)                                        { return proposeDirectTo(data, this.creds); }
  proposeBroadcast(data: ProposeBroadcastInput)                                  { return proposeBroadcast(data, this.creds); }
  delegate(data: DelegateAgreementData)                                          { return delegateAgreement(data, this.creds); }
  respond(id: string, action: 'approve' | 'reject')                             { return respondToAgreement(id, action, this.creds); }
  approveAsParty(id: string, partyId: string, status: 'approved' | 'rejected') { return approveAgreementAsParty(id, partyId, status, this.creds); }
  counter(id: string, data: CounterAgreementData)                                { return counterAgreement(id, data, this.creds); }
  getStatus(id: string)                                                          { return getAgreementStatus(id, this.creds); }
  list(filters?: ListAgreementsFilters)                                          { return listAgreements(filters, this.creds); }
  listMine(filters?: GetMyAgreementsFilters)                                     { return getMyAgreements(filters, this.creds); }
  get(id: string)                                                                { return getAgreement(id, this.creds); }
  createLink(data: CreateLinkBody)                                               { return createLink(data, this.creds); }
  revoke(id: string)                                                             { return revokeAgreement(id, this.creds); }
  fulfill(id: string)                                                            { return fulfillAgreement(id, this.creds); }
  claimAgreement(id: string)                                                       { return claimAgreement(id, this.creds); }
  linkToChat(id: string, chatId: string, linkType?: ChatLinkType)               { return linkAgreementToChat(id, chatId, linkType ?? 'mention', this.creds); }
  listChats(id: string)                                                          { return getChatsForAgreement(id, this.creds); }
  linkArtifact(id: string, artifactId: string, linkType?: ArtifactLinkType)     { return linkArtifactToAgreement(id, artifactId, linkType ?? 'produced', this.creds); }
  listArtifacts(id: string)                                                      { return getArtifactsForAgreement(id, this.creds); }
}
