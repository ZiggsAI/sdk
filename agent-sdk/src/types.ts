import type { WriteSource } from '@ziggs-ai/api-client';
/**
 * Foundation types for the agent SDK workflow runtime.
 *
 * One outcome vocabulary, one ctx shape, one transition signature.
 * Every state — parked or thinking — re-enters with exactly one Outcome.
 */

import type { AgreementParties } from '@ziggs-ai/api-client';
import type { ContextSnapshotResult } from '@ziggs-ai/api-client/http';

import type { AgentNeed } from './tools/needs.js';

// ── Refs (opaque payloads from the protocol layer) ───────────────────────────

export interface AgreementRef {
  agreementId: string;
  parties?: AgreementParties;
  proposal?: { status?: 'pending' | 'approved' | 'rejected' | 'cancelled' };
  money?: { price?: number; paymentStatus?: string };
}

export interface TaskRef {
  taskId: string;
  agreementId?: string;
  agreement?: AgreementRef;
  state?: string;
  description?: string;
  parentTaskId?: string;
  executorId?: string;
  assigneeId?: string | null;
  /** Work product set by task_set_result (safeJsonStringify'd string on the wire). */
  result?: unknown;
  proposal?: { status?: 'pending' | 'approved' | 'rejected' | 'cancelled' };
  proposedToIsYou?: boolean;
  providerIsYou?: boolean;
  creatorIsYou?: boolean;
  payerIsYou?: boolean;
}

export interface ProposalRef {
  agreementId: string;
  agreement?: AgreementRef;
}

// ── Outcomes (hybrid: closed core + extension) ───────────────────────────────

export type OutcomeKind =
  | 'enter'
  | 'wait'
  | 'state-timeout'
  | 'wake-at'
  | 'message-sent'
  | 'message-received'
  | 'task-assigned'
  | 'task-delegated'
  | 'task-closed'
  | 'subtask-finished'
  | 'proposal-made'
  | 'proposal-resolved'
  | 'tool-result'
  | 'error'
  | 'extension';

export type Outcome =
  | { kind: 'enter' }
  | { kind: 'wait' }
  | { kind: 'state-timeout'; state: string; waitedMs: number }
  /**
   * The agent asked to be woken at a time and this is it. Distinct
   * from `state-timeout`: that one is a parked state's liveness bound, this
   * one is the agent's own check-back, and a state machine may transition on
   * it from any state.
   */
  | { kind: 'wake-at'; reason: string | null; scheduledFor: number }
  | { kind: 'message-sent'; text?: string; receiverId?: string }
  | { kind: 'message-received'; text?: string; senderId?: string; senderType?: string }
  | { kind: 'task-assigned'; task: TaskRef }
  | { kind: 'task-delegated'; task: TaskRef }
  | {
      kind: 'task-closed';
      status: 'completed' | 'failed';
      /** Task being closed — required to clear only that entry. */
      taskId?: string;
      result?: unknown;
    }
  | { kind: 'subtask-finished'; status: 'completed' | 'failed'; task: TaskRef; result?: unknown }
  | { kind: 'proposal-made'; proposal: ProposalRef }
  | {
      kind: 'proposal-resolved';
      action: 'approve' | 'reject';
      proposal: ProposalRef;
      /**
       * True when THIS agent made the proposal being resolved. Computed in
       * AgentMachine._handleFrame by matching proposal.agreementId against
       * ctx.pendingProposalAgreementId BEFORE applyOutcomeToCtx clears it —
       * wire frames carry no trustworthy proposer field (agreement_lifecycle
       * drops `parties` at ingress, and parties.creator is a principal id,
       * not an agentId). Drives the injected agreement-kickoff default.
       */
      proposedByMe: boolean;
      /**
       * true when the wake was a chat-less store/listing claim
       * (`resource_changed` + `reason === 'proposal_approved'`). Distinguishes
       * the provider claim-kickoff (open chat + greet) from a direct-proposal
       * counterparty approve, which must never auto-kickoff.
       */
      fromClaimWake?: boolean;
    }
  | { kind: 'tool-result'; tool: string; result: unknown }
  | {
      kind: 'error';
      source: 'llm' | 'tool' | 'protocol' | 'validation' | 'unknown';
      cause: unknown;
      retryable: boolean;
    }
  | { kind: 'extension'; name: string; payload: unknown };

