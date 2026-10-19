import { resolveWebAppOrigin } from '../utils/appUrls.js';
import { createLink, listAgreements } from '../http/AgreementClient.js';
import { nextCall, type NextCall } from './nextCall.js';
import { type CapabilityDefinition, type CapabilityEnv, fullCreds } from './types.js';

export function webAppOrigin(env: CapabilityEnv): string {
  return resolveWebAppOrigin(env.webUrl);
}

/**
 * A link is reach-only — the follow-up move differs by surface tool names.
 *
 * Opening a chat is itself the admission: the backend issues a standing from-now
 * write grant to each side as it creates the room, so both delegates can
 * read and post immediately. Sharing what already exists is artifact_share for
 * one artifact, a chat_open invite for a room, or context_delegate for a slice
 * of a grant the agent holds.
 */
export function linkIsReachOnly(env: CapabilityEnv): string {
  return env.surface === 'mcp'
    ? 'A link is reach-only — it shares no context on its own. Open a chat with the PERSON on the other side (ziggs_chat_open, participantId = that link\'s `peer.id`): delivery lands in their mailbox and whoever runs that side picks it up, which is not yours to choose. Use `peer.id`, never a principal out of `parties` — those are display faces, and chat_open refuses a face because it names no single party. Opening the room admits both sides to read and post from then on. To share context that already exists, share one artifact with ziggs_artifact_share, invite them into a room you hold with ziggs_chat_open (chatId plus participantIds), or share a slice of a grant you hold with ziggs_context_delegate.'
    : 'A link is reach-only — it shares no context on its own. Open a chat with the PERSON on the other side; delivery lands in their mailbox and whoever runs that side picks it up, which is not yours to choose. Opening the room admits both sides to it from then on. To share context that already exists, share a slice of a grant you hold with context_delegate, or ask the peer owner to issue one.';
}

const LINK_STATUSES = ['active', 'open', 'cancelled', 'all'] as const;

/**
 * Seat ceiling for one invite. ⚠️ Mirrors the server's own ceiling, which
 * rejects anything past it; this copy exists only so the tool description states
 * the limit instead of letting an agent discover it by getting a 400.
 */
const MAX_LINK_INVITE_CLAIMS = 25;

// Two tools. Links are agreements, so the agreement verbs carry the rest: claim
// an invite with agreement_claim, end a link with agreement_revoke.
//
// There were three. `link_create_invite` was the same act as `link_propose` with
// a different way of naming the other side, and an assistant had to choose
// between them before knowing which applied. One verb takes an email, an agent
// id, or nothing.

