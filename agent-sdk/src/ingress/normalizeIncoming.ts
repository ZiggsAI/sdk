import type { AgreementParties } from '@ziggs-ai/api-client';

/** Backend wire operations that map to FSM `proposal-resolved`. */
const PROPOSAL_RESOLVED_OPERATIONS = new Set([
  'proposal_approved',
  'proposal_rejected',
  'proposal_approved_execute',
]);

export interface NormalizedEvent {
  chatId: string | null;
  event: {
    senderId?: string;
    senderType?: string;
    receiverId?: string;
  assigneeId?: string;
    /**
     * Backend per-delivery id of the chat row this event came from. The one
     * field of the event that is identical on live push and on catch-up
     * redelivery, so it anchors the wake's idempotency keys (deliveryWriteKeys).
     */
    messageId?: string;
    timestamp: number;
    /**
     * `notification` = lifecycle / status notice. Not counterparty
     * speech; Claude parks without a model turn. Terminal task notices still
     * use `task_result` so orchestrators see completions.
     */
    type: 'task_result' | 'message' | 'agreement_lifecycle' | 'notification';
    /** Wire `entryType` when present (kept so brains can tell notice vs speech). */
    entryType?: string;
    operation?: string;
    agreementId?: string;
    /** Agreement row stamp — host skip for agent-formed activation reads this. */
    formedBy?: 'principal' | 'agent';
    result?: unknown;
    text?: string;
  };
}

interface WireTask {
  taskId?: string;
  agentId?: string;
  executorId?: string;
  payerId?: string;
  proposedTo?: string;
  createdBy?: string;
  parentTaskId?: string;
  state?: string;
  proposal?: unknown;
  agreement?: { parties?: AgreementParties };
}

interface WireMetadata {
  chatId?: string;
  messageId?: string;
  entryType?: string;
  contentType?: string;
  operation?: string;
  agreementId?: string;
  sender?: { id?: string; type?: string };
  receiver?: { id?: string };
  /** Inbox rewrite: assigned mail is this agent's even when the chat row names a human. */
  receiverId?: string;
  assigneeId?: string;
  task?: WireTask;
  // the inbox-pull wire nests classifier data under `service`
  // (backend `toMessageWireDto`). Read it from here; the top-level `task` /
  // `operation` / `agreementId` above stay as a fallback for direct-injection
  // callers (the test launcher builds metadata by hand).
  service?: {
    conversationAgreementId?: string;
    task?: WireTask;
    operation?: string;
    agreement?: {
      agreementId?: string;
      status?: string;
      formedBy?: string;
      proposal?: { status?: string };
      parties?: AgreementParties;
      approvals?: Array<{ partyId?: string; status?: string; role?: string }>;
    };
    agreementId?: string;
  };
  [key: string]: unknown;
}

interface NormalizeArgs {
  text: string;
  metadata?: WireMetadata;
  ownAgentId?: string | null;
}

function normalizeChatId(metadata: WireMetadata): string | null {
  return metadata.chatId || null;
}

function normalizeReceiverId(metadata: WireMetadata, taskData: WireTask | null): string | null {
  const rewritten =
    typeof metadata.receiverId === 'string' && metadata.receiverId
      ? metadata.receiverId
      : null;
  return rewritten || metadata.receiver?.id || taskData?.executorId || taskData?.proposedTo || null;
}

function isTaskRelated(metadata: WireMetadata, taskData: WireTask | null): boolean {
  if (!taskData?.taskId) return false;
  const entryType = metadata.entryType || 'message';
  const contentType = metadata.contentType || 'text';
  return (
    entryType === 'notification'
    || contentType === 'task'
    || Boolean(taskData.state || taskData.proposal || taskData.parentTaskId || taskData.executorId || taskData.agentId || taskData.payerId || taskData.createdBy)
  );
}

function wireOperation(metadata: WireMetadata): string | undefined {
  const op = metadata.service?.operation ?? metadata.operation;
  return typeof op === 'string' ? op : undefined;
}

function wireAgreementId(metadata: WireMetadata): string {
  const raw =
    metadata.service?.conversationAgreementId ??
    metadata.service?.agreementId ??
    metadata.service?.agreement?.agreementId ??
    metadata.agreementId;
  return typeof raw === 'string' ? raw : '';
}

function wireFormedBy(metadata: WireMetadata): 'principal' | 'agent' | undefined {
  const raw = metadata.service?.agreement?.formedBy;
  return raw === 'principal' || raw === 'agent' ? raw : undefined;
}

/**
 * Self-hire / fully-consented create activates before the chat fan-out lands.
 * The wire still says `proposal_created`, but the embedded agreement is already
 * `active` / proposal `approved`. That is the hire work signal (same as
 * `proposal_approved_execute`) — Claude must not park it as a notice.
 */
function isAlreadyActivatedProposalCreated(metadata: WireMetadata): boolean {
  if (wireOperation(metadata) !== 'proposal_created') return false;
  const agr = metadata.service?.agreement;
  if (!agr || typeof agr !== 'object') return false;
  const status = agr.status;
  const proposalStatus = agr.proposal?.status;
  return status === 'active' || proposalStatus === 'approved';
}

