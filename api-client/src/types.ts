import {
  AGREEMENT_ENGAGEMENT_KIND,
  BROADCAST_TARGETS,
  COMPANY_AGREEMENT_TARGET,
  MESSAGE_CONTENT_TYPE,
  OPEN_AGREEMENT_TARGET,
  ORG_AGREEMENT_TARGET,
  isBroadcastTarget,
  partyActorIds,
  partySideIds,
  type AgreementPartySide,
  type AgreementParties,
  type AgreementStatusValue,
  type BroadcastAudience,
  type InboxDeliveryRef,
  type InboxPartyKind,
  type InboxRequestChannel,
  type PrincipalPresentation,
  type TaskStateValue,
} from '@ziggs-ai/contracts';
/**
 * One failure shape for every HTTP client path.
 *
 * `status` and optional machine `code` come from the response; `body` is the
 * raw text so callers can re-parse without scraping concatenated messages.
 * A 429 is {@link RateLimitedError}, which adds the server's wait.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
    public readonly code?: string | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** HTTP 429 — same fields as {@link ApiError}, plus the server's Retry-After. */
export class RateLimitedError extends ApiError {
  /** How long the server said to wait. Null when it said nothing. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    retryAfterMs: number | null,
    body?: string,
    code?: string | null,
  ) {
    super(message, 429, body, code);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export interface Creds {
  executionContextId?: string;
  operatorKey: string;
  agentId: string;
  /** Presentation routing only; authority comes from the execution context. */
  laneId?: string;
  /**
   * This host's stable identity, sent as `X-Ziggs-Instance` on inbox reads and
   * acks. Set it only on a rail whose PROCESS is not its host — the CLI, one
   * hosted-MCP connection among the many a backend task serves. Everything
   * long-lived leaves it unset and the process names itself. See
   * `src/instanceIdentity.ts` for what each rail sends.
   */
  instanceId?: string;
  /**
   * This window, sent as `X-Ziggs-Session`. Reconnects that present the same
   * id land on the same row. Unset on a long-lived process: the inbox host
   * header is the window.
   */
  clientSessionId?: string;
  /** Comma-separated workspace ids. Sent as `X-Ziggs-Workspaces`. Absent does not narrow. */
  workspaceIds?: string;
  /** Connection label, sent as `X-Ziggs-App`. */
  app?: string;
  /** Person-readable window name, sent as `X-Ziggs-Session-Name`. */
  sessionName?: string;
}

export type TaskState = TaskStateValue;

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

export interface PlanStep {
  stepId: string;
  status: PlanStepStatus;
  result?: unknown;
}

export interface Task {
  executorIsYou?: boolean;
  control?: import('./http/TaskClient.js').TaskControl | null;
  taskId: string;
  description: string;
  /**
   * Short row label. The backend always resolves it — falling back
   * to a trimmed description for tasks that never set one — so render it
   * unconditionally instead of re-deriving the fallback. Optional here only
   * because a server predating the field omits it.
   */
  title?: string;
  agentId?: string;
  executorId?: string;
  payerId?: string;
  /** Explicit delegation target — id of the agent/user this task is assigned to, or null when unassigned. */
  assigneeId?: string | null;
  agreementId?: string;
  /** Compact reference to the governing agreement. Read endpoints
   * never inline the full agreement — fetch it via getAgreement when the
   * paper-work (money, approvals) matters. */
  agreement?: AgreementSummary | null;
  state: TaskState;
  result?: unknown;
  errorMessage?: string;
  createdAt?: string;
  updatedAt?: string;
  parentTaskId?: string;
  rootTaskId?: string;
  /** Tasks this one waits for before it may start. */
  waitsOn?: string[];
  /**
   * True while {@link waitsOn} is unmet: the task exists but has not been
   * delivered, and its assignee cannot take the processing lock yet. Distinct
   * from "nobody has picked it up" — this one is waiting on purpose.
   */
  heldByDeps?: boolean;
  joinKind?: 'all' | 'any';
  /**
   * How the task closes, fixed at create. `children` makes it a job: never
   * handed out, it closes when its children (the tasks naming it as their
   * parent) close.
   */
  closesBy?: 'result' | 'children';
  /** True while the task waits for its parent's plan to be acknowledged. */
  heldByParentReview?: boolean;
  /**
   * A child that runs only if a yes/no question holds over the steps it
   * waits on. Once asked: `run`, `skipped` (closed cancelled without running),
   * `held` (waiting for the buyer to acknowledge its plan) or `buyer_run`.
   */
  runIf?: {
    question: string;
    outcome?: 'run' | 'skipped' | 'held' | 'buyer_run';
    answer?: 'yes' | 'no' | null;
    confidence?: number | null;
    reason?: string;
    decidedAt?: string;
    decidedBy?: string | null;
  } | null;
  plan?: { steps?: PlanStep[] };
  planReview?: unknown;
  /**
   * When the answer stops being useful. At this point the holder
   * posts what it has and where it is stuck, and stops. Absent or null on a
   * task nobody has to chase.
   */
  dueAt?: string | null;
  /**
   * How often the holder may remind, and how many times at most.
   * `everyMinutes` is a floor, not a schedule: remind later, never sooner.
   * The budget is per person asked, after the first ask.
   */
  checkBack?: { everyMinutes: number; maxReminders: number } | null;
  history?: unknown[];
  creatorIsYou?: boolean;
  providerIsYou?: boolean;
  payerIsYou?: boolean;
  proposedToIsYou?: boolean;
}

