import {
  proposeAgreement, proposeBroadcast as proposeBroadcastApi, delegateAgreement, respondToAgreement, counterAgreement,
  claimOpenAgreement,
  proposeUnified,
  getAgreementStatus, listAgreements, getMyAgreements, getAgreement,
  publishOffer as publishOfferApi, createLink, revokeAgreement, fulfillAgreement, linkAgreementToChat,
  getChatsForAgreement, linkArtifactToAgreement, getArtifactsForAgreement,
  type Creds, type Agreement, type ClaimedKind, type ClaimOptions,
  type ProposeAgreementData, type ProposeDirectInput, type ProposeBroadcastInput,
  type PublishOfferPayload, type UnifiedProposeInput, type ProposeShape,
  type DelegateAgreementData, type CounterAgreementData,
  type CreateLinkBody, type CreateLinkResult,
  type ListAgreementsFilters, type GetMyAgreementsFilters,
  type ChatLinkType, type ArtifactLinkType,
} from '@ziggs-ai/api-client';

export class AgreementService {
  private creds: Creds;

  constructor(operatorKey: string, agentId: string) {
    if (!operatorKey) throw new Error('AgreementService: operatorKey is required');
    if (!agentId) throw new Error('AgreementService: agentId is required (operator-token impersonation)');
    this.creds = { operatorKey, agentId };
  }

  /** 1:1 proposal. Server defaults engagementKind to `service` when omitted. */
  proposeDirect(payload: ProposeDirectInput): Promise<Agreement> {
    return proposeAgreement(payload, this.creds);
  }

  /**
   * Open buyer-broadcast. `payload.audience` selects who may see/claim it:
   * 'everyone' (default, fully public), 'org' (members of your active org) or
   * 'company' (members of every team in your active org's company).
   * Server defaults engagementKind to `service`.
   */
  proposeBroadcast(payload: ProposeBroadcastInput): Promise<Agreement> {
    return proposeBroadcastApi(payload, this.creds);
  }

  /** @deprecated Alias for {@link proposeDirect}. */
  propose(payload: ProposeAgreementData): Promise<Agreement> {
    return proposeAgreement(payload, this.creds);
  }

  /**
   * One propose grammar (direct / request / standing offer). Fleet pricing
   * and the wake idempotency key stay on the caller — this is the shared
   * routing, not a second copy of it.
   */
  proposeUnified(
    input: UnifiedProposeInput,
  ): Promise<{ agreement: Agreement; shape: ProposeShape }> {
    return proposeUnified(input, this.creds);
  }

  /**
   * Seller-broadcast marketplace offer. `payload.audience` sets the `payer`
   * sentinel: 'everyone' (default, public), 'org' (your active org only) or
   * 'company' (every team in your company).
   */
  publishOffer(payload: PublishOfferPayload): Promise<Agreement> {
    return publishOfferApi(payload, this.creds);
  }

  delegate(payload: DelegateAgreementData): Promise<Agreement> {
    return delegateAgreement(payload, this.creds);
  }

  respond(agreementId: string, action: 'approve' | 'reject', opts: { mandateAgreementId?: string } = {}): Promise<Agreement> {
    return respondToAgreement(agreementId, action, this.creds, opts);
  }

  /**
   * claim any open broadcast (request, standing offer, hand-off,
   * link invite). Routing (offer vs agreement claim endpoint) is decided in
   * the shared flow; `kind` is the api-client ClaimedKind so this signature
   * can't drift from the flow again (a 'hand-off' addition broke the build).
   */
  claim(
    agreementId: string,
    opts: ClaimOptions = {},
  ): Promise<{ agreement: Agreement; kind: ClaimedKind }> {
    return claimOpenAgreement(agreementId, this.creds, opts);
  }

  /**
   * Connect with the person an agent answers for.
   *
   * `to` is an email or an agent id. A link is with the PERSON either way: an id
   * is only a way to find its owner, and one that answers to an org is refused.
   *
   * The reply says only that the invitation went. Handing back the agreement for
   * an id target while an address target got a bare acknowledgement told the
   * caller more about one kind of target than the other, which made the id form
   * a way to check who has an account.
   */
  async requestLink(to: string, description?: string): Promise<CreateLinkResult> {
    return createLink(
      { to, ...(description ? { description } : {}) },
      this.creds,
    );
  }

  counter(agreementId: string, counter: CounterAgreementData): Promise<Agreement> {
    return counterAgreement(agreementId, counter || {}, this.creds);
  }

  getStatus(agreementId: string): Promise<unknown | null> {
    return getAgreementStatus(agreementId, this.creds);
  }

  list(filters: ListAgreementsFilters = {}): Promise<Agreement[]> {
    return listAgreements(filters, this.creds);
  }

  /**
   * despite the name, the default returns every agreement the
   * caller's grant can read in the active org — including ones the caller is
   * not a party to (`isYou` all-false). Pass `{ partyOnly: true }` for only
   * agreements where the caller is a party.
   */
  mine(filters: GetMyAgreementsFilters = {}): Promise<Agreement[]> {
    return getMyAgreements(filters, this.creds);
  }

  get(agreementId: string): Promise<Agreement | null> {
    return getAgreement(agreementId, this.creds);
  }

  /**
   * Connect with someone — by email, by agent id, or with a share link. Work
   * agreements are created by `propose` / the marketplace claim routes, which
   * run the term normalisation and consent gates this rail never had.
   */
  createLink(body: CreateLinkBody): Promise<CreateLinkResult> {
    return createLink(body, this.creds);
  }

  revoke(agreementId: string): Promise<{ ok: boolean; agreement: Agreement }> {
    return revokeAgreement(agreementId, this.creds);
  }

  fulfill(agreementId: string): Promise<{ ok: boolean; agreement: Agreement }> {
    return fulfillAgreement(agreementId, this.creds);
  }

  linkToChat(agreementId: string, chatId: string, linkType: ChatLinkType = 'mention'): Promise<unknown | null> {
    return linkAgreementToChat(agreementId, chatId, linkType, this.creds);
  }

  getChats(agreementId: string): Promise<unknown[]> {
    return getChatsForAgreement(agreementId, this.creds);
  }

  linkArtifact(agreementId: string, artifactId: string, linkType: ArtifactLinkType = 'produced'): Promise<unknown | null> {
    return linkArtifactToAgreement(agreementId, artifactId, linkType, this.creds);
  }

  getArtifacts(agreementId: string): Promise<unknown[]> {
    return getArtifactsForAgreement(agreementId, this.creds);
  }

}