/**
 * a `proposal_created` notification addressed to a party whose
 * approval is PENDING is a consent REQUEST, not a status notice. The backend
 * fans `proposal_created` out specifically to the pending approvers
 *, and parking it meant the hand-off provider — or any
 * agent whose consent a proposal awaits — was alerted and then never looked:
 * the approval sat pending until a human nudged the chat. Same technique as
 * isAlreadyActivatedProposalCreated: reclassify by what the
 * embedded agreement SAYS rather than adding a new wake word.
 */
function isPendingApprovalRequestNotification(metadata: WireMetadata): boolean {
  if (wireOperation(metadata) !== 'proposal_created') return false;
  const receiverId = metadata.receiver?.id;
  if (!receiverId) return false;
  const approvals = metadata.service?.agreement?.approvals;
  if (!Array.isArray(approvals)) return false;
  return approvals.some(
    (a) => a && a.partyId === receiverId && a.status === 'pending',
  );
}

function isAgreementLifecycleNotification(metadata: WireMetadata): boolean {
  const entryType = metadata.entryType || 'message';
  if (entryType !== 'notification') return false;
  const operation = wireOperation(metadata);
  if (typeof operation === 'string' && PROPOSAL_RESOLVED_OPERATIONS.has(operation)) {
    return true;
  }
  return (
    isAlreadyActivatedProposalCreated(metadata) ||
    isPendingApprovalRequestNotification(metadata)
  );
}

function isTerminalTaskState(state: unknown): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

/**
 * Classify + shape a wire delivery into a lane-routable event. Targeting is
 * backend policy now (delivery law, phase 4): the inbox loop only ever delivers
 * what is fenced to this agent, so there is no client-side "is this for me"
 * relevance gate — this function decides SHAPE (message vs task_result vs
 * agreement_lifecycle vs notification) and the fields the FSM / SessionResolver /
 * deliveryWriteKeys depend on, nothing more. `ownAgentId` is accepted for call-site
 * compatibility but no longer gates anything.
 */
export function normalizeIncomingEvent({ text, metadata = {} }: NormalizeArgs): NormalizedEvent {
  // classifier data lives under `service` on the inbox-pull wire;
  // fall back to top-level for hand-built (direct-injection) metadata.
  const taskData = (metadata.service?.task ?? metadata.task) || null;
  const chatId = normalizeChatId(metadata);
  const receiverId = normalizeReceiverId(metadata, taskData);
  const senderType = metadata.sender?.type ? String(metadata.sender.type).toUpperCase() : undefined;
  const entryType =
    typeof metadata.entryType === 'string' && metadata.entryType
      ? metadata.entryType
      : undefined;

  const wakeAgreementId = wireAgreementId(metadata);
  const formedBy = wireFormedBy(metadata);
  const base = {
    senderId: metadata.sender?.id,
    senderType,
    receiverId: receiverId || undefined,
    assigneeId: typeof metadata.assigneeId === 'string' ? metadata.assigneeId : undefined,
    messageId: typeof metadata.messageId === 'string' && metadata.messageId ? metadata.messageId : undefined,
    timestamp: Date.now(),
    ...(entryType ? { entryType } : {}),
    ...(wakeAgreementId ? { agreementId: wakeAgreementId } : {}),
    ...(formedBy ? { formedBy } : {}),
  };

  if (isAgreementLifecycleNotification(metadata)) {
    const operation = isAlreadyActivatedProposalCreated(metadata)
      ? 'proposal_approved_execute'
      : wireOperation(metadata);
    const agreementId = wireAgreementId(metadata);
    return {
      chatId,
      event: {
        ...base,
        type: 'agreement_lifecycle',
        operation,
        agreementId,
        text,
      },
    };
  }

  if (isTaskRelated(metadata, taskData)) {
    // active/spawn chat notices are not work — real assignment arrives
    // on the task channel (`tasksAwaitingMe` → wakeTaskAssignment). Keep terminal
    // task notices as `task_result` so orchestrators still see completions.
    if (entryType === 'notification' && !isTerminalTaskState(taskData?.state)) {
      return {
        chatId,
        event: {
          ...base,
          type: 'notification',
          result: taskData,
          text,
          operation: metadata.service?.operation ?? metadata.operation,
        },
      };
    }
    return {
      chatId,
      event: { ...base, type: 'task_result', result: taskData, text },
    };
  }

  // residual lifecycle notices (proposal_created, agreement active, …)
  // must not fall through as counterparty `message` speech.
  if (entryType === 'notification') {
    const operation = metadata.service?.operation ?? metadata.operation;
    const rawAgreementId = metadata.service?.agreementId ?? metadata.agreementId;
    return {
      chatId,
      event: {
        ...base,
        type: 'notification',
        text,
        ...(typeof operation === 'string' ? { operation } : {}),
        ...(typeof rawAgreementId === 'string' ? { agreementId: rawAgreementId } : {}),
      },
    };
  }

  return {
    chatId,
    event: { ...base, type: 'message', text },
  };
}