// ── Ctx (memory only — no event-derived flags) ───────────────────────────────

/**
 * A session is the Server-side abstraction the Agent operates against:
 * `{ sessionId, ctx, queue, parked }`. `Identity` is the Agent's view of
 * which session this tick belongs to. `sessionId` is opaque to the Agent —
 * it's a string the Server uses to route inbound events and outbound
 * effects. (Today, the Ziggs transport derives sessionId from `chatId` at
 * the wire boundary; non-chat surfaces will produce sessionIds of other
 * shapes.)
 */
export interface Identity {
  agentId: string;
  sessionId: string;
  laneKey: string;
}

export interface HistoryEntry {
  entryType?: string;
  text?: string;
  sender?: { id?: string; type?: string };
  receiver?: { id?: string };
  timestamp?: number;
  [key: string]: unknown;
}

export interface ToolResultEntry {
  tool: string;
  result?: unknown;
  error?: string;
}

export interface PendingSubtask {
  /** Executor the task was placed with; null only when the spawn result carried
   * no executor identity (open/broadcast agreement task not yet claimed). */
  agentId: string | null;
  spawnedAt: number;
}

export interface CollectedSubtaskResult {
  taskId: string;
  agentId: string | null;
  status: 'completed' | 'failed';
  /** task.result from the finishing event; null when the event carried none. */
  result: unknown;
}

/**
 * Per-assigned-task (or coordinator-lane) bookkeeping under one chat lane.
 * Keyed on Ctx.tasks by taskId — task-closed clears only its entry.
 */
export interface TaskBookkeeping {
  agreementId: string | null;
  /** Spawned-but-unfinished children of this engagement, keyed by child taskId. */
  pendingSubtasks: Record<string, PendingSubtask>;
  /** Finished children of this engagement, arrival order. */
  collectedResults: CollectedSubtaskResult[];
  /** Sub-agreement ids recorded on task-delegated under this engagement. */
  delegatedAgreementIds: string[];
}

/**
 * Per-lane runtime state. Outcome is "what just happened"; Ctx is "what I know."
 *
 * Task bookkeeping lives in `tasks` (keyed by taskId). `activeTaskId` /
 * `activeAgreementId` are the focus scalars for prompt + FSM convenience —
 * assigning task B no longer destroys task A's pending/collected state, and
 * closing A leaves B intact.
 */
export interface Ctx {
  identity: Identity;

  // Persistent protocol state
  /**
   * Open engagements in this lane, keyed by taskId (assigned work) or the
   * reserved coordinator bucket (see LANE_BOOK_KEY) when spawning without an
   * assigned parent task.
   */
  tasks: Record<string, TaskBookkeeping>;
  /** Focus task — most recently assigned; prompts/FSM read this. */
  activeTaskId: string | null;
  /** Focus agreement — sync'd with tasks[activeTaskId] when a task is focused. */
  activeAgreementId: string | null;
  pendingProposalAgreementId: string | null;

  // the lane-level `pendingSubtasks` / `collectedResults` /
  // `delegatedAgreementIds` mirrors are gone. moved the real
  // bookkeeping into `tasks` (keyed by taskId) and stopped syncing the
  // mirrors, but they stayed on this interface as required-and-deprecated —
  // which let a live FSM guard keep reading one and silently always see empty.
  // Read via `allPendingSubtasks` / `allCollectedResults` /
  // `allDelegatedAgreementIds`. A pre- persisted session is still
  // migrated by `migrateLegacyTaskFields`, which reads the raw stored object.

