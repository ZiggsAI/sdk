import type { WriteSource } from '../capabilities/sources.js';
import { decodeOperatorKeyClaims } from '../shared/operatorKey.js';
import type { ChatReadDto } from '@ziggs-ai/contracts';
import type {
  MessageDelivery as WireMessageDelivery,
  SendChatMessageResult as WireSendChatMessageResult,
} from '@ziggs-ai/contracts';
import { runtimeLog } from '../shared/runtimeLog.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { type Creds } from '../types.js';
import { throwApiError } from '../shared/apiError.js';
import { buildCredsHeaders } from './operatorHeaders.js';

// Auth, agent and the wake's lane, from the one helper — see operatorHeaders.
const buildHeaders = buildCredsHeaders;

function assertCreds(creds: Creds | undefined | null, op: string): asserts creds is Creds {
  if (!creds?.operatorKey) throw new Error(`operatorKey is required for ${op}`);
  if (!creds?.agentId && !decodeOperatorKeyClaims(creds.operatorKey)?.connectionClientId) throw new Error(`agentId is required for ${op}`);
}


/**
 * One room from `GET /chats/mine`, as the server sends it.
 *
 * The backend answers `toChatReadDto(...)`, so this is that type rather than
 * a restatement of it. The restatement had drifted both ways: it declared
 * `orgId` and `isOrgChat`, neither of which the wire carries — a caller
 * branching on `isOrgChat` was branching on `undefined` — and it omitted
 * seven fields the wire does send, including `name`, `updatedAt` and
 * `lastMessage`, which are the ones this list exists to let an agent triage
 * with without a second call.
 */
export type ChatSummary = ChatReadDto;

/** What happened to one id when chat_open invited into an existing room. */
export interface ChatOpenInvite {
  id: string;
  kind: 'person' | 'agent';
  /** pending: an agent's joining waits for the people in the room to approve it. */
  status: 'added' | 'already-here' | 'pending';
  admissionId?: string;
  approvers?: Array<{ id: string; name: string | null }>;
  approveIn?: { kind: 'chat'; chatId: string };
}

export interface OpenConversationInput {
  participantId?: string;
  participantIds?: string[];
  chatId?: string;
  idempotencyKey?: string;
  /** Name for a new group. Pair rooms take no name. */
  name?: string;
  newChat?: boolean;
  agreementId?: string;
  createIfMissing?: boolean;
}

export interface OpenConversationResult {
  chatId: string;
  reused?: boolean;
  invited?: ChatOpenInvite[];
  name?: string;
  agreementId?: string;
  status?: 'ready' | 'admission_failed';
  reason?: string;
}

