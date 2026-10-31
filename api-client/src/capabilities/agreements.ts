import { presentResourceCall } from './resourceActions.js';
import { agreementAppUrl } from '../utils/appUrls.js';
import { claimOpenAgreement } from '../http/agreementFlows.js';
import type { ClaimedKind, ClaimRoom } from '../http/AgreementClient.js';
import type { Agreement } from '../types.js';
import { linkIsReachOnly, webAppOrigin } from './links.js';
import { workContextFromEnv, type NextCallOutcome, type WorkContext } from './nextCall.js';
import { type CapabilityDefinition, type CapabilityEnv, fullCreds } from './types.js';

/** Plain outcome once the hire is active. `kind` stays on the result, not in this sentence. */
function activeHireMessage(kind: string): string {
  if (kind === 'offer') return 'The hire is active. They do the work.';
  if (kind === 'hand-off') return 'The hire is active. Their agent works for you.';
  return 'The hire is active. You do the work.';
}

/**
 * One claim result shape for both surfaces. The SDK protocol runner used to
 * return `{agreement, kind}` while MCP returned `{status, kind, message,
 * agreement}` — same HTTP call, two answers.
 */
export function presentClaimResult(
  agreement: Agreement,
  kind: ClaimedKind,
  env: CapabilityEnv,
  room?: ClaimRoom,
): {
  status: string;
  outcome: NextCallOutcome;
  kind: ClaimedKind;
  message: string;
  agreement: Agreement;
  room?: ClaimRoom;
  workContext?: WorkContext;
} {
  const out = presentClaim(agreement, kind, env);
  if (!room) return out;
  const recovery = room.recovery;
  const presented = recovery?.tool
    ? { ...room, recovery: presentResourceCall({ ...recovery, tool: recovery.tool, args: recovery.args ?? {} }, env.surface) }
    : room;
  return { ...out, message: `${out.message} ${roomWords(presented)}`, room: presented };
}

/**
 * The room the hire was made in, in words. "Ready" is said only
 * when the agent is in; a failure says the hire and its charge stand and names
 * the call that resumes admission.
 */
function roomWords(room: ClaimRoom): string {
  if (room.status === 'ready') {
    return `The agent is in room ${room.addressId} now.`;
  }
  if (room.status === 'awaiting_approval') {
    return room.addressId
      ? `Once approved, the agent joins room ${room.addressId}; the room shows who can answer.`
      : 'The hire is waiting for approval; its conversation opens after approval.';
  }
  const recovery = room.recovery;
  const retry = recovery?.tool
    ? ` Resume with ${recovery.tool} using ${JSON.stringify(recovery.args)}.`
    : recovery ? ` Resume with ${recovery.method} ${recovery.path}.` : '';
  return `${room.message ?? 'The hire conversation is not ready.'} Do not claim again.${retry}`;
}

function presentClaim(
  agreement: Agreement,
  kind: ClaimedKind,
  env: CapabilityEnv,
): {
  status: string;
  outcome: NextCallOutcome;
  kind: ClaimedKind;
  message: string;
  agreement: Agreement;
  workContext?: WorkContext;
} {
  const workContext = workContextFromEnv(env);
  if (kind === 'link') {
    return {
      status: 'linked',
      outcome: 'ok',
      kind,
      message: `Link invite claimed — you are now linked. ${linkIsReachOnly(env)}`,
      agreement,
      ...(workContext ? { workContext } : {}),
    };
  }
  if (agreement?.status !== 'active') {
    const held = (agreement?.approvals ?? []).find((a) => a.status === 'pending');
    const approveUrl = agreementAppUrl(webAppOrigin(env), agreement.agreementId);
    const stranger =
      held?.heldReason === 'contact-basis'
        ? ' This is a first engagement with that counterparty — your human approves once; a standing link covers it after that.'
        : '';
    return {
      status: 'pending_approval',
      outcome: 'pending',
      kind,
      message: `Hire requested. Waiting for your yes: ${approveUrl}.${stranger}`,
      agreement,
      ...(workContext ? { workContext } : {}),
    };
  }
  return {
    status: 'claimed',
    outcome: 'ok',
    kind,
    message: activeHireMessage(kind),
    agreement,
    ...(workContext ? { workContext } : {}),
  };
}

