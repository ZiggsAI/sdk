import { decodeOperatorKeyClaims } from '../shared/operatorKey.js';
import type { ChatReadDto } from '@ziggs-ai/contracts';
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
 * One room from `GET /messaging/addresses/mine`, as the server sends it.
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
  approveIn?: { kind: 'address'; addressId: string };
}

export interface OpenConversationInput {
  participantId?: string;
  participantIds?: string[];
  addressId?: string;
  idempotencyKey?: string;
  /** Name for a new group. Pair rooms take no name. */
  name?: string;
  newChat?: boolean;
  agreementId?: string;
  createIfMissing?: boolean;
}

export interface OpenConversationResult {
  addressId: string;
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
  const resumeHire = !!input?.addressId && !!input.agreementId;
  if (resumeHire && (input.participantId || input.participantIds || input.newChat !== undefined || input.name !== undefined || input.idempotencyKey !== undefined || input.createIfMissing !== undefined)) {
    throw new Error('To resume hire admission, pass only addressId and agreementId');
  }
  if (!input || (!resumeHire && !input.participantId && !input.participantIds?.length)) {
    throw new Error('participantId is required, or use participantIds to invite people');
  }
  assertCreds(creds, 'open conversation');

  const route = resumeHire
    ? `/messaging/addresses/${encodeURIComponent(input.addressId!)}/hires/${encodeURIComponent(input.agreementId!)}/admission`
    : '/messaging/addresses';
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
  if (!data?.['addressId'] || typeof data['addressId'] !== 'string') {
    throw new Error('Invalid response: expected { addressId } from POST /messaging/addresses');
  }
  // left UNDEFINED rather than defaulted when the backend does not
  // send it. A backend from before this field cannot be assumed to have created
  // the room — defaulting to false would report a reused conversation as fresh,
  // which is worse than saying nothing.
  if (resumeHire && (data.addressId !== input.addressId || data.agreementId !== input.agreementId || !['ready', 'admission_failed'].includes(String(data.status)))) {
    throw new Error('Invalid hire-admission response: expected the selected chat, hire and admission status');
  }
  const reused = data['reused'];
  const name = data['name'];
  const invited = Array.isArray(data['invited'])
    ? (data['invited'] as ChatOpenInvite[])
    : undefined;
  return {
    addressId: data['addressId'] as string,
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

export type ContextTemporal = 'from-now' | 'from-start';

export interface AddChatMemberInput {
  addressId: string;
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
 * POST /messaging/addresses/:addressId/members — add user/agent; agent-invite may return pending admission.
 */
export async function addChatMember(
  input: AddChatMemberInput,
  creds: Creds,
): Promise<AddChatMemberResult> {
  assertCreds(creds, 'add chat member');
  const res = await fetch(
    `${getBackendUrl()}/messaging/addresses/${encodeURIComponent(input.addressId)}/members`,
    {
      method: 'POST',
      headers: buildHeaders(creds),
      body: JSON.stringify({
        addressId: input.addressId,
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
    res = await fetch(`${getBackendUrl()}/messaging/addresses/mine${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: buildHeaders(creds),
    });
  } catch (e) {
    runtimeLog.warn('ChatClient', `⚠️ listMyChats failed: ${(e as Error).message}`);
    throw new Error(`GET /messaging/addresses/mine network error: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    runtimeLog.warn('ChatClient', `⚠️ listMyChats failed: ${res.status} ${res.statusText} ${body?.slice(0, 200)}`);
    throwApiError(res, body, `GET /messaging/addresses/mine failed: ${res.status}`);
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
  listMine()                                       { return listMyChats(this.creds); }
}