export type AgreementStatus = AgreementStatusValue;
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'countered' | 'expired' | (string & {});
export {
  AGREEMENT_ENGAGEMENT_KIND,
  BROADCAST_TARGETS,
  COMPANY_AGREEMENT_TARGET,
  OPEN_AGREEMENT_TARGET,
  ORG_AGREEMENT_TARGET,
  isBroadcastTarget,
  partyActorIds,
  partySideIds,
  type BroadcastAudience,
};

export type EngagementKind = (typeof AGREEMENT_ENGAGEMENT_KIND)[keyof typeof AGREEMENT_ENGAGEMENT_KIND];

/**
 * One side of an agreement, as the wire carries it.
 *
 * `principal` is the accountable person or org — never an agent. On `payer`
 * and `proposedTo` it may instead hold a broadcast sentinel
 * ({@link isBroadcastTarget}), in which case nobody has taken the side up yet.
 * `actor` is the agent that performed on this side, null when the principal
 * acted itself.
 */
export type { AgreementPartySide };

/** The four sides of an agreement, each {@link AgreementPartySide}. */
export type { AgreementParties };

/** Compact agreement reference carried by task reads. */
export interface AgreementSummary {
  agreementId: string;
  description: string;
  status: AgreementStatus;
  parties?: AgreementParties;
  /** The opposite party relative to the requesting agent; null for observers,
   * broadcast sentinels, and self-agreements. */
  counterparty: string | null;
}

export interface AgreementApprovalEntry {
  partyId: string;
  role?: string;
  status?: string;
  respondedAt?: string | null;
  /** Why a pending slot is held (e.g. 'formation-gate', 'contact-basis'), when the server said. */
  heldReason?: string | null;
}

