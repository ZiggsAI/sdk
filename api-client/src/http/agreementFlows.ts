import {
  claimAgreement,
  proposeBroadcast,
  proposeDirectTo,
  type ClaimedKind,
  type ClaimOptions,
  type ClaimRoom,
  type ProposeTerms,
} from './AgreementClient.js';
import { publishOffer } from './MarketplaceClient.js';
import {
  isBroadcastTarget,
  type Agreement,
  type BroadcastAudience,
  type Creds,
  type EngagementKind,
} from '../types.js';

/**
 * one propose grammar. Direct, broadcast (request and standing
 * offer), and link proposals all flow through here; the surfaces expose a
 * single propose tool instead of dedicated publish/request tools.
 *
 * Routing:
 * - proposedTo 'everyone' | 'org', providerId = self  → seller-broadcast standing offer
 * - proposedTo 'everyone' | 'org', no providerId      → buyer-broadcast request
 * - anything else                            → direct proposal
 */
export interface UnifiedProposeInput extends ProposeTerms {
  proposedTo: string;
  /** Required on direct proposals; optional on broadcasts/links. */
  chatId?: string;
  engagementKind?: EngagementKind;
}

export type ProposeShape = 'direct' | 'request' | 'offer';

export async function proposeUnified(
  input: UnifiedProposeInput,
  creds: Creds,
): Promise<{ agreement: Agreement; shape: ProposeShape }> {
  const { proposedTo, chatId, engagementKind, providerId, ...terms } = input;
  if (!proposedTo) throw new Error('proposedTo is required (a user/agent id, or "everyone"/"org" to broadcast)');

  // The 'link' arm is gone. A link is not a proposal shape: it has no
  // price, no chat and no work, and it is formed by `link_propose`, which takes
  // an email or an agent id and answers the same either way. Keeping a second
  // door here would have meant a caller reaching a link through the propose
  // grammar, where the constant answer and the org-root refusal do not apply.

  if (isBroadcastTarget(proposedTo)) {
    const audience = proposedTo as BroadcastAudience;
    if (providerId && creds.agentId && providerId === creds.agentId) {
      // Seller-broadcast: you work, the claimer pays — a standing offer.
      const agreement = await publishOffer(
        {
          description: terms.description ?? '',
          price: terms.price,
          lifecycle: terms.lifecycle,
          expiresAt: terms.expiresAt,
          maxExecutions: terms.maxExecutions,
          conversationAllowance: terms.conversationAllowance,
          interactionMode: terms.interactionMode,
          engagementKind: engagementKind as 'hire' | 'service' | undefined,
          billing: terms.billing,
          audience,
        },
        creds,
      );
      return { agreement, shape: 'offer' };
    }
    if (providerId) {
      throw new Error(
        'On a broadcast, providerId must be your own agent id (a standing offer: you work, the claimer pays) or omitted (a request: the claimer works, you pay). A third-party providerId is not broadcastable.',
      );
    }
    // Buyer-broadcast: the claimer works, your side pays — an open request.
    const agreement = await proposeBroadcast(
      {
        ...terms,
        chatId: chatId ?? '',
        engagementKind: engagementKind ?? 'service',
        audience,
      },
      creds,
    );
    return { agreement, shape: 'request' };
  }

  // No room is a shape, not an error. The server has always accepted a direct
  // proposal without one, and this throw was the only thing that made the answer
  // depend on which client you used: an agreement between parties who have no
  // conversation had to invent a chat id to be created. Delivery does not go
  // through the room — the create-time event targets the party slots — so the
  // counterparty is told either way.
  const agreement = await proposeDirectTo(
    {
      ...terms,
      proposedTo,
      // Omitted rather than sent empty: an absent field says "no room", and an
      // empty string is one more fiction for the server to interpret.
      ...(chatId ? { chatId } : {}),
      providerId: providerId?.trim() || proposedTo,
      engagementKind: engagementKind ?? 'service',
    },
    creds,
  );
  return { agreement, shape: 'direct' };
}

/**
 * one claim verb for any open broadcast: link invite, request,
 * hand-off, or standing offer.
 *
 * One request. This used to read the agreement first to decide which endpoint to
 * post to, and `GET /agreements/:id` is party-scoped — a claimer is by definition
 * not yet a party to the broadcast it is claiming, so the routing read 404'd and
 * every standing offer in the store failed with "Agreement not found" before
 * either claim endpoint was called. The backend routes it now, where
 * the row is readable without being a party to it.
 *
 * `kind` arrives on the claim response — the route that did the routing reports
 * which broadcast kind this turned out to be.
 */
export async function claimOpenAgreement(
  agreementId: string,
  creds: Creds,
  opts: ClaimOptions = {},
): Promise<{ agreement: Agreement; kind: ClaimedKind; room?: ClaimRoom }> {
  if (!agreementId) throw new Error('agreementId is required');
  const { agreement, kind, room } = await claimAgreement(agreementId, creds, opts);
  // A server that has not shipped the `kind` field yet still claims correctly;
  // 'request' is the shape the route has always handled.
  return { agreement, kind: kind ?? 'request', ...(room ? { room } : {}) };
}