export const listLinksCapability: CapabilityDefinition = {
  key: 'link_list',
  names: { sdk: 'link_list', mcp: 'ziggs_link_list' },
  title: 'List your links',
  descriptions: {
    sdk: 'List link agreements for this agent — bilateral agent-to-agent trust relationships (GET /agreements?engagementKind=link). Any agent can link with any other agent. Defaults to ACTIVE links only; pass status to see pending proposals ("open") or revoked ones ("cancelled"). Each item is a link summary: agreementId, status, proposalStatus, parties. Each active link carries `peer` — the person on the other side, by an id you can address (`peer.id`) plus their name. Address them with that. The principals in `parties` are display faces masked per viewer, and the actor slots record which agent carried the paperwork; neither is an address. Connect with someone new using link_propose; end a link with agreement_revoke.',
  },
  annotation: 'read-only',
  params: {
    status: {
      type: 'string',
      enum: LINK_STATUSES,
      description:
        'active (default) = established links; open = pending proposals/invites awaiting approval or claim; cancelled = revoked; all = every link regardless of status',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const status = (args['status'] as string | undefined) ?? 'active';
    if (!LINK_STATUSES.includes(status as (typeof LINK_STATUSES)[number])) {
      throw new Error('status must be one of active, open, cancelled, all');
    }
    const links = await listAgreements(
      {
        engagementKind: 'link',
        ...(status === 'all' ? {} : { status }),
      },
      fullCreds(env),
    );
    const active = links.filter((a) => a.status === 'active');

    // A link grants reach and nothing else, so the move after seeing one is
    // always the same: open a room with that peer, or share context explicitly.
    //
    // The peer id comes from the server now. Two earlier attempts read it off
    // `parties` here and both were wrong: the peer's `actor` is courier info,
    // null on any link two people formed from the web; the peer's `principal`
    // is display state, masked to a `psn_` face across an org boundary — which
    // is every link — and chat_open refuses a face. Neither could be fixed on
    // this side, because the addressable id is not in the payload to find. It
    // is now, as `peer`, resolved relative to whoever asked.
    const readPlan: NextCall[] = [];
    let unnamedPeers = 0;
    for (const link of active.slice(0, 3)) {
      const peer = link.peer?.id;
      if (!peer) {
        unnamedPeers += 1;
        continue;
      }
      readPlan.push(
        nextCall(
          env,
          'chat_open',
          { participantId: peer },
          `open a room with ${link.peer?.name ?? 'this linked peer'} — a link alone carries no context`,
        ),
      );
    }
    if (unnamedPeers > 0) {
      readPlan.push(
        nextCall(
          env,
          'chat_open',
          undefined,
          'open a room with a linked peer: participantId is that link\'s `peer.id`. Do NOT pass a principal out of `parties` — those are display faces and chat_open refuses them',
        ),
      );
    }
    if (active.length) {
      readPlan.push(
        nextCall(
          env,
          'artifact_share',
          undefined,
          'share context that already exists: a link does not share any on its own. One artifact with artifact_share; a room you hold by inviting them with chat_open (chatId plus participantIds)',
        ),
      );
    }

    return {
      count: links.length,
      status,
      links,
      ...(readPlan.length ? { readPlan } : {}),
      ...(active.length ? { nextSteps: linkIsReachOnly(env) } : {}),
    };
  },
  sdkOptions: { isGenericFallback: true },
};

/**
 * The one way to connect with someone.
 *
 * This used to ride the propose grammar as `engagementKind: "link"`, which put
 * bilateral trust on the same verb as commercial terms it has none of: no
 * price, no chat, no work. It moved here, and then absorbed the other two ways
 * of doing the same thing: naming an agent id, naming an email — a form the
 * backend had but no tool ever sent, so an assistant could not name a person at
 * all — and minting a share link.
 *
 * `to` is an email or an agent id, and the link is with the PERSON either way.
 * An id is only a way to find its owner: naming one specific assistant is
 * fragile, because people connect more than one, swap them, and someone who has
 * connected none has no agent to name. An agent that answers to an ORG is
 * refused rather than resolved, since that would link the caller to whoever
 * happens to own the org, who consented to nothing.
 *
 * The answer is constant. It never says whether the address belonged to anyone,
 * whether the two were already connected, or whether this was a repeat — a
 * response that distinguished those would be a way to check who has an account.
 */
export const proposeLinkCapability: CapabilityDefinition = {
  key: 'link_propose',
  names: { sdk: 'link_propose', mcp: 'ziggs_link_propose' },
  title: 'Connect with someone',
  descriptions: {
    sdk: "Connect with a person: pass their email, or the id of an agent that answers to them, and Ziggs delivers the invitation. The link is with the PERSON either way — an agent id is only a way to find its owner, and an agent that answers to an organisation is refused, because a link connects two people. Leave `to` out to get a share link you hand over yourself. A link is reach and nothing else: no chat, no money, no work. The answer is the same every time, so it never tells you whether that address has an account.",
  },
  annotation: 'destructive',
  params: {
    to: {
      type: 'string',
      description:
        "The person to connect with: their email address, or the id of an agent that answers to them. Leave it out for a share link you pass on yourself.",
    },
    message: {
      type: 'string',
      description: 'Optional note shown to whoever is asked to accept it.',
    },
    maxClaims: {
      type: 'number',
      description: `Share links only: how many people may claim this one link (default 1, max ${MAX_LINK_INVITE_CLAIMS}). Each claimer forms their own separate connection with you — this does not create a group.`,
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const to = (args['to'] as string | undefined)?.trim();
    const maxClaims = args['maxClaims'] as number | undefined;
    const { shareUrl, agreementId } = await createLink(
      {
        ...(to ? { to } : {}),
        ...(args['message'] ? { description: args['message'] as string } : {}),
        ...(maxClaims == null || to ? {} : { maxClaims }),
      },
      fullCreds(env),
    );

    // Two messages, chosen by what the CALLER passed rather than by what came
    // back. That is the whole discipline: the caller knows whether it named
    // somebody, so branching on it discloses nothing, while branching on
    // anything the server learned about the target would.
    //
    // `agreementId` follows the same discipline: the route carries it for an
    // agent id and an open invite and never for an email, so which of the two it
    // is depends on what the caller passed and on nothing the server learned. It
    // is what lets a caller reference the row and check on it; without it,
    // several agents connecting in one run each minted a link toward the others
    // in both directions, because none of them could ask.
    return {
      status: 'sent' as const,
      outcome: 'pending' as const,
      shareUrl,
      agreementId,
      message: to
        ? `Invitation sent to ${to}. You will not be told whether they already had an account, whether you were already connected, or whether this repeated an earlier invitation — the answer is the same in every case, on purpose. It becomes a live connection when they accept. ${linkIsReachOnly(env)}`
        : `Share link created, valid 7 days. Give your human shareUrl and nothing else: it is the whole invite. ${linkIsReachOnly(env)}`,
      readPlan: [
        nextCall(
          env,
          'link_list',
          { status: 'open' },
          'check whether it has been accepted yet',
        ),
      ],
    };
  },
  sdkOptions: { isAgreementCreation: true },
};

export const LINK_CAPABILITIES: CapabilityDefinition[] = [
  proposeLinkCapability,
  listLinksCapability,
];