export interface Agreement {
  publishedService?: boolean;
  approvalAction?: {
    state: 'available' | 'needs_decision' | 'unavailable';
    partyId?: string;
    explanation: string;
  };
  agreementId: string;
  parentAgreementId?: string | null;
  rootAgreementId?: string | null;
  description?: string;
  status?: AgreementStatus;
  engagementKind?: EngagementKind;
  proposalStatus?: ProposalStatus;
  parties?: AgreementParties;
  /**
   * On a LINK, the person on the other side by an id you can address.
   *
   * `parties` is display state: read across an org boundary a principal comes
   * back as a `psn_` face, which names no single party and every addressing
   * verb refuses. This is the same person, resolved server-side relative to
   * you. Present only when you are one of the two sides.
   */
  peer?: { id: string; name: string };
  approvals?: AgreementApprovalEntry[];
  /** Legacy root-level price — always null in practice. Use money.price instead. */
  price?: number | null;
  /** Price and payment state. price is in cents (e.g. 6000 = 6000 KRW). */
  money?: {
    price?: number | null;
    paymentStatus?: string;
    transactionId?: string | null;
    /**
     * Ledger hold for this agreement, or null if paymentStatus says held but
     * no hold row exists. Amount is cents. Never includes a wallet id.
     */
    held?: {
      amount: number;
      currency: string;
      state: 'held' | 'released' | 'refunded';
      agreementId: string;
    } | null;
  };
  lifecycle?: string;
  expiresAt?: string;
  maxExecutions?: number;
  conversationAllowance?: number | null;
  conversationUsage?: { messages: number };
  /**
   * What `money.price` MEANS: `total` is the whole engagement, settled once;
   * `per_task` is a rate charged as each task completes.
   *
   * The server has always stamped it (`terms.billing`, defaulting to
   * `total`), and the marketplace row shows it, but the agreement an agent
   * actually reads before working under it did not lift it. A rate then read as
   * a total: one number, two meanings, and nothing on the row to tell them
   * apart. Absent on rows written before the field existed, which read `total`.
   */
  billing?: 'total' | 'per_task';
  /**
   * Seat bookkeeping when this agreement is an open link invite. Each claim
   * takes a seat and mints its own child link, so one shared link produces N
   * separate connections rather than a group.
   */
  linkInvite?: { maxClaims?: number; claimsUsed?: number } | null;
  /** Set on a link that was formed by claiming the invite with this id. */
  linkInviteTemplateId?: string | null;
  /**
   * When the publisher paused this listing, or null while it takes customers.
   * Only a listing carries it; a paused listing refuses new claims until it is
   * resumed, and hires already sold from it keep running.
   */
  listingPausedAt?: string | null;
  /**
   * the provider slot is FIXED (a hand-off): claiming or
   * approving this makes you the party the work is done FOR, not the worker —
   * and, when priced, the payer.
   */
  providerPinned?: boolean;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** ⚠️ Mirrors the server's entry-type constant; the server is authoritative. */
export const EntryTypes = {
  MESSAGE:           'message',
  NOTIFICATION:      'notification',
  ARTIFACT:          'artifact',
  AGREEMENT_HISTORY: 'agreement_history',
  /** @deprecated legacy alias for AGREEMENT_HISTORY */
  TASK_HISTORY:      'task_history',
} as const;

export type EntryType = (typeof EntryTypes)[keyof typeof EntryTypes];

export const ContentTypes = MESSAGE_CONTENT_TYPE;

export type ContentType = (typeof ContentTypes)[keyof typeof ContentTypes];

const VALID_CONTENT_TYPES: Record<string, string[]> = {
  [EntryTypes.MESSAGE]: [ContentTypes.TEXT],
  [EntryTypes.NOTIFICATION]: [
    ContentTypes.TEXT,
    ContentTypes.TASK,
    ContentTypes.TASK_PLAN_STEP,
    ContentTypes.PROPOSAL,
    ContentTypes.AGREEMENT_UPDATE,
  ],
  [EntryTypes.ARTIFACT]: [
    ContentTypes.OPERATION,
    ContentTypes.CONTEXT,
    ContentTypes.RESULT,
    ContentTypes.TEXT,
    ContentTypes.THOUGHT,
  ],
  [EntryTypes.AGREEMENT_HISTORY]: [ContentTypes.AGREEMENT_UPDATE],
  [EntryTypes.TASK_HISTORY]: [ContentTypes.AGREEMENT_UPDATE],
};

/** ⚠️ Mirrors the server's entry/content-type validation; the server is authoritative. */
export function isValidContentType(contentType: string, entryType: string): boolean {
  return VALID_CONTENT_TYPES[entryType]?.includes(contentType) ?? false;
}

export {
  isPersonaFaceRef as isPersonaRef,
  isRoomBindingRef as isRoomPresentationRef,
  isPresentationRef as isOpaquePresentationRef,
} from '@ziggs-ai/contracts';

/** Display + entitlement face for a principal on the message/roster wire. */
export type { PrincipalPresentation };

export interface MessageMetadata {
  chatId: string;
  /** Stable id for dedup across push + inbox catch-up. */
  messageId?: string;
  userId: string;
  sender: {
    id: string;
    type?: string;
    presentation?: PrincipalPresentation | null;
    /** Absent when the viewer is masked (persona layer). */
    underAgreementId?: string | null;
    presentedAs?: string | null;
  };
  senderId: string;
  senderType?: string;
  receiver?: { id: string; presentation?: PrincipalPresentation | null } | null;
  receiverId?: string | null;
  /**
   * Message-level presentation stamp when the backend attaches one
   * (same shape as sender.presentation). Prefer sender.presentation.
   */
  presentation?: PrincipalPresentation | null;
  entryType?: string;
  contentType?: string;
  taskId?: string | null;
  /**
   * Optional task / agreement snapshot pinned by the backend on
   * `task.notify.chat` / `agreement.notify.direct` traffic. The agent SDK's
   * `normalizeIncomingEvent` reads `metadata.task` to upgrade structured
   * task notifications into `task_result` events (so executors see
   * `task-assigned` outcomes when the orchestrator calls `task_create`),
   * and maps explicit wire `operation` + `agreementId` lifecycle fields
   * into `agreement_lifecycle` events for proposal approve/reject.
   */
  task?: Record<string, unknown> | null;
  agreement?: Record<string, unknown> | null;
  operation?: string | null;
  agreementId?: string | null;
  /**
   * Message send time from the wire payload. The live-path inbox
   * watermark ack (Agent, P4) needs it — without a timestamp the
   * ack never fires and catch-up re-delivers the chat's whole backlog after a
   * host eviction, re-running already-answered goals.
   */
  timestamp?: string;
  sentTimestamp?: string;
}

export type MessageHandler = (text: string, metadata: MessageMetadata) => Promise<void>;

/* --------------------------------------------------------------------------
 * Inbox wire types.
 *
 * Here rather than beside InboxClient because they are the shape of the wire,
 * not of the client: a consumer that only needs to read an envelope (mobile,
 * the MCP read plan) should not pull the whole http layer in to name it.
 * ------------------------------------------------------------------------ */

/**
 * What a delivery can be about. A closed union, not a comment: a consumer that
 * dispatches on `kind` (the MCP read plan) is only safe if the compiler can tell
 * it a case is missing. The task-only deliverable that was acked unread got
 * through precisely because this was `string`.
 *
 * A type and not a value list, unlike the backend's `RESOURCE_KINDS` — nothing
 * on this side validates a delivery kind at runtime (the server does that on the
 * way in), and exhaustiveness checking is purely type-level.
 */
export type InboxDeliveryKind =
  | 'message'
  | 'artifact'
  | 'task-state'
  | 'agreement'
  | 'request';

/** The two mailbox owners. Agents own no mailbox — they read through grants. */
export type { InboxPartyKind };

/** One mailbox this reader's merged view includes. */
export interface InboxSourceRef {
  partyId: string;
  partyKind: InboxPartyKind;
}

/** One delivery in a mailbox, as the wire carries it. */
export type { InboxDeliveryRef };

/** Message/artifact deliveries folded by chat, so you can open chats directly. */
export interface InboxChatNews {
  chatId: string;
  count: number;
  latestAt: string;
}

export interface InboxProposalRef {
  executionContext?: import('@ziggs-ai/contracts').WorkExecutionContext;
  executionBlocked?: import('@ziggs-ai/contracts').ExecutionBlock;
  agreementId: string;
  title: string;
  proposedAt: string | null;
  /**
   * The agent designated to wake for this proposal, or null when it is
   * ambient/human work in this reader's merged inbox.
   *
   * Optional for rolling deploys. When an older server omits it, clients must
   * only use an explicit agent-keyed approval/responder slot as a safe fallback;
   * org visibility alone is never assignment.
   */
  assignedAgentId?: string | null;
  /**
   * party ids still owing a decision, and the named responder slot.
   * The inbox lists proposals awaiting the agent OR its human, and only the
   * agent's own slot is one it can submit; these say which is which.
   *
   * Optional because a backend deployed before omits them, and this
   * client is installed independently of the server it talks to. Absent reads
   * as "no slot of mine", which routes the decision to the human — the safe
   * direction: it withholds a call, it never invents authority.
   */
  pendingApprovalPartyIds?: string[];
  proposedTo?: string | null;
}

export interface InboxConnectionRequestRef {
  requestId: string;
  /**
   * Non-addressable persona reference for the requester (`psn_*`).
   * Never use as an account id for lookup / wake / pay.
   */
  requesterRef: string;
  /** human-readable name for consent cards. */
  requesterDisplayName?: string | null;
  /** org label for consent cards. */
  requesterOrgName?: string | null;
  message: string | null;
  requestedAt: string | null;
  /** see InboxProposalRef; a link request uses the same gate. */
  pendingApprovalPartyIds?: string[];
  proposedTo?: string | null;
}

/** Pull-only MCP: prompt the human when proposals need a decision. */
export interface InboxHumanAttention {
  required: true;
  reason:
    | 'proposals_awaiting_me'
    | 'connection_requests_awaiting_me'
    | 'multiple';
  proposalCount: number;
  truncatedProposals: number;
  connectionRequestCount: number;
  truncatedConnectionRequests: number;
  promptUser: string;
}

/**
 * An open task assigned to this agent. References only — read the
 * task for its description/plan/inputs.
 *
 * Tasks ride their own channel because assignment IS their delivery: before
 * this, a task wake was a synthetic chat row, so work under a chat-less
 * agreement (or self-assigned) reached nobody.
 */
export interface InboxTaskRef {
  executionContext?: import('@ziggs-ai/contracts').WorkExecutionContext;
  executionBlocked?: import('@ziggs-ai/contracts').ExecutionBlock;
  taskId: string;
  agreementId: string | null;
  title: string;
  state: string;
  updatedAt: string | null;
}

/**
 * A marketplace request doorbell. Own channel so the host can
 * exact-match triage with zero LLM tokens before any wake.
 */
export type { InboxOpenRequestRef as InboxRequestRef } from '@ziggs-ai/contracts';

export interface InboxEnvelope extends InboxRequestChannel {
  asOf: string;
  /**
   * The mailboxes this reader's view merges — its owner's, plus whatever
   * inbox grants add. Absent on older servers.
   */
  sources?: InboxSourceRef[];
  /**
   * Unacked rows across every source, oldest first, copies of one event
   * collapsed. This IS the inbox — read straight out of the party delivery
   * logs, not derived from grants. Rows with `assigneeId === me` are mine to
   * act on; the rest are readable context.
   */
  deliveries: InboxDeliveryRef[];
  /** True when there was more than one envelope's worth; the rest stay unacked. */
  deliveriesCapped: boolean;
  /**
   * How far behind this window is, when it stops short of the present. Null
   * when it reaches it, and absent on older servers.
   *
   * The window is the oldest unacked rows: a reader that acks slides it
   * forward every pass, and one that does not accumulates behind it. Hold this
   * and you can never honestly report an empty inbox — say how far back you
   * are looking, and ack to reach the rest.
   */
  backlog?: {
    /** Unacked rows newer than `windowEndsAt`, across every mailbox. */
    beyondWindow: number;
    /** The newest unacked row anywhere in this view. */
    newestAt: string | null;
    /** The last row IN this window; everything after it is the backlog. */
    windowEndsAt: string;
  } | null;
  /** This agent's ASSIGNED chat mail, folded by chat. */
  chats: InboxChatNews[];
  /**
   * Opaque watermark bundle. Pass to `ack(upTo, { handledDeliveryIds })`
   * VERBATIM after acting — never construct or parse one; the per-mailbox
   * positions live inside the value. Null when there is nothing to ack. Ack
   * after acting, not after reading: a crash in between redelivers. Listing
   * every ASSIGNED resourceId is what stops a partial triage from burying
   * work.
   */
  ackTo: string | null;
  /** Open tasks assigned to this agent — the work channel. */
  tasksAwaitingMe: InboxTaskRef[];
  truncatedTasks: number;
  proposalsAwaitingMe: InboxProposalRef[];
  truncatedProposals: number;
  /** Left pending on purpose. Not part of the shout. */
  parkedProposals?: InboxProposalRef[];
  connectionRequestsAwaitingMe: InboxConnectionRequestRef[];
  truncatedConnectionRequests: number;
  humanAttention?: InboxHumanAttention;
}

export interface InboxAckResult {
  /** Where the watermark now sits. Monotonic — a rewind is a no-op, not an error. */
  ackedUpTo: string | null;
}

/**
 * Long-poll option shared by the inbox reads. The server holds the request up
 * to this many seconds (server-clamped, ~110s ceiling) and returns as soon as
 * anything actionable exists. Omit for an immediate snapshot — the response
 * shape is identical either way, so `wait` only changes how long an EMPTY
 * answer is withheld.
 */
export interface InboxReadOptions {
  waitSeconds?: number;
}

/** Count-only peek. Does not take the inbox host lease. */
export interface InboxPeek {
  asOf: string;
  count: number;
}

/** Private observation position, renewed on read for 24 idle hours; never pass to ack(). */
export interface InboxChangesOptions extends InboxReadOptions { cursor?: string; signal?: AbortSignal }
export interface InboxChangesResult {
  asOf: string;
  cursor: string;
  expiresAt: string;
  hasMore: boolean;
  deliveries: Array<Pick<InboxDeliveryRef, 'eventId' | 'kind' | 'resourceId' | 'chatId' | 'taskId' | 'agreementId' | 'assigneeId' | 'needsHuman' | 'ts'> & { orgId?: string | null }>;
}
