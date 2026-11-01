import { openConversation, type ChatOpenInvite } from '../http/ChatClient.js';
import { chatAppUrl } from '../utils/appUrls.js';
import { type CapabilityDefinition, fullCreds } from './types.js';
import { webAppOrigin } from './links.js';

/**
 * the decided chat surface for agents: chat_open only.
 * There is deliberately NO chat-listing tool on the SDK: taking part in a room
 * IS a grant on it, so "what chats can I see" is already answered by grant_list
 * scopeKind=address. MCP keeps its rich session-UX lister
 * (ziggs_chat_list) for humans in Cursor/Claude.
 */
export const openConversationCapability: CapabilityDefinition = {
  key: 'chat_open',
  names: { sdk: 'chat_open', mcp: 'ziggs_chat_open' },
  title: 'Open, invite to, or resume a conversation',
  descriptions: {
    sdk: 'Open a conversation or explicitly invite people to a room. To resume admission of an existing hire, pass only addressId and agreementId; this uses the same recovery as the room UI and never hires or charges again. participantId opens/reuses your person’s conversation with one person or agent, the same room each of their agents finds; newChat opens a separate subject, which can take a name. participantIds creates a separate group with the acting caller and those people; include a stable idempotencyKey for retries. addressId plus participantIds invites people into that exact room, requiring room access and admission authority. Every person needs a valid contact basis: shared organization membership, a link, or an applicable agreement. Each participant keeps their own agent and work relationships; opening a group selects no service agreement. Group creation never expands an existing private DM. Invited teammates read from admission onward. participantIds may name agents, when creating a group or inviting into one: each must be reachable (your own, one of your company, published, or already engaged). An agent you add joins at once if your person gave you approval authority; otherwise it is a proposal in the room, and the first person in the room to say yes admits it. The result lists each id as added, already-here or pending. To bring in an agent you would hire, claim its listing with the room\'s addressId instead. Your own missing seat is asked for with access_request. Reach another person through their user id, not an unpublished agent of theirs. If you cannot reach someone your person knows, ask your person to introduce you in a room. Opening does not send a message; message_send uses an explicit command.deliveries selection; no room is required. To list accessible rooms, use grant_list with scopeKind ["address"].',
  },
  annotation: 'write',
  params: {
    participantId: {
      type: 'string',
      description: 'Known user or agent id. For a person, use their user id. No existing address required; never guess ids.',
    },
    participantIds: { type: 'array', items: { type: 'string' }, description: '1–20 known people/agent ids, instead of participantId. Each invitation checks authority; agents may need approval.' },
    addressId: { type: 'string', description: 'Existing room. With participantIds: invite into it. With agreementId only: resume the approved hire admission without another hire or charge.' },
    idempotencyKey: { type: 'string', description: 'Required for group creation: a unique key for this conversation, reused unchanged on retries. A different participant set needs a new key.' },
    name: { type: 'string', description: 'New group/newChat name, 1–80 characters; not for pairs or team channels. Retries retain the first name. Admission authorities may rename it.' },
    createIfMissing: { type: 'boolean', description: 'Set false to reuse only an existing room with this participant. A missing room is refused without creating a replacement.' },
    newChat: {
      type: 'boolean',
      description:
        'Open a separate chat even though one is already open with the named participants. ' +
        'For when the conversation is genuinely its own subject and would confuse an ' +
        'existing thread. The separate chat does not become the main one, so a later ' +
        'call without this still returns the original. Leave unset to continue where ' +
        'you left off.',
    },
    agreementId: {
      type: 'string',
      description:
        'With addressId: resume that existing hire’s room admission. Otherwise, the hire this open is the working room for. On a store-claim kickoff, pass the ' +
        'claimed agreement id so the payer is stamped from-start in that room.',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    if (args.addressId && args.agreementId) {
      const result = await openConversation(args as Parameters<typeof openConversation>[0], fullCreds(env));
      return {
        ...result,
        appUrl: chatAppUrl(webAppOrigin(env), result.addressId),
        message: result.status === 'ready'
          ? 'The hired agent is admitted under this agreement. No new hire or charge was made.'
          : `Admission is still incomplete${result.reason ? `: ${result.reason}` : ''}. Retry this same call; do not claim again.`,
      };
    }
    if (!args.participantId && !Array.isArray(args.participantIds)) {
      throw new Error('participantId is required, or use participantIds to invite people');
    }
    if (args.participantIds !== undefined) {
      if (args.participantId !== undefined || !Array.isArray(args.participantIds) ||
          args.participantIds.length < 1 || args.participantIds.length > 20 ||
          args.participantIds.some(id => typeof id !== 'string' || !id.trim())) {
        throw new Error('Use participantIds containing 1–20 ids, without participantId');
      }
      if (!args.addressId && (typeof args.idempotencyKey !== 'string' || !args.idempotencyKey.trim())) {
        throw new Error('Group creation requires an idempotencyKey; reuse it when retrying');
      }
    } else if (args.addressId) {
      throw new Error('addressId requires participantIds');
    }
    if (typeof args.name === 'string' && args.name.trim() && !Array.isArray(args.participantIds) && args.newChat !== true) {
      throw new Error('A name is for a new group or a newChat room. Pair rooms take no name; the person is the name.');
    }
    const { addressId, reused, invited, name } = await openConversation({
      ...(typeof args.participantId === 'string' ? { participantId: args.participantId } : {}),
      ...(Array.isArray(args.participantIds) ? { participantIds: args.participantIds as string[] } : {}),
      ...(typeof args.addressId === 'string' ? { addressId: args.addressId } : {}),
      ...(typeof args.idempotencyKey === 'string' ? { idempotencyKey: args.idempotencyKey } : {}),
      ...(args.newChat === true ? { newChat: true } : {}),
      ...(typeof args.createIfMissing === 'boolean' ? { createIfMissing: args.createIfMissing } : {}),
      ...(typeof args.agreementId === 'string' && args.agreementId ? { agreementId: args.agreementId } : {}),
      ...(typeof args.name === 'string' && args.name.trim() ? { name: args.name.trim() } : {}),
    }, fullCreds(env));
    const agentId = fullCreds(env).agentId;
    const { people, pending } = roomRoster(args, invited, agentId);
    const lister = env.surface === 'mcp' ? 'ziggs_grant_list' : 'grant_list';
    const grantNote = `Use ${lister} with scopeKind ["address"] to inspect your room grants. Opening a conversation does not send a message or confirm that anyone has read it.`;
    // word the note from the outcome instead of covering both cases.
    // "Open (or reused)" told the agent the distinction existed and then
    // withheld it — worse than silence, because the agent cannot even tell
    // there is something to look up. A backend too old to report it keeps the
    // old both-cases wording, and `reused` is simply absent from the result.
    // A new group that named agents reports each of them too.
    const created =
      reused === false ? 'Created a new conversation with the named participants, so there is no history to catch up on.' : null;
    const outcomeNote =
      args.addressId
        ? inviteNote(invited)
        : created && invited?.length
        ? `${created} ${inviteNote(invited)}`
        : reused === true
        ? 'Reused the conversation you already had with the named participants, so it may already hold history — read it before you speak.'
        : reused === false
          ? 'Created a new conversation with the named participants, so there is no history to catch up on.'
          : 'Conversation is open (or reused).';
    return {
      addressId,
      appUrl: chatAppUrl(webAppOrigin(env), addressId),
      ...(agentId ? {actingAgentId: agentId} : {}),
      people,
      pending,
      ...(typeof reused === 'boolean' ? { reused } : {}),
      ...(name ? { name } : {}),
      ...(invited ? { invited } : {}),
      note: `${outcomeNote} ${grantNote}`,
    };
  },
};

/** Ids this open knows are in the room, and ids still waiting for approval. */
function roomRoster(
  args: Record<string, unknown>,
  invited: ChatOpenInvite[] | undefined,
  agentId: string,
): { people: string[]; pending: string[] } {
  const named = Array.isArray(args.participantIds)
    ? args.participantIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
    : typeof args.participantId === 'string' && args.participantId.trim()
      ? [args.participantId.trim()]
      : [];
  const pending = (invited ?? []).filter((row) => row.status === 'pending').map((row) => row.id);
  const waiting = new Set(pending);
  const here = (invited ?? []).filter((row) => row.status !== 'pending').map((row) => row.id);
  const people = [...new Set([...named.filter((id) => !waiting.has(id)), ...here, ...(agentId ? [agentId] : [])])];
  return { people, pending };
}

/** Say what happened to each invited id, so the agent reports it truthfully. */
function inviteNote(invited: ChatOpenInvite[] | undefined): string {
  if (!invited?.length) {
    return 'The named people can participate in this room. Their history access remains bounded by their grants.';
  }
  const ids = (status: ChatOpenInvite['status']) =>
    invited.filter((row) => row.status === status).map((row) => row.id);
  const parts: string[] = [];
  if (ids('added').length) parts.push(`Added: ${ids('added').join(', ')}.`);
  if (ids('already-here').length) parts.push(`Already in the room: ${ids('already-here').join(', ')}.`);
  if (ids('pending').length) {
    parts.push(
      `Proposed in the room, waiting for one person there to say yes: ${ids('pending').join(', ')}. The first answer decides; the agent cannot read or write here until then, and asking again does not make a second request.`,
    );
  }
  return `${parts.join(' ')} Invited people read from now on.`;
}

export const CHAT_CAPABILITIES: CapabilityDefinition[] = [openConversationCapability];