  // Per-turn working memory
  toolResults: ToolResultEntry[];

  // Last event/turn that caused this entry
  lastOutcome: Outcome;

  /** Claude Agent SDK session id for resume across ticks (claude-sdk cognition only). */
  claudeSessionId?: string;
  /** Work and audience bound to the saved transcript. Older unbound sessions are not resumed. */
  claudeWorkScope?: string;

  /**
   * Recent wake timestamps (epoch ms) for this lane (claude-sdk cognition
   * only). Backstop circuit breaker: if a lane wakes faster than any real
   * traffic could drive it, the brain skips the LLM instead of burning the
   * key on a wake storm.
   */
  recentDeliveries?: number[];

  // Server-provided context (history, agreements, agents, users) is fetched
  // on demand inside runTurn; not persisted on Ctx.
}

// ── Workflow shape ───────────────────────────────────────────────────────────

export interface PromptDef {
  role?: string;
  goal?: string;
  context?: string;
  constraints?: string;
}

export interface ActionPrompt {
  instruction: string;
  format?: string;
  when?: string;
  examples?: Array<{ scenario?: string; input?: string; output?: string; query?: string }>;
}

/**
 * `produces` is the outcome-kind contract for an action. Static form for
 * actions that always emit the same kind (most common); function form for
 * tool-bound actions where the result determines the kind (e.g. success vs
 * error). The runtime composes the kind with action metadata to build the
 * full Outcome.
 */
export type ProducesFn = (result: unknown, args: unknown) => OutcomeKind;
export type Produces = OutcomeKind | ProducesFn;

export interface Action {
  prompt: ActionPrompt;
  tool?: string | null;
  produces: Produces;
  /**
   * When true, the tool loop exits immediately after this action's tool result,
   * even if the result is non-terminal. Prevents the LLM from issuing additional
   * tool calls in the same turn (e.g. calling agreement_subcontract right after
   * agent_search before the FSM can route to evaluatingCandidates).
   */
  terminatesLoop?: boolean;
}

export interface Transition {
  to: string;
  when?: (outcome: Outcome, ctx: Ctx) => boolean;
}

export interface ParkedState {
  kind: 'parked';
  /**
   * Liveness timer. When the machine settles in this state and no event
   * arrives on the lane within timeoutMs, the host wakes the lane with a
   * { kind: 'state-timeout', state, waitedMs } outcome so a transition can
   * route to a recovery/nudge state. If no transition matches, the machine
   * parks loudly (runtimeLog.error) and the timer is NOT re-armed. Countdown
   * starts when the tick settles and resets on any event for the lane.
   * In-memory only: lost on process restart; re-armed by the next real event
   * that ticks the lane.
   */
  timeoutMs?: number;
  transitions: Transition[];
}

export interface ThinkingState {
  kind: 'thinking';
  prompt: PromptDef;
  actions: Record<string, Action>;
  transitions: Transition[];
  /**
   * Opt out of the validateWorkflow warning that flags thinking states
   * missing a `wait` action / activeWait fallthrough. Use sparingly — silent
   * states that loop on themselves are usually a bug.
   */
  allowNoWait?: boolean;
}

/**
 * fixed tool invoke with no LLM turn. Entered after transitions
 * (e.g. task-assigned → executing); runs `tool` once and emits `produces`.
 */
export interface MechanicalState {
  kind: 'mechanical';
  tool: string;
  args?: Record<string, unknown>;
  buildArgs?: (ctx: Ctx, outcome: Outcome) => Record<string, unknown>;
  produces: Produces;
  transitions: Transition[];
}

export type State = ParkedState | ThinkingState | MechanicalState;

export interface Workflow {
  id: string;
  description: string;
  initial: string;
  states: Record<string, State>;
}