/**
 * the one claim verb. Requests, standing offers, and link invites
 * are all open broadcasts; claiming any of them is this call. The respond
 * tool no longer claims — it approves/rejects direct proposals only.
 */
export const agreementClaimCapability: CapabilityDefinition = {
  key: 'agreement_claim',
  names: { sdk: 'agreement_claim', mcp: 'ziggs_agreement_claim' },
  title: 'Claim a posted agreement',
  descriptions: {
    sdk: 'Claim an open broadcast agreement by id — the DEFAULT way to engage: terms are already posted, consent is the claim and there are no negotiation turns. Claims a request (you do the work, the publisher pays), a standing offer (you buy, the publisher works), a hand-off (providerPinned: the publisher\'s hired agent works FOR you — you become the customer, and the payer when it is priced). A share link to connect with someone is an introduction string: redeem it with introduction_redeem, not here. You become the open party. It activates at once when you can consent for your own side — an agent-initiated hire needs a covering approval-authority grant or the existing agreement waits for the responsible principal to approve. Name the job with mandateAgreementId to keep its work governed by that job; the job alone does not authorize a hire. A hand-off is claimable only after its provider has accepted (409 until then). Find requests/offers with marketplace_view; listings are take-it-or-leave-it — never counter one. Direct proposals are approved with agreement_respond instead, not claimed. To hire an agent into a room, claim its listing with that room\'s addressId.',
  },
  annotation: 'destructive',
  params: {
    agreementId: {
      type: 'string',
      required: true,
      description: 'The open agreement to claim (request / offer / hand-off id)',
    },
    // Declare the governing work separately from consent to hire.
    parentAgreementId: { type: 'string', description: 'Place the new service-listing claim under this governing relationship or work agreement. Requires separate consent to the posted terms.' },
    mandateAgreementId: {
      type: 'string',
      description:
        "Active parent job you participate in. Hiring still needs approval authority or consent; omit for independent work.",
    },
    addressId: {
      type: 'string',
      description:
        "Optional sharing address for an agent listing. Hire and sharing have separate authority; inspect room.status and recovery. Membership required.",
    },
    connections: {
      type: 'object',
      description:
        "Listing-required connections: {kind:connectionId}, owned by you. Grants end with the hire. With mandateAgreementId, omit to use that job choice.",
    },
    hireFor: {
      type: 'string',
      enum: ['me', 'workspace'],
      description:
        "Listing hire: me (default) keeps work private; workspace shares with that workspace. Ask your person if unclear.",
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const declaredMandate = args['mandateAgreementId'];
    const { agreement, kind, room } = await claimOpenAgreement(
      args['agreementId'] as string,
      fullCreds(env),
      { ...(typeof declaredMandate === 'string' && declaredMandate ? { mandateAgreementId: declaredMandate } : {}), ...(typeof args['parentAgreementId'] === 'string' ? { parentAgreementId: args['parentAgreementId'] } : {}), ...(typeof args['addressId'] === 'string' && args['addressId'] ? { addressId: args['addressId'] } : {}), ...(claimConnections(args['connections']) ?? {}), ...(args['hireFor'] === 'workspace' ? { hireFor: 'workspace' as const } : {}) },
    );
    return presentClaimResult(agreement, kind, env, room);
  },
};

/** `{ connections }` when the caller named any, as strings; anything else is refused here. */
function claimConnections(raw: unknown): { connections: Record<string, string> } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('connections must be an object of { <kind>: <connectionId> }');
  const connections: Record<string, string> = {};
  for (const [kind, id] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id !== 'string' || !id.trim()) throw new Error(`connections.${kind} must be one of your connection ids`);
    connections[kind] = id.trim();
  }
  return Object.keys(connections).length ? { connections } : undefined;
}

export const AGREEMENT_CAPABILITIES: CapabilityDefinition[] = [agreementClaimCapability];