export async function openConversation(
  participant: string | OpenConversationInput,
  creds: Creds,
  { newChat = false, agreementId, createIfMissing }: { newChat?: boolean; agreementId?: string; createIfMissing?: boolean } = {},
): Promise<OpenConversationResult> {
  const input: OpenConversationInput = typeof participant === 'string'
    ? { participantId: participant, ...(newChat ? { newChat } : {}), ...(agreementId ? { agreementId } : {}), ...(createIfMissing !== undefined ? { createIfMissing } : {}) }
    : participant;
  const resumeHire = !!input?.chatId && !!input.agreementId;
  if (resumeHire && (input.participantId || input.participantIds || input.newChat !== undefined || input.name !== undefined || input.idempotencyKey !== undefined || input.createIfMissing !== undefined)) {
    throw new Error('To resume hire admission, pass only chatId and agreementId');
  }
  if (!input || (!resumeHire && !input.participantId && !input.participantIds?.length)) {
    throw new Error('participantId is required, or use participantIds to invite people');
  }
  assertCreds(creds, 'open conversation');

  const route = resumeHire
    ? `/chats/${encodeURIComponent(input.chatId!)}/hires/${encodeURIComponent(input.agreementId!)}/admission`
    : '/chats';
  const res = await fetch(`${getBackendUrl()}${route}`, {
    method: 'POST',
    headers: buildHeaders(creds),
    // Only sent when asked for: an older backend ignores the field, so a
    // caller that never wants a separate room behaves identically either way.
    body: JSON.stringify(resumeHire ? {} : input),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `openConversation failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!data?.['chatId'] || typeof data['chatId'] !== 'string') {
    throw new Error('Invalid response: expected { chatId } from POST /chats');
  }
  // left UNDEFINED rather than defaulted when the backend does not
  // send it. A backend from before this field cannot be assumed to have created
  // the room — defaulting to false would report a reused conversation as fresh,
  // which is worse than saying nothing.
  if (resumeHire && (data.chatId !== input.chatId || data.agreementId !== input.agreementId || !['ready', 'admission_failed'].includes(String(data.status)))) {
    throw new Error('Invalid hire-admission response: expected the selected chat, hire and admission status');
  }
  const reused = data['reused'];
  const name = data['name'];
  const invited = Array.isArray(data['invited'])
    ? (data['invited'] as ChatOpenInvite[])
    : undefined;
  return {
    chatId: data['chatId'] as string,
    ...(resumeHire ? {
      agreementId: input.agreementId,
      status: data.status as OpenConversationResult['status'],
      ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    } : {}),
    ...(typeof reused === 'boolean' ? { reused } : {}),
    ...(typeof name === 'string' && name ? { name } : {}),
    ...(invited ? { invited } : {}),
  };
}

export interface SendChatMessageInput {
  /**
   * Chat to send in. Required unless `to` names a person you already
   * share a conversation with.
   */
  chatId?: string;
  /**
   * User or agent id of someone you already have a conversation with.
   * Resolves that pair room and sends. Does not open contact. Ignored
   * when `chatId` is set (`chatId` wins).
   */
  to?: string;
  /**
   * Recipient id. Optional: when omitted, the one other participant in the
   * room is the receiver; with several, the backend infers one when Jev is
   * confident. Otherwise it stores room context without a specific wake.
   * Explicit addressing is required for a guaranteed target.
   */
  receiverId?: string;
  text: string;
  messageId: string;
  entryType?: string;
  contentType?: string;
  underAgreementId?: string;
  /** Governing service agreement; independent of representation. */
  conversationAgreementId?: string;
  taskId?: string;
  /** What this text drew on. See {@link WriteSource}. */
  sources?: WriteSource[];
}

/**
 * Where the server says a send landed.
 *
 * The contract's own shape, re-exported rather than restated: it shipped in
 * contracts 0.7.7, and the hand-written stand-in that carried it until then is
 * gone. What the fields mean is worth keeping in front of a caller, because
 * the receipt is easy to over-read:
 *
 * The caller may omit the receiver and have it inferred, or have it widened to
 * the room's humans, so the destination is the server's answer rather than the
 * caller's request. `accepted` is the message being created — not a claim that
 * anyone read it. Routing is asynchronous and unconfirmed by this receipt; the
 * `wakesAgent` field that once rode along was removed for exactly that reason
 * and is not coming back.
 */
export type MessageDelivery = WireMessageDelivery & {
  assignee?: string | null;
  reachable?: 'yes' | 'no';
  reason?: string;
  lastRead?: string | null;
};

/**
 * The send result as a caller here holds it.
 *
 * `delivery` is optional on the way in and required in the contract, which is
 * not a disagreement about the wire: this client is installed independently of
 * the backend it talks to, and a server from before the field existed answers
 * without one.
 */
export type SendChatMessageResult = Omit<WireSendChatMessageResult, 'delivery'> & {
  delivery?: MessageDelivery;
  /**
   * What covers this message, when something counts it: a hire's shared
   * allowance, or a listed agent's free messages for a stranger ("2 of 3 free
   * messages used with seo-growth."). Absent for ordinary conversation.
   */
  coverage?: ConversationCoverageReceipt;
};

/** The server's receipt for a counted message. */
export interface ConversationCoverageReceipt {
  agreementId: string;
  messagesUsed: number;
  messageLimit: number | null;
  message: string;
}

function coverageFrom(value: unknown): ConversationCoverageReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  return typeof row['agreementId'] === 'string' &&
    typeof row['message'] === 'string' &&
    typeof row['messagesUsed'] === 'number' &&
    (row['messageLimit'] === null || typeof row['messageLimit'] === 'number')
    ? {
        agreementId: row['agreementId'],
        messagesUsed: row['messagesUsed'],
        messageLimit: row['messageLimit'] as number | null,
        message: row['message'],
      }
    : null;
}

export type ContextTemporal = 'from-now' | 'from-start';

export interface AddChatMemberInput {
  chatId: string;
  memberId: string;
  memberType: 'user' | 'agent';
  temporal?: ContextTemporal;
}

export interface ChatPendingAdmission {
  admissionId: string;
  agentId: string;
  issuerId: string;
  invitedBy: 'user' | 'agent';
  temporal: ContextTemporal;
  status: 'pending' | 'approved' | 'rejected';
  approvals?: unknown[];
  createdAt?: string;
}

export type AddChatMemberResult =
  | { status: 'pending'; pendingAdmission: ChatPendingAdmission }
  | { status: 'approved'; chat?: unknown }
  | { chat?: unknown };

/**
 * POST /chats/:chatId/members — add user/agent; agent-invite may return pending admission.
 */
export async function addChatMember(
  input: AddChatMemberInput,
  creds: Creds,
): Promise<AddChatMemberResult> {
  assertCreds(creds, 'add chat member');
  const res = await fetch(
    `${getBackendUrl()}/chats/${encodeURIComponent(input.chatId)}/members`,
    {
      method: 'POST',
      headers: buildHeaders(creds),
      body: JSON.stringify({
        chatId: input.chatId,
        memberId: input.memberId,
        memberType: input.memberType,
        temporal: input.temporal,
      }),
    },
  );

  const body = await res.text().catch(() => '');
  if (!res.ok) {
    throwApiError(res, body, `addChatMember failed: ${res.status} ${res.statusText}`);
  }

  const data = JSON.parse(body) as Record<string, unknown>;
  if (data['status'] === 'pending' && data['pendingAdmission']) {
    return {
      status: 'pending',
      pendingAdmission: data['pendingAdmission'] as ChatPendingAdmission,
    };
  }
  if (data['status'] === 'approved') {
    return { status: 'approved', chat: data['chat'] };
  }
  return { chat: data['chat'] };
}

/**
 * POST /chats/:chatId/messages, or POST /chats/messages when `to` names
 * an existing participant and `chatId` is omitted.
 */
export async function sendChatMessage(
  input: SendChatMessageInput,
  creds: Creds,
): Promise<SendChatMessageResult> {
  assertCreds(creds, 'send chat message');
  const chatId = typeof input.chatId === 'string' ? input.chatId.trim() : '';
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  if (!chatId && !to) {
    throw new Error('chatId or to is required for send chat message');
  }
  const entryType = input.entryType ?? 'message';
  const contentType = input.contentType ?? 'text';
  const personSend = !chatId && Boolean(to);
  const url = personSend
    ? `${getBackendUrl()}/chats/messages`
    : `${getBackendUrl()}/chats/${encodeURIComponent(chatId)}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(creds),
    body: JSON.stringify({
      ...(personSend ? { to } : { chatId }),
      messageId: input.messageId,
      text: input.text,
      entryType,
      contentType,
      // Canonical wire shape is `{ id, type? }`; bare strings are still
      // accepted by the backend after edge normalize, but first-party
      // clients send the object.
      receiver: input.receiverId ? { id: input.receiverId } : undefined,
      underAgreementId: input.underAgreementId,
      conversationAgreementId: input.conversationAgreementId,
      taskId: input.taskId,
      ...(input.sources ? { sources: input.sources } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `sendChatMessage failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const delivery = data?.['delivery'];
  const coverage = coverageFrom(data?.['coverage']);
  return {
    success: Boolean(data?.['success']),
    message: String(data?.['message'] ?? 'ok'),
    messageId: String(data?.['messageId'] ?? input.messageId),
    chatId: String(data?.['chatId'] ?? chatId),
    // Passed through as the server reported it, or absent. Never reconstructed
    // from the request: the whole point is that the destination may not be the
    // one the caller named.
    ...(delivery && typeof delivery === 'object'
      ? { delivery: delivery as MessageDelivery }
      : {}),
    ...(coverage ? { coverage } : {}),
  };
}

export async function listMyChats(
  creds: Creds,
  filters: { participantId?: string; readable?: boolean } = {},
): Promise<ChatSummary[]> {
  assertCreds(creds, 'list my chats');
  const query = new URLSearchParams();
  if (filters.participantId) query.set('participantId', filters.participantId);
  if (filters.readable !== undefined) query.set('readable', String(filters.readable));
  const qs = query.toString();

  // empty array only for a genuine empty 200; any failure (non-2xx /
  // network) throws so ziggs_chat_list reports a real error instead of "you
  // have no chats". HTTP failures are ApiError (status/body/code).
  let res: Response;
  try {
    res = await fetch(`${getBackendUrl()}/chats/mine${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: buildHeaders(creds),
    });
  } catch (e) {
    runtimeLog.warn('ChatClient', `⚠️ listMyChats failed: ${(e as Error).message}`);
    throw new Error(`GET /chats/mine network error: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    runtimeLog.warn('ChatClient', `⚠️ listMyChats failed: ${res.status} ${res.statusText} ${body?.slice(0, 200)}`);
    throwApiError(res, body, `GET /chats/mine failed: ${res.status}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return Array.isArray(data?.['chats']) ? (data['chats'] as ChatSummary[]) : [];
}

export class ChatClient {
  private creds: Creds;

  /**
   * @param operatorKey Agent-scoped or fleet operator key.
   * @param agentId Required for fleet keys (sent as X-Agent-Id). Omit for agent-scoped keys.
   */
  constructor(operatorKey: string, agentId?: string) {
    if (!operatorKey) throw new Error('ChatClient: operatorKey is required');
    // agentId may be absent for agent-scoped keys; the Creds-based
    // standalone functions still assert it per call.
    this.creds = { operatorKey, agentId } as Creds;
  }

  open(participant: string | OpenConversationInput, opts?: { newChat?: boolean; agreementId?: string; createIfMissing?: boolean }) { return openConversation(participant, this.creds, opts); }
  addMember(input: AddChatMemberInput)             { return addChatMember(input, this.creds); }
  sendMessage(input: SendChatMessageInput)         { return sendChatMessage(input, this.creds); }
  listMine()                                       { return listMyChats(this.creds); }
}