// ── Effects (the Agent ↔ Server boundary) ────────────────────────────────────
//
// The Agent is pure: its only side channel is `EffectHandler`. Every impure
// operation — reading context, calling the LLM, executing a tool, sending a
// message — is expressed as an Effect. The Server implements the handler;
// the Agent emits effects via `await eff({ kind: ..., .. })` and consumes
// the typed result. This is the Node.js-style "sync dress over async" loop:
// `tick` reads top-to-bottom but every `await` is a yield to the Server.

export interface LlmToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface LlmToolSchema {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

export interface LlmResponse {
  content?: string;
  tool_calls?: LlmToolCall[];
  usage?: {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
  };
}

/**
 * One participant on the snapshot roster. `kind` is the declared holder kind the
 * server projection stamped, so a consumer reads what a participant IS instead
 * of inferring it from which array the row arrived in. Optional because a
 * backend that predates it simply omits the field.
 */
export interface SnapshotParticipant {
  role?: string;
  kind?: string;
  isYou?: boolean;
  [key: string]: unknown;
}

export interface ContextSnapshot {
  history: HistoryEntry[];
  agreements: unknown[];
  artifacts?: ContextSnapshotResult['artifacts'];
  agents: SnapshotParticipant[];
  users: SnapshotParticipant[];
  timelineSummary?: string | null;
  latestSequence?: string | null;
  unavailable?: boolean;
  /**
   * The session's chat no longer resolves on the backend (messages read
   * 404'd) — deleted or never visible to this agent. Message-triggered wakes
   * check this and skip the LLM instead of reasoning over a fabricated empty
   * history. Only gates message wakes. A bare agreementId as sessionId also
   * trips it — that is a mis-keyed lane, not a legitimate task lane;
   * task wakes should key on the agreement's origin/notification chat.
   */
  chatMissing?: boolean;
  /** Index signature so PromptBuilder's `ServerContext` can accept it directly. */
  [key: string]: unknown;
}

export interface ReadContextOpts {
  workScopes?: Array<{ agreementId?: string; taskId?: string; messageId?: string; artifactId?: string }>;
  maxMessages?: number;
}

/**
 * Result of executing a single tool. Tool execution may emit multiple
 * "events" (terminal markers like `message_sent`, `waited`, etc.) that the
 * cognition loop inspects to decide whether to keep looping. Those carry
 * through here as `events`; `result` is the value returned to the LLM.
 */
export interface ToolCallResult {
  ok: boolean;
  /** Stable execution-controller refusal code, when the host blocked the call. */
  errorCode?: string;
  /** Host-verified work binding, supplied by the execution controller. */
  execution?: { agreementId: string; taskId: string };
  result?: unknown;
  error?: string;
  events?: unknown[];
  /**
   * Summed token usage of any nested LLM call the tool made (e.g. llmTool).
   * Threaded up so the turn's authoritative token count (machine.tokens ->
   * result.metrics) includes tool-internal spend rather than leaking it.
   */
  usage?: LlmResponse['usage'];
}

export interface RecordedEntry {
  kind: string;
  text?: string;
  [k: string]: unknown;
}

/**
 * Deterministic idempotency keys for one wake's writes (delivery law, item 2).
 * Created once per tick from (laneKey, triggering event) — see
 * `createDeliveryWriteKeys` — and threaded to every artifact / task-state write the
 * wake performs, so a crash-replay of the same wake reproduces the same keys
 * and the backend drops the duplicates. Never LLM-supplied, never random.
 */
export interface DeliveryWriteKeys {
  /** Stable id of this wake, or null when its trigger has no durable delivery identity (timer/synthetic frames) — null means writes go keyless, as before. */
  readonly wakeKey: string | null;
  /**
   * Key for an artifact write of this wake. Pass the artifact's content so the
   * key is derived from it (semantics): a wake writing several
   * artifacts gets several keys, and a redelivered wake that re-writes the same
   * content reuses its key instead of colliding on an ordinal slot and being
   * discarded. Omitting content falls back to a per-wake ordinal — call exactly
   * once per write in that case.
   */
  artifactKey(content?: unknown): string | undefined;
  /** Key for a task state transition. Derived from (taskId, state), so it is stable regardless of tool-call order within the wake. */
  taskStateKey(taskId: string, state: string): string | undefined;
  /**
   * Default messageId for a chat-message send of this wake — the backend dedups
   * on (chatId, messageId). Derived from the emission's content (text + chat +
   * receiver), not a per-wake ordinal: a wake that says two things
   * gets two keys, and a redelivered wake that re-says the same text reuses the
   * same key, while a re-think with different text does not collide and drop.
   */
  messageKey(fields: {
    text: string;
    sessionId?: string;
    receiverId?: string;
  }): string | undefined;
  /** Key for a task spawn. Derived from what the spawn writes (agreement, description, assignee, parent), so it is stable regardless of tool-call order within the wake. */
  taskSpawnKey(fields: { agreementId: string; description: string; assigneeId?: string; parentTaskId?: string }): string | undefined;
  /** Key for an agreement proposal (`agreement_propose`). Derived from what the proposal writes (proposedTo, provider, description, parent), so a crash-replay dedups the row instead of minting a duplicate proposal — and multiple proposals in one wake stay distinct. */
  agreementProposeKey(fields: { proposedTo: string; providerId?: string; description: string; parentAgreementId?: string }): string | undefined;
  /** Key for a sub-agreement (`agreement_subcontract`). Derived from what the subcontract writes (executor, description, parent), so a replay dedups the row. */
  agreementSubcontractKey(fields: { executorId: string; description: string; parentAgreementId: string }): string | undefined;
}

import type { MemoryStore } from './memory/MemoryStore.js';

export type EffectKind =
  | 'read-context'
  | 'llm-call'
  | 'stream-text'
  | 'tool-call'
  | 'send-message'
  | 'record-event';

export type Effect =
  | { kind: 'read-context'; sessionId: string; opts?: ReadContextOpts }
  | {
      kind: 'llm-call';
      messages: LlmMessage[];
      tools: LlmToolSchema[];
      /** Chat/session id for monitoring ingest. */
      sessionId?: string;
      /** Per-turn UUID grouping all LLM + tool calls in one turn. */
      runId?: string;
      /** FSM state name at the time of this call. */
      stateId?: string;
    }
  | {
      kind: 'stream-text';
      sessionId: string;
      receiverId: string;
      /** Pre-allocated messageId shared across all chunks and the final send-message. */
      messageId: string;
      messages: LlmMessage[];
    }
  | {
      kind: 'tool-call';
      sessionId: string;
      /** Exact work scope from this wake, independent of connection delegation. */
      serviceAgreementId?: string;
      name: string;
      args: unknown;
      memory?: MemoryStore;
      senderId?: string;
      senderType?: string;
      /**
       * Agreement this tool call is acting under. For a delegated
       * per-user MCP call, `senderId` is the delegating agent, not the end-user
       * who owns the connection; this lets the gateway resolve the delegation
       * root's user. Sourced from the waking task event's `result.agreementId`.
       */
      onBehalfOfAgreementId?: string;
      /** Per-turn UUID. */
      runId?: string;
      /** FSM state name. */
      stateId?: string;
      /** Replay-stable write keys for this wake — write-capable tools derive their idempotency key from here, never from the LLM. */
      writeKeys?: DeliveryWriteKeys;
      /** The checkout the host opened for this wake; the checkout_* tools read it off their context. */
      checkout?: import('./checkout/tools.js').CheckoutSession;
    }
  /**
   * `receiverId` is optional: in a room with one other participant the backend
   * resolves the recipient from the room itself, which is the only answer
   * available when the wake's sender belongs to a DIFFERENT room.
   * Name a receiver whenever the room holds more than two parties.
   */
  | { kind: 'send-message'; sessionId: string; receiverId?: string; text: string; messageId?: string; conversationAgreementId?: string; underAgreementId?: string; taskId?: string; sources?: WriteSource[] }
  | { kind: 'record-event'; sessionId: string; entry: RecordedEntry; idempotencyKey?: string; serviceAgreementId?: string };

/**
 * Typed result map. With this shape, `await eff({ kind: 'read-context', .. })`
 * resolves to `ContextSnapshot`, not a union — the discriminant carries the
 * result type. Tests and effect handlers implement this map exhaustively.
 */
export interface EffectResultMap {
  'read-context': ContextSnapshot;
  'llm-call': LlmResponse;
  'stream-text': { text: string; usage?: LlmResponse['usage'] };
  'tool-call': ToolCallResult;
  /**
   * `{ ok: true }` said the call did not throw, and a brain reading it had no
   * way to tell a message that woke the agent it meant to from one the server
   * widened to the room's humans. The send's own report rides along when the
   * backend makes one: where it went. Routing is separate from acceptance.
   */
  'send-message': {
    ok: true;
    chatId?: string;
    messageId?: string;
    delivered?: string;
    to?: { id: string; type: string };
  };
  'record-event': { ok: true };
}

export type EffectResult<K extends EffectKind> = EffectResultMap[K];

/** The single side-channel between a Brain and its Agent. */
export type EffectHandler = <K extends EffectKind>(
  effect: Extract<Effect, { kind: K }>,
) => Promise<EffectResult<K>>;

// ── defineAgent input/output ─────────────────────────────────────────────────

export interface ServicesConfig {
  llm?: { model: string; temperature?: number };
  tools?: unknown[];
}

export interface DefineAgentInput {
  agentId: string;
  /**
   * Human-facing one-liner: what this agent does, for a buyer reading the store
   * row. NOT the system prompt — a claude-sdk agent puts its prompt in
   * `systemPrompt` (every claude-sdk agent used to pass its prompt
   * here, and `deriveAgentRecord` published it straight to the store).
   */
  description: string;
  /**
   * Claude-brain only: the agent's system prompt (its `## Your role` block).
   * Falls back to `description` when absent, which is what every FSM agent
   * relies on. Never surfaced in the store.
   */
  systemPrompt?: string;
  /** Trusted host callback, read at every wake; never exposed to the model. */
  loadSystemPrompt?: () => Promise<string>;
  specialization?: string;
  initial: string;
  states: Record<string, State>;
  tools?: unknown[];
  /**
   * Access this agent cannot work without. Declaring a need PRODUCES the tools
   * for it — do not also hand-list them — and makes work that arrives without
   * the grant fail at task start with the missing thing named, instead of
   * part-way through a real hire.
   */
  needs?: AgentNeed[];
  services?: ServicesConfig;
  operatorKey?: string;
  taskTools?: 'all' | 'none' | string[];
  [key: string]: unknown;
}

/**
 * Frozen output of defineAgent. Consumed directly by Agent / createAgent.
 * defineAgent injects ONE default: the agreement-kickoff state `kickingOff`
 * plus a last-position transition into it, added to states that don't already
 * handle a proposer-side proposal-resolved/approve outcome (runtime/kickoff.ts).
 * `wait` defaults remain the author's visible spread of `thinkingDefaults`.
 */
export interface AgentConfig {
  openaiKey: string | undefined;
  anthropicKey: string | undefined;
  operatorKey?: string;
  agentId: string;
  /** Store-facing one-liner. See DefineAgentInput.description. */
  description: string;
  /** Claude-brain system prompt; falls back to `description`. */
  systemPrompt?: string;
  loadSystemPrompt?: () => Promise<string>;
  specialization?: string;
  tools: unknown[];
  /** Normalized declared needs — see DefineAgentInput.needs. */
  needs?: AgentNeed[];
  model: string;
  workflow: Workflow;
  services?: ServicesConfig;
  taskTools?: 'all' | 'none' | string[];
  [key: string]: unknown;
}
