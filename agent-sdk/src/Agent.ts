import type { WriteSource } from '@ziggs-ai/api-client';
import { SERVER_EVENTS } from '@ziggs-ai/contracts';
import { withAgreementContext } from './runtime/agreementContext.js';
import { agreementLaneId, agreementIdFromLane, isContextAccessRequest } from '@ziggs-ai/api-client';
import { createDeclaredPollRunner } from './platform/polls/declaredPollRunner.js';
import type { PollBinding, PollKind } from './platform/polls/PollKind.js';
import type { PollRunner } from './platform/polls/PollRunner.js';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { contextScopesFromWake, WakeEffects, workScopeFromWake } from './runtime/wakeEffects.js';
import { ExecutionController, asWorkTool, executionControllers } from './runtime/executionController.js';
export { workScopeFromWake } from './runtime/wakeEffects.js';
import type { AgentConfig, Ctx, EffectHandler, Identity, Workflow } from './types.js';
import { ZiggsBrain, type TickOutput } from './brain/ZiggsBrain.js';
import { ClaudeBrain, type CognitionKind } from './brain/ClaudeBrain.js';
import { backendWakeGate } from './brain/wakeGate.js';
import {
  applyBrainToAgentOptions,
  isClaudeCognition,
  type BrainSelection,
} from './brain/index.js';
import { CLAUDE_SDK_TOOLS } from './brain/claudeSdkTools.js';
import { resolveClaudeModel } from './brain/claudeCognition.js';
import { resolveFleetModel } from './shared/fleetModel.js';
export { DEFAULT_MODEL, resolveFleetModel } from './shared/fleetModel.js';
import { CHAT_TOOLS } from './platform/tools/tier2/chatTools.js';
import { contextReadTool, openTool, accessExplainTool } from './platform/tools/tier2/contextTools.js';

export type { CognitionKind };
import { EventQueue, type WaitForIdleResult } from './platform/EventQueue.js';
import { StateTimers } from './platform/StateTimers.js';
import { laneKeyFor } from './platform/laneKey.js';
import { WAKE_TOOLS } from './platform/tools/tier1/wakeTools.js';
import { createZiggsEffectHandler } from './platform/ZiggsEffectHandler.js';
import { normalizeIncomingEvent, type NormalizedEvent } from './ingress/normalizeIncoming.js';
import { PromptBuilder } from './runtime/PromptBuilder.js';
import { ensureTaskBook, removeTaskBook } from './runtime/taskBookkeeping.js';
import {
  hireIdsFromEvent,
  memorySectionForWake,
  partitionMemoryStore,
  uniqueHireIds,
  type MemoryStore,
} from './memory/MemoryStore.js';
import { memoryStoreFor } from './memory/ArtifactMemoryStore.js';

/**
 * Operator-provided FSM session persistence.
 *
 * Agent calls load() before each tick when a lane has no in-memory state
 * (e.g. after a container restart) and save() after every successful tick.
 * A null return from load() means "no prior state — start fresh."
 */
export interface SessionStore {
  load(laneKey: string): Promise<{ ctx?: Ctx; state?: string } | null | undefined>;
  save(laneKey: string, session: { ctx?: Ctx; state?: string }): Promise<void>;
}
import { ToolManager } from './tools/ToolManager.js';
import { toolName, type ToolDefinition } from './tools/defineTool.js';
import { PROTOCOL_TOOLS } from './platform/tools/tier1/protocolTools.js';
import { marketplaceViewTool } from './platform/tools/tier2/marketplaceTools.js';
import { OpenAIAdapter } from './adapters/OpenAIAdapter.js';
import { AnthropicAdapter } from './adapters/AnthropicAdapter.js';
import {
  ArtifactsClient,
  ConnectionsClient,
  ContextReadClient,
  TelemetryClient,
  sendChatMessage,
  presentSendResult,
  getAgreement, getTask, annotationForSdkTool,
  type TaskState,
  type TaskControl,
} from '@ziggs-ai/api-client';
import {
  isCheckoutNeed,
  normalizeNeeds,
  unmetNeeds,
  unmetNeedsMessage,
  type AgentNeed,
} from './tools/needs.js';
import { openCheckout, closeCheckout, type OpenCheckout } from './checkout/open.js';
import type { CheckoutProvider } from './checkout/types.js';
import { resolveBackendUrl } from './shared/backendUrl.js';
import { laneUnderAgreement } from '@ziggs-ai/api-client';
import { TaskService } from './platform/tasks/TaskService.js';
import { AgreementService } from './platform/agreements/AgreementService.js';
import { INBOX_STOP_TIMEOUT_MS, runInboxLoop, type InboxLoopHandle } from './platform/inboxLoop.js';
import { requestExactMatch } from './platform/requestMatch.js';
import { SeenMessages } from './platform/SeenMessages.js';
import { runtimeLog } from './shared/runtimeLog.js';
import {
  isTelemetryIngestEnabled,
  sendTelemetry,
} from './platform/telemetryIngest.js';
import {
  buildWakeOutcomePayload,
  classifyWakeOutcome,
  wakeWasAsked,
  type WakeOutcome,
} from './runtime/wakeOutcome.js';
import {
  agreementIdFromWake,
  formedByFromWake,
  isHireActivationNotice,
  shouldSkipAgentFormedHireActivation,
  type AgreementFormedBy,
} from './brain/hireActivationNotice.js';

// ConnectionPool lives in a separate module; resolved via a computed-path
// dynamic import to avoid a circular import with Agent.
async function loadConnectionPool(): Promise<new () => unknown> {
  const modPath = './platform/ConnectionPool.js';
  const mod = await import(/* @vite-ignore */ modPath) as { ConnectionPool: new () => unknown };
  return mod.ConnectionPool;
}

/**
 * Given a normalized event, return the sessionId for this agent. Return
 * `null` to skip processing. Lets each Agent define what "session" means —
 * chat-scoped agents bucket by chatId (the default), task-scoped agents
 * could bucket by taskId, cron agents by schedule id, etc.
 */
export type SessionResolver = (normalized: NormalizedEvent, ownAgentId: string) => string | null;

const DEFAULT_SESSION_RESOLVER: SessionResolver = (normalized) => normalized.chatId;

/**
 * one lane key per unit of work, derived the same way as inbox wakes.
 *
 * Inbox deliveries key on `chatId` (DEFAULT_SESSION_RESOLVER). Bootstrap used to
 * prefer bare `agreementId`, which opened a second lane for the same task and
 * made the snapshot read treat the agreement id as a chat (`chatMissing: true`,
 * empty context). Prefer the origin chat when present; otherwise the agreement's
 * notification chat (`agrn-<agreementId>`), which is always linked after.
 */
export function laneSessionIdForTask(task: {
  originChatId?: string | null;
  agreementId?: string | null;
}): string {
  if (typeof task.originChatId === 'string' && task.originChatId) {
    return task.originChatId;
  }
  if (typeof task.agreementId === 'string' && task.agreementId) {
    return agreementLaneId(task.agreementId);
  }
  return 'default';
}

interface LlmAdapter {
  chatMessages(messages: unknown[], tools?: unknown[], options?: Record<string, unknown>): Promise<unknown>;
}

interface AgentServices {
  tools?: ToolDefinition[];
  llm?: { model?: string } | LlmAdapter;
  [key: string]: unknown;
}


/**
 * A wake that holds a checkout installs, builds and tests a repository, which
 * takes longer than a conversation turn. Its watchdog is at least this.
 */
const CHECKOUT_TICK_TIMEOUT_MS = Number(process.env.CLAUDE_SDK_CHECKOUT_TICK_TIMEOUT_MS ?? 40 * 60_000);

export interface AgentOptions {
  /** External wake sources, started by connectAsync and stopped by disconnect. */
  polls?: PollBinding[];
  /** Implementations for this agent’s declared poll kinds. */
  pollKinds?: PollKind[];
  openaiKey?: string;
  anthropicKey?: string;
  model?: string;
  operatorKey?: string;
  agentId?: string;
  name?: string | null;
  /** Store-facing one-liner. See DefineAgentInput.description. */
  description?: string;
  /** Claude-brain system prompt; falls back to `description`. */
  systemPrompt?: string;
  /** Read trusted role instructions afresh for each wake. Failure stops the wake. */
  loadSystemPrompt?: () => Promise<string>;
  specialization?: string | null;
  /**
   * strings compared exactly against a request's `match` field.
   * Miss → ack with zero LLM. Match → normal wake. `specialization` is also
   * checked when set.
   */
  requestMatchTags?: string[];
  tools?: ToolDefinition[];
  /**
   * Access this agent cannot work without. Enforced at task start:
   * a task arriving with no live grant behind a declared need is failed with the
   * missing access named, before the tick spends anything.
   */
  needs?: AgentNeed[];
  /**
   * Who provides the checkout a `{ checkout: 'git' }` need asks for: the host.
   * A fleet starts a container per wake, a lab a confined local process. Left
   * unset, a task that needs a checkout is refused naming this host.
   */
  checkout?: CheckoutProvider;
  taskTools?: 'all' | 'none' | string[];
  /**
   * Brain selection — preferred over legacy `cognition`.
   * `ziggsBrain()` for the workflow/FSM loop; `claudeBrain()` for Claude Agent SDK.
   */
  brain?: BrainSelection;
  /**
   * @deprecated Use `brain: ziggsBrain()` or `brain: claudeBrain()` instead.
   * Internal mapping: `fsm` → Ziggs brain, `claude-sdk` → Claude brain.
   */
  cognition?: CognitionKind;
  /** Code-enforced work agreement/task binding. Defaults on for the Claude brain; other brains can opt in. */
  executionControl?: boolean;
  /**
   * Spend a model turn on an activation notice for a hire an agent formed.
   * Default off — the host records a no-op and waits for the assigned task.
   * A hire a person formed (store claim) still wakes regardless of this flag.
   */
  actsOnHireActivation?: boolean;
  /**
   * Before a Claude turn on chat messages, ask the backend whether
   * they ask this agent for anything; a confident "no" skips the turn. On by
   * default; `false` turns it off. Any failure wakes as usual.
   */
  wakeGate?: boolean;
  /** Max agentic turns per Claude SDK wake. Default 30. */
  claudeMaxTurns?: number;
  /**
   * claude-sdk agents resume their transcript across wakes by default,
   * so per-wake input grows monotonically on a long lane. When true, each wake
   * starts a fresh Claude session — the protocol is backend-authoritative (the
   * brain re-reads via context_snapshot / the wake event), so the
   * transcript is convenience memory, not source of truth. Ideal for
   * step-driven orchestrators whose every wake already carries what it needs.
   */
  claudeStatelessPerWake?: boolean;
  services?: AgentServices;
  workflow?: Workflow;
  // Convenience: states + initial without an explicit workflow.
  states?: Workflow['states'];
  initial?: string;
  tickTimeoutMs?: number;
  /** Per-agent session keying. Defaults to `(n) => n.chatId`. */
  sessionResolver?: SessionResolver;
  /**
   * Agent-private long-term memory. With an operator key and agent id, the
   * default is an agent-private artifact store, so a note survives a restart.
   * Pass a store to keep notes somewhere else. Without credentials, the
   * default is still an in-memory store.
   * Each wake is given a hire-scoped view of this store; agent key shapes
   * do not change.
   */
  memory?: MemoryStore;
  /**
   * FSM session persistence. Operator-provided. When set, Agent loads
   * prior state before each tick (cold-start recovery) and saves after every
   * successful tick. Omit to keep state in-process only (default behaviour).
   */
  sessionStore?: SessionStore;
  /** Observability tap: called after every effect with the effect and its response. */
  effectTap?: (effect: import('./types.js').Effect, response: unknown) => void;
  /** Observability tap: called on every FSM state transition, no-match, depth-guard, or error-escape. */
  transitionTap?: (event: import('./runtime/AgentMachine.js').TransitionEvent) => void;
  /**
   * Usage/cost tap: called once per settled tick with the tick's authoritative
   * token usage (result.metrics). This is the SINGLE source of truth for
   * usage/cost across every cognition — the FSM (llm-call + streamed reply +
   * tool-internal LLM) and the Claude brain (incl. cache tokens) both funnel
   * their spend here. effectTap / tool generations are structural
   * tracing only and must NOT also carry billable usage, or cost double-counts.
   */
  metricsTap?: (info: {
    agentId: string;
    sessionId: string;
    model: string;
    cognition: string;
    metrics: import('./brain/ZiggsBrain.js').TickOutput['metrics'];
    /** Present when the wake carried an agreement/task. */
    agreementId?: string;
    taskId?: string;
  }) => void;
  /**
   * Called with everything a wake consists of, immediately before the brain
   * runs. Pair it with {@link Agent.replayWake} to re-run that exact wake
   * later against edited agent source — the difference between iterating on a
   * prompt in seconds and standing a whole world back up to see one turn.
   *
   * Emitted for every wake, including ones the brain then declines to spend an
   * LLM call on, because "why did nothing happen?" is the question a recording
   * most often has to answer.
   */
  wakeTap?: (record: WakeRecord) => void;
  /** Production monitoring ingest. Default on; set false to disable. */
  telemetryIngest?: boolean;
  /**
   * Run the outbound inbox loop on connectAsync. Default true.
   * Disable for offline tests or callers that deliver wakes themselves.
   */
  inboxCatchUp?: boolean;
}

/**
 * One wake, as the brain received it.
 *
 * These four fields ARE the tick's input (`agent.tick({ event, ctx, state,
 * identity })`) — everything else a tick touches is rebuilt from the agent's own
 * config. So a record is replayable on its own, and a replay that behaves
 * differently differs because the agent changed, not because the input drifted.
 *
 * Plain JSON on purpose: a record is meant to survive being written to a file
 * and read back by another process.
 */
export interface WakeRecord {
  agentId: string;
  sessionId: string;
  laneKey: string;
  /** The event frame that woke the agent. */
  event: unknown;
  /** FSM context carried into the tick — undefined on a cold lane. */
  ctx?: unknown;
  /** FSM state the lane was parked in — undefined on a cold lane. */
  state?: string;
}

/**
 * A platform tool keeps the platform classification wherever it was handed
 * in (an artifact tool passed through `tools` is still an artifact tool).
 * Anything else is a custom tool, and under execution control a custom tool
 * does work: it gets a `taskId` the model fills (see asWorkTool).
 */
const HAND_DEFINED_PLATFORM_TOOLS = new Set(
  [...PROTOCOL_TOOLS, ...CHAT_TOOLS, ...CLAUDE_SDK_TOOLS, ...WAKE_TOOLS, marketplaceViewTool, contextReadTool, openTool, accessExplainTool]
    .map((tool) => toolName(tool)),
);
function customToolAsWork(tool: ToolDefinition): ToolDefinition {
  const name = toolName(tool);
  const platform = Boolean(name && (HAND_DEFINED_PLATFORM_TOOLS.has(name) || annotationForSdkTool(name) !== undefined));
  return platform ? tool : asWorkTool(tool);
}

function createToolManager(options: AgentOptions): ToolManager {
  const toolManager = new ToolManager();
  const userTools = options.tools || options.services?.tools || [];
  let taskTools: ToolDefinition[];
  if (options.taskTools === 'none') taskTools = [];
  else if (Array.isArray(options.taskTools)) taskTools = PROTOCOL_TOOLS.filter((t: ToolDefinition) => (options.taskTools as string[]).includes(t.schema.function.name as string));
  else taskTools = PROTOCOL_TOOLS; // 'all' or undefined
  const claudeSdkTools = isClaudeCognition(options.cognition) ? CLAUDE_SDK_TOOLS : [];
  const ownTools = Array.isArray(userTools) ? userTools : [];
  // browse rides wherever claim rides. Posted-first engagements
  // START at marketplace_view (find the listing), so an agent that can
  // agreement_claim but cannot browse holds a default pathway it cannot begin.
  // Both directions: shedding claim (taskTools array without it) sheds browse.
  const canClaim = taskTools.some(
    (t) => t.schema.function.name === 'agreement_claim',
  );
  const browseTools = canClaim ? [marketplaceViewTool] : [];
  // chat_open is always-on so claim/provider kickoff (FSM) and the
  // Claude always-on set can open the buyer chat after a store claim. CHAT_TOOLS
  // is also folded into CLAUDE_SDK_TOOLS; Map registration makes duplicates a no-op.
  // wake_at stays registered for the FSM and for the hosted model, where it is
  // deferred behind tool search; an agent that can be handed a task
  // with a check-back rule but cannot arm a wake would have to busy-wait, and
  // there is nothing to busy-wait with.
  // open / context_read are the hosted twins of the MCP everyday set.
  // access_explain must also be available for protocol and artifact recovery calls. Skip
  // them when the agent already brought the same tools, so the shadow warning
  // does not fire on a duplicate registration.
  const ownNames = new Set(ownTools.map((t) => toolName(t)));
  const everydayContext = isClaudeCognition(options.cognition)
    ? [contextReadTool, openTool, accessExplainTool].filter((t) => !ownNames.has(toolName(t)))
    : [];
  const platformTools = [...taskTools, ...CHAT_TOOLS, ...browseTools, ...claudeSdkTools, ...everydayContext, ...WAKE_TOOLS];
  warnOnShadowedPlatformTools(platformTools, ownTools, options.agentId);
  const controlOn = options.executionControl ?? isClaudeCognition(options.cognition);
  toolManager.registerAll([...platformTools, ...(controlOn ? ownTools.map(customToolAsWork) : ownTools)]);
  return toolManager;
}

/**
 * ToolManager is a Map keyed by tool name, so the last registration silently
 * wins. An agent's own tools register last — which means an `extraTools` entry
 * (or an MCP server's tool, once its schema is mapped in) that happens to share
 * a name with a platform tool replaces it, and the agent quietly loses e.g.
 * `task_set_result` while looking merely confused. Say so at boot.
 *
 * A warning rather than a throw: this path already runs for every existing
 * agent, and turning a latent collision into a boot failure is a change those
 * agents did not ask for.
 */
export function warnOnShadowedPlatformTools(
  platformTools: ToolDefinition[],
  ownTools: ToolDefinition[],
  agentId: string | undefined,
): void {
  if (ownTools.length === 0) return;
  const platform = new Set(platformTools.map((t) => t.schema.function.name as string));
  const shadowed = ownTools
    .map((t) => t.schema.function.name as string)
    .filter((name) => platform.has(name));
  if (shadowed.length === 0) return;
  console.warn(
    `[Agent] ${agentId}: tool name(s) ${shadowed.join(', ')} shadow the platform tools of the same name — ` +
      'the agent will call yours, not Ziggs\'s. Rename them unless that is deliberate.',
  );
}

function isLlmAdapter(v: unknown): v is LlmAdapter {
  return typeof v === 'object' && v !== null && typeof (v as LlmAdapter).chatMessages === 'function';
}

function createBackendServices(options: AgentOptions) {
  const toolManager = createToolManager(options);
  const model = (options.services?.llm as { model?: string } | undefined)?.model || options.model;
  // The Claude brain drives query() directly and never emits llm-call/stream-text
  // effects, so it needs no adapter. Building one here would be dead — and worse,
  // the provider client throws at construction on a missing key, so a claude-sdk
  // agent left on the default (OpenAI) model with no openaiKey would fail to
  // start over an adapter it never uses. Skip it.
  const llm = options.brain?.kind === 'handler' || isClaudeCognition(options.cognition)
    ? undefined
    : isLlmAdapter(options.services?.llm)
      ? options.services!.llm as LlmAdapter
      : model?.startsWith('claude')
        ? new AnthropicAdapter({ key: options.anthropicKey, model })
        : new OpenAIAdapter({ key: options.openaiKey, model });
  const operatorKey = options.operatorKey!;
  const agentId = options.agentId!;
  const artifactsClient = new ArtifactsClient(operatorKey, agentId);
  const contextReadClient = new ContextReadClient(operatorKey, agentId);
  // the role text is the prompt when the author split the two; the
  // store-facing `description` is only the fallback for agents that never did.
  const promptBuilder = new PromptBuilder({
    description: options.systemPrompt || options.description,
    specialization: options.specialization,
  });
  const taskService = new TaskService(operatorKey, agentId);
  const agreementService = new AgreementService(operatorKey, agentId);
  const telemetryClient = new TelemetryClient(operatorKey, agentId);
  return {
    toolManager,
    llm,
    artifactsClient,
    contextReadClient,
    promptBuilder,
    taskService,
    agreementService,
    telemetryClient,
  };
}

interface LaneSession {
  sessionId: string;
  ownAgentId: string;
  ctx?: Ctx;
  state?: string;
  /**
   * The one hire this chat-room lane is acting under, once the wake
   * named it. Later messages in the same process often omit agreementId;
   * this keeps their notes in that hire's section. Cleared when a second
   * customer appears on the same lane.
   */
  actingHireId?: string | null;
}

/**
 * One agent identity and its body: inbox, tools, contracts, memory and lanes.
 * The brain decides on each wake; platform services perform its effects.
 * connectAsync starts outbound inbox reads and declared external polls.
 * An Agent never opens a listening socket.
 */
export class Agent {
  options: Required<Pick<AgentOptions, 'agentId' | 'operatorKey' | 'openaiKey'>> & AgentOptions;
  toolManager!: ToolManager;
  // Retained for external inspection. Undefined for the Claude brain, which
  // drives query() directly and needs no LLM adapter.
  llm?: OpenAIAdapter | LlmAdapter;
  brain!: ZiggsBrain | ClaudeBrain | { workflow: ZiggsBrain['workflow']; tick: import('./brain/index.js').HandlerBrainConfig['tick'] };
  private eff!: EffectHandler;
  private eventQueue!: EventQueue;
  // In-process ticks only; durable intent remains on the existing task row.
  private activeTaskRuns = new Map<string, Set<{ abort: AbortController; control?: TaskControl | null }>>();
  private sessions = new Map<string, LaneSession>();
  private sessionResolver: SessionResolver;
  private tickTimeoutMs: number;
  private memory: MemoryStore;
  private sessionStore: SessionStore | null;
  private taskService!: TaskService;
  private agreementService!: AgreementService;
  private telemetryClient?: TelemetryClient;
  private seenMessages = new SeenMessages();
  private stateTimers!: StateTimers;
  /** The per-agent inbox long-poll loop — this agent's sole wake source. */
  private inboxLoop: InboxLoopHandle | null = null;
  private inboxLoopEnabled: boolean;
  private started = false;
  private pollRunner: PollRunner | null;
  /** Short-lived grant-provider cache for the declared-needs gate. */
  /**
   * Lanes where an unmet-need refusal has already been allowed its one turn to
   * ask for the access (see `_refuseIfNeedsUnmet`). Per lane, not per agent: two
   * hirers each deserve the ask, and neither deserves it twice.
   */
  private askedForAccessLanes = new Set<string>();

  /** Tasks left active by the asking turn, failed right after it (per lane). */
  private unmetTasksPendingAsk = new Map<string, string[]>();
  private readonly wakeEffects = new AsyncLocalStorage<WakeEffects>();
  private readonly outboundMessages = new SeenMessages();
  private readonly confirmedPlanVersions = new SeenMessages();

  private grantProviderCache: { at: number; providers: Array<string | null | undefined> } | null =
    null;
  /** The checkout box each lane holds while its wake runs. */
  private checkoutByLane = new Map<string, OpenCheckout>();

  constructor(options: AgentOptions = {}) {
    const resolved = applyBrainToAgentOptions(options);
    this.options = {
      openaiKey: resolved.openaiKey || process.env.OPENAI_API_KEY,
      anthropicKey: resolved.anthropicKey || process.env.ANTHROPIC_API_KEY,
      model: resolveFleetModel(
        resolved.model ||
          (!isLlmAdapter(resolved.services?.llm) ? resolved.services?.llm?.model : undefined),
      ),
      operatorKey: resolved.operatorKey || process.env.ZIGGS_OPERATOR_KEY || undefined,
      agentId: resolved.agentId || '',
      name: resolved.name || null,
      description: resolved.description || 'A helpful assistant',
      systemPrompt: resolved.systemPrompt,
      loadSystemPrompt: resolved.loadSystemPrompt,
      specialization: resolved.specialization ?? null,
      requestMatchTags: resolved.requestMatchTags,
      tools: resolved.tools || [],
      // Copied deliberately: this object is an allow-list, so a field left out
      // here is silently dropped between the manifest and the runtime. That is
      // exactly how `respondsToProposals` reached the store as null for 133
      // agents — the declaration existed and nothing carried it. Same for
      // `requestMatchTags` (always undefined at triage) and `telemetryIngest`.
      needs: resolved.needs,
      checkout: resolved.checkout,
      taskTools: resolved.taskTools,
      states: resolved.states,
      initial: resolved.initial,
      services: resolved.services,
      workflow: resolved.workflow,
      tickTimeoutMs: resolved.tickTimeoutMs,
      sessionResolver: resolved.sessionResolver,
      effectTap: resolved.effectTap,
      transitionTap: resolved.transitionTap,
      metricsTap: resolved.metricsTap,
      wakeTap: resolved.wakeTap,
      inboxCatchUp: resolved.inboxCatchUp,
      telemetryIngest: resolved.telemetryIngest,
      brain: resolved.brain,
      polls: resolved.polls,
      pollKinds: resolved.pollKinds,
      cognition: resolved.cognition ?? 'fsm',
      executionControl: resolved.executionControl,
      actsOnHireActivation: resolved.actsOnHireActivation === true,
      wakeGate: resolved.wakeGate,
      claudeMaxTurns: resolved.claudeMaxTurns,
      claudeStatelessPerWake: resolved.claudeStatelessPerWake,
    } as Required<Pick<AgentOptions, 'agentId' | 'operatorKey' | 'openaiKey'>> & AgentOptions;
    this.inboxLoopEnabled = options.inboxCatchUp !== false;
    this.sessionResolver = options.sessionResolver || DEFAULT_SESSION_RESOLVER;
    // A Claude-brain wake legitimately runs long (multi-turn query, prose
    // deliverables). At 120s the watchdog cuts real spec-writing wakes
    // mid-flight, which then redeliver and re-run. FSM turns stay on the tight
    // default.
    this.tickTimeoutMs =
      options.tickTimeoutMs ??
      (isClaudeCognition(resolved.cognition)
        ? Number(process.env.CLAUDE_SDK_TICK_TIMEOUT_MS ?? 300_000)
        : 120_000);
    this.memory = memoryStoreFor({
      memory: options.memory,
      operatorKey: options.operatorKey,
      agentId: options.agentId,
    });
    this.sessionStore = options.sessionStore ?? null;
    this._validate();
    this.pollRunner = createDeclaredPollRunner(this.options, {
      sendTo: (_agentId, text, metadata) => this.handleMessage(text, metadata ?? {}),
    });
    this._setup();
  }

  private _validate(): void {
    if (this.options.brain?.kind === 'handler') {
      // Deterministic handlers use no model adapter or credentials.
    } else if (isClaudeCognition(this.options.cognition)) {
      if (!this.options.anthropicKey) {
        throw new Error('anthropicKey is required for the Claude brain — pass claudeBrain({ anthropicKey }) or set ANTHROPIC_API_KEY');
      }
    } else if (!isLlmAdapter(this.options.services?.llm)) {
      if (this.options.model?.startsWith('claude')) {
        if (!this.options.anthropicKey) throw new Error('anthropicKey is required for claude-* models — pass { anthropicKey } or set ANTHROPIC_API_KEY');
      } else if (!this.options.openaiKey) {
        throw new Error('openaiKey is required');
      }
    }
    if (!this.options.operatorKey) throw new Error('operatorKey is required — pass { operatorKey } or set ZIGGS_OPERATOR_KEY');
    if (!this.options.agentId) throw new Error('agentId is required');
  }

  private _setup(): void {
    const services = createBackendServices(this.options);
    this.toolManager = services.toolManager;
    this.llm = services.llm;

    // Outbound send is HTTP (delivery law, phase 4): the agent no longer holds a
    // socket. `POST /chats/:id/messages` persists the whole message — the same
    // row the WS path persisted. Live-token streaming had no HTTP path, so
    // `chunkSender` is intentionally dropped: partials degrade, the full reply
    // is never lost (runTurn always follows a stream with a whole send-message).
    const creds = {
      operatorKey: this.options.operatorKey!,
      agentId: this.options.agentId!,
    };
    const messageSender = async (
      message: string,
      receiverId: string | undefined,
      sessionId: string,
      messageId?: string,
      conversationAgreementId?: string,
      underAgreementId?: string,
      taskId?: string,
      sources?: WriteSource[],
    ): Promise<unknown> => {
      const sentId = messageId ?? `sdk_${randomUUID()}`;
      const result = await sendChatMessage(
        {
          chatId: sessionId,
          // Omitted on purpose when the caller has no valid address for THIS
          // room: the backend infers the recipient from the room's own
          // participants.
          receiverId,
          text: message,
          // messageId is the backend's (chatId, messageId) dedup key. Callers
          // pass a wake-derived id for replay-stability; fall back to a fresh id
          // only when absent (matches the old WS path letting the server assign).
          messageId: sentId,
          conversationAgreementId,
          underAgreementId,
          taskId,
          ...(sources ? { sources } : {}),
        },
        creds,
      );
      if (!result.success)
        throw new Error(
          'sendChatMessage: the server did not accept this message — nothing was delivered and nobody was woken. Retry with the same messageId, which the backend dedups on.',
        );
      this.outboundMessages.mark(JSON.stringify([result.chatId, result.messageId]));
      // Presented once, here, so every hosted send — FSM reply, brain tool,
      // stream follow-up — reports the destination the same way the MCP
      // surface does.
      return { ...result, ...presentSendResult(result, { creds, surface: 'sdk' }) };
    };
    this.taskService = services.taskService;
    this.agreementService = services.agreementService;
    this.telemetryClient = services.telemetryClient;

    let workflow = this.options.workflow;
    if (!workflow && this.options.states) {
      workflow = {
        id: this.options.agentId,
        description: this.options.description!,
        initial: this.options.initial || 'idle',
        states: this.options.states,
      };
    }
    if (!workflow?.states) {
      // The Claude brain has no FSM — it drives query() per wake and parks. It
      // still plugs into the agent's lane/timer machinery via a trivial parked
      // workflow, synthesized here so callers don't hand-write a dummy one.
      if (this.options.brain?.kind === 'handler' || isClaudeCognition(this.options.cognition)) {
        workflow = {
          id: this.options.agentId,
          description: this.options.description!,
          initial: 'ready',
          states: { ready: { kind: 'parked', transitions: [] } },
        };
      } else {
        throw new Error('Agent: workflow (or states + initial) is required');
      }
    }

    this.eff = createZiggsEffectHandler({
      llm: services.llm as unknown as import('./platform/ZiggsEffectHandler.js').ZiggsEffectDeps['llm'],
      artifactsClient: services.artifactsClient,
      contextReadClient: services.contextReadClient,
      taskService: services.taskService,
      agreementService: services.agreementService,
      messageSender,
      toolManager: services.toolManager,
      operatorKey: this.options.operatorKey!,
      agentId: this.options.agentId!,
      telemetryClient: services.telemetryClient,
      telemetryIngest: this.options.telemetryIngest,
      effectTap: (effect, response) => {
        const marks = this.wakeEffects.getStore();
        marks?.observe(effect, response);
        for (const key of marks?.sentMessageKeys ?? []) this.outboundMessages.mark(key);
        this.options.effectTap?.(effect, response);
      },
      // `wake_at` reaches the lane's timer through here. The handler
      // is built once and has no laneKey, so it derives one the same way the
      // event queue does (see laneKeyFor).
      wakeScheduler: {
        armWakeAt: (sessionId, at, reason) =>
          this.stateTimers.armWakeAt(
            laneKeyFor(this.options.agentId!, sessionId),
            at,
            reason,
            this.wakeEffects.getStore()?.scope,
          ),
      },
    });

    this.brain = this.options.brain?.kind === 'handler'
      ? { workflow, tick: this.options.brain.config.tick }
      : isClaudeCognition(this.options.cognition)
      ? new ClaudeBrain({
          workflow,
          toolManager: services.toolManager,
          description: this.options.description!,
          systemPrompt: this.options.systemPrompt,
          loadSystemPrompt: this.options.loadSystemPrompt,
          specialization: this.options.specialization,
          model: resolveClaudeModel(
            this.options.model,
            (this.options.services?.llm as { model?: string } | undefined)?.model,
          ),
          anthropicKey: this.options.anthropicKey!,
          operatorKey: this.options.operatorKey!,
          agentId: this.options.agentId!,
          // No taskService/agreementService: Claude-brain tools execute through
          // eff({ kind: 'tool-call' }) → the shared executor, which sources those
          // services from the effect handler's deps like the FSM path.
          maxTurns: this.options.claudeMaxTurns,
          statelessPerWake: this.options.claudeStatelessPerWake,
          actsOnHireActivation: this.options.actsOnHireActivation === true,
          ...(this.options.wakeGate === false || !this.options.operatorKey
            ? {}
            : {
                askWakeGate: backendWakeGate({
                  operatorKey: this.options.operatorKey,
                  agentId: this.options.agentId!,
                }),
              }),
        })
      : new ZiggsBrain({
          workflow,
          toolManager: services.toolManager,
          promptBuilder: services.promptBuilder,
        });

    this.eventQueue = new EventQueue((event, laneKey) => this._processEvent(event, laneKey));
    // A timer frame is not a delivery: there is no watermark waiting on it and
    // nothing to redeliver, so its failure is logged and dropped here rather
    // than left as an unhandled rejection (made enqueue reject).
    this.stateTimers = new StateTimers((ev, laneKey) => {
      void this.eventQueue.enqueue(ev, laneKey).catch((err: unknown) => {
        runtimeLog.warn(
          'Agent',
          `state-timer frame failed laneKey=${laneKey}: ${(err as Error)?.message || err}`,
        );
      });
    });
  }

  private executionControlOn(): boolean {
    return this.options.executionControl ?? isClaudeCognition(this.options.cognition);
  }

  /**
   * The door every work tool passes: the agent names a task it holds, the
   * host verifies it with the backend, and the task's agreement is the
   * permission. Reads use the agent's own credentials in this lane.
   */
  private executionController(identity: Identity, signal: AbortSignal, onTaskBound?: (taskId: string) => void): ExecutionController | undefined {
    if (!this.executionControlOn()) return undefined;
    const creds = { operatorKey: this.options.operatorKey, agentId: this.options.agentId, laneId: identity.sessionId };
    return new ExecutionController({
      agentId: identity.agentId, signal, onTaskBound,
      readTask: id => getTask(id, creds),
      readAgreement: id => getAgreement(id, creds),
    });
  }

  /**
   * The lane's task and agreement after a wake, as the controller saw them.
   * Kept so the model sees them in its context next time and can name the
   * task again; the next wake never takes them as a default.
   */
  private carryExecutionState(ctx: Ctx | undefined, controller: ExecutionController | undefined): void {
    if (!ctx || !controller) return;
    const taskId = controller.currentTaskId;
    if (taskId) {
      ensureTaskBook(ctx, taskId, controller.currentAgreementId);
      ctx.activeTaskId = taskId;
      if (controller.currentAgreementId) ctx.activeAgreementId = controller.currentAgreementId;
    } else if (controller.closedTask && ctx.activeTaskId === controller.closedTask) {
      ctx.activeTaskId = null;
    }
  }

  /** Runtime control is a task fact, never model-interpreted message text. */
  private async taskExecutionControl(taskId: string): Promise<{ blocked: boolean; unread?: boolean; closed?: boolean; control?: TaskControl | null } | null> {
    if (!this.taskService) return null;
    let task;
    try { task = await this.taskService.getTask(taskId) as unknown as {
      assigneeId?: string; executorIsYou?: boolean; state?: string; control?: TaskControl | null;
    }; } catch (error) {
      // Unreadable is not a hold. The wake filter still drops a frame whose
      // own task cannot be read; a tool that names one gets an error instead.
      if ([403, 404].includes((error as { status?: number }).status ?? 0)) return { blocked: true, unread: true };
      throw error;
    }
    // A coordinator sees its children's task events too; those do not pause it.
    if (task.executorIsYou !== true && task.assigneeId !== this.options.agentId) return null;
    return { blocked: task.state === 'cancelled' || (task.state === 'active' && task.control?.action === 'pause'), closed: task.state === 'cancelled', control: task.control };
  }

  private async acknowledgeExecutionControl(taskId: string, control?: TaskControl | null): Promise<void> {
    if (control?.status !== 'requested') return;
    try {
      if (control.action !== 'resume') {
        // Custom session resolvers may run the same task in different lanes.
        // Acknowledgement covers all of this runtime's task executions.
        const active = [...(this.activeTaskRuns.get(taskId) ?? [])];
        for (const run of active) {
          run.control = control;
          run.abort.abort(Object.assign(new Error('Task execution held'), { code: 'TASK_CONTROL', taskId, control }));
        }
        // The finishing run acknowledges after its actual operations settle.
        // A tool that ignores cancellation must not hold up this inbox lane.
        if (active.length) return;
      }
      await this.taskService?.acknowledgeControl(taskId, control.requestId);
    } catch (error) {
      // A newer user request wins. Its durable inbox event will be handled next.
      if ((error as { status?: number }).status !== 409) runtimeLog.warn('Agent', `control acknowledgement failed for ${taskId}: ${(error as Error).message}`);
    }
  }

  /**
   * Handler for a resource change (artifact created, task state transition,
   * agreement updated) surfaced by the inbox loop. The agent decides which
   * session/lane to route it to from the event payload, then pulls the actual
   * data via the primitive endpoints from inside the tick.
   *
   * No client-side relevance or echo guard: event targeting is backend policy
   * now (the law never routes an agent its own writes), and the inbox loop is a
   * single delta-read channel — there is no second channel to dedup against.
   * Lightweight: defers all work to a tick by enqueueing a synthetic event
   * carrying just enough context to route it.
   */
  async handleResourceEvent(event: Record<string, unknown>): Promise<void> {
    if (!event || typeof event !== 'object') return;
    const ownAgentId = this.options.agentId;
    if (!ownAgentId) return;

    // A permission decision is a notice about a grant, not authority to run
    // work under the (now fulfilled/cancelled) request. Resume the hire that
    // the server recorded when it validated the request; ordinary read/write
    // gates still recheck that hire. Ignore the duplicate lifecycle echo.
    let resumeAgreementId: string | undefined;
    const reason = typeof event.reason === 'string' ? event.reason : '';
    if (event.kind === 'agreement' && /^(context_request_|approval:|status:cancelled)/.test(reason)) {
      const requestId = String(event.resourceId || event.agreementId || '');
      try {
        const row = await this.agreementService.get(requestId) as unknown as { grantRequest?: unknown } | null;
        const request = row?.grantRequest;
        if (isContextAccessRequest(request) && typeof request.resumeAgreementId === 'string' && request.resumeAgreementId) {
          if (!reason.startsWith('context_request_')) return;
          resumeAgreementId = request.resumeAgreementId;
        }
      } catch {
        // A revoked or unavailable agreement must not pin the inbox cursor.
        // Route the original event; normal tool authorization still applies.
        runtimeLog.debug('Agent', 'Access-decision lookup unavailable; using original event');
      }
    }

    // Map the event to a candidate session key using the configured resolver
    // on a synthetic normalized-event shape. Default resolver buckets by
    // chatId; agents using a different sessionResolver (agreementId, taskId,
    // counterpartyId) will get the right lane here as long as the wire
    // event carries the corresponding id.
    const fakeNormalized = {
      chatId: event.chatId as string | null,
      event: { type: 'message' as const, timestamp: Date.now(), text: '' },
    } as NormalizedEvent;
    let sessionId = this.sessionResolver(fakeNormalized, ownAgentId);
    // store claims deliver agreement wakes with no chatId. Do not
    // drop them; lane by agreement the same way task bootstrap does
    // (`agrn-<agreementId>`), never a bare agreement id.
    if (!sessionId) {
      const agreementId =
        (typeof event.agreementId === 'string' && event.agreementId) ||
        (event.kind === 'agreement' &&
          typeof event.resourceId === 'string' &&
          event.resourceId) ||
        null;
      if (agreementId) sessionId = agreementLaneId(agreementId);
    }
    if (!sessionId) return;

    const laneKey = laneKeyFor(ownAgentId, sessionId);
    if (!this.sessions.has(laneKey)) {
      this.sessions.set(laneKey, { sessionId, ownAgentId });
    }
    const agreementId = resumeAgreementId ||
      (typeof event.agreementId === 'string' && event.agreementId) ||
      (event.kind === 'agreement' && typeof event.resourceId === 'string'
        ? event.resourceId
        : undefined);
    const actorId = typeof event.actorId === 'string' && event.actorId ? event.actorId : undefined;
    return this.eventQueue.enqueue(
      {
        type: SERVER_EVENTS.resourceChanged,
        resource: event,
        chatId: event.chatId,
        taskId: event.taskId,
        agreementId,
        // Claimer/buyer — chat_send defaults receiverId from senderId.
        ...(actorId ? { senderId: actorId } : {}),
      },
      laneKey,
    );
  }

  /** Wire entry. Normalize → resolve session → enqueue on the right lane. */
  async handleMessage(text: string, metadata: Record<string, unknown> = {}): Promise<void> {
    // Permission decisions also arrive as a chat notification. The dedicated
    // context_request_* resource event owns continuation; processing this echo
    // would answer twice, once under the permission request instead of the hire.
    const notice = metadata.service as { operation?: string; agreement?: { grantRequest?: { primitive?: string; kind?: string } } } | undefined;
    if (metadata.entryType === 'notification' &&
        ['proposal_approved', 'proposal_rejected'].includes(notice?.operation ?? '') &&
        isContextAccessRequest(notice?.agreement?.grantRequest)) return;
    const messageId = metadata.messageId as string | undefined;
    if (messageId && this.seenMessages.has(messageId)) {
      runtimeLog.debug('Agent', `skip duplicate messageId=${messageId}`);
      return;
    }
    if (messageId) this.seenMessages.mark(messageId);

    const ownAgentId = this._resolveOwnAgentId();
    if (!ownAgentId) {
      runtimeLog.warn('Agent', 'handleMessage: ownAgentId missing — dropping event');
      return;
    }

    let enrichedText = typeof text === 'string' ? text : '';
    if (!enrichedText.trim()) {
      // agreement rides under `service` on the inbox-pull wire; fall
      // back to top-level for hand-built metadata.
      const svc = metadata.service as { agreement?: Record<string, unknown> } | undefined;
      const agreement = (svc?.agreement ?? metadata.agreement) as Record<string, unknown> | undefined;
      const terms = agreement?.terms as { description?: string } | undefined;
      if (terms?.description) {
        enrichedText = String(terms.description);
      }
    }

    // Classification + shape only. Targeting is backend policy now — the inbox
    // loop delivers only what is fenced to this agent, so there is no
    // client-side "is this for me" gate to apply.
    const normalized = normalizeIncomingEvent({ text: enrichedText, metadata, ownAgentId });

    const sessionId = this.sessionResolver(normalized, ownAgentId);
    if (!sessionId) {
      runtimeLog.warn('Agent', `session resolver returned null ownAgentId=${ownAgentId} chatId=${normalized.chatId ?? 'null'}`);
      return;
    }

    const laneKey = laneKeyFor(ownAgentId, sessionId);
    if (!this.sessions.has(laneKey)) {
      this.sessions.set(laneKey, { sessionId, ownAgentId });
    }
    // The inbox loop owns ack (act-before-ack, delivery law); the agent only
    // routes the event onto its lane. No live-path watermark ack — there is no
    // separate live/push channel to reconcile against anymore.
    //
    // a failure un-marks the messageId. The mark above is what stops
    // the same message being processed twice; leaving it set on a failed wake
    // would make the redelivery this rejection buys us a no-op.
    try {
      await this.eventQueue.enqueue({ ...normalized.event, chatId: normalized.chatId }, laneKey);
    } catch (err) {
      if (messageId) this.seenMessages.unmark(messageId);
      throw err;
    }
  }

  /**
   * part 3 — an agreement lane outlives the agreement.
   *
   * A lane named `agrn-<agreementId>` keeps its Claude session for the whole
   * engagement, so a trailing event after the deal ends pays for all of it: on
   * 2026-08-03 a cancelled hand-off woke its lane once for 92k tokens, and on
   * 08-04 the same shape cost 147k with the session reaching 399,864 input tokens
   * before it reset. Nothing was produced either time — the work had finished and
   * the contract was gone.
   *
   * So a lane whose agreement is terminal does not get a turn. The event is still
   * consumed (and acked by the inbox loop), the FSM is untouched, and a chat lane
   * is never affected: only the agreement-scoped routing key is checked.
   *
   * Failing open is deliberate. If the lookup errors we run the turn — a missed
   * suppression costs tokens, while a wrongly suppressed turn drops work.
   */
  private recordWakeOutcome(
    session: { sessionId: string; ownAgentId?: string },
    outcome: WakeOutcome,
    llmCalls = 0,
  ): void {
    const agentId = session.ownAgentId || this.options.agentId;
    const laneKey = laneKeyFor(agentId, session.sessionId);
    runtimeLog.info(
      this.options.name || 'agent',
      `wake-outcome agent=${agentId} lane=${laneKey} kind=${outcome.kind}` +
        (outcome.reason ? ` reason=${outcome.reason}` : '') +
        // A question nobody answered is the line worth grepping for, so it is
        // on the line rather than only in the telemetry payload.
        (outcome.reply
          ? ` asked=1 answered=${outcome.reply.sent ? 1 : 0}` +
            (outcome.reply.sent ? '' : ` unanswered=${outcome.reply.reason}`)
          : ''),
    );
    sendTelemetry(
      this.telemetryClient,
      buildWakeOutcomePayload({
        agentId,
        sessionId: session.sessionId,
        laneKey,
        outcome,
        llmCalls,
      }),
      isTelemetryIngestEnabled(this.options.telemetryIngest),
    );
  }

  private memoryForWake(
    session: {
      sessionId: string;
      ctx?: Ctx | { activeAgreementId?: string | null };
      actingHireId?: string | null;
    },
    event?: unknown,
  ): MemoryStore {
    const fromEvent = hireIdsFromEvent(event);
    const wakeAgreementIds = fromEvent.length ? fromEvent : uniqueHireIds([session.actingHireId]);
    const section = memorySectionForWake({
      sessionId: session.sessionId,
      activeAgreementId: fromEvent.length ? undefined : (session.ctx as { activeAgreementId?: string | null } | undefined)
        ?.activeAgreementId,
      wakeAgreementIds,
    });
    const known = uniqueHireIds([
      fromEvent.length ? undefined : (session.ctx as { activeAgreementId?: string | null } | undefined)
        ?.activeAgreementId,
      ...wakeAgreementIds,
    ]);
    if (known.length === 1) session.actingHireId = known[0];
    else if (known.length > 1) session.actingHireId = null;
    return partitionMemoryStore(this.memory, section);
  }

  /**
   * A chat-lane session that still carries a cancelled hire from a previous
   * engagement will agreement_get that dead row and stop. Drop it so this
   * wake keys on the live room / hire.
   */
  private async dropStaleCancelledAgreementSession(session: {
    sessionId: string;
    ctx?: Ctx;
  }): Promise<void> {
    const ctx = session.ctx as
      | { activeAgreementId?: string | null; claudeSessionId?: string }
      | undefined;
    const pinned = ctx?.activeAgreementId;
    if (!pinned || !this.agreementService) return;
    if (session.sessionId === agreementLaneId(pinned)) return;
    try {
      const agreement = await this.agreementService.get(pinned);
      const status = String(
        (agreement as { status?: string } | null)?.status ?? '',
      );
      if (
        status === 'cancelled' ||
        status === 'refunded' ||
        status === 'fulfilled'
      ) {
        runtimeLog.info(
          this.options.name || 'agent',
          `dropping session pinned to terminal agreement ${pinned} lane=${session.sessionId}`,
        );
        ctx.activeAgreementId = null;
        ctx.claudeSessionId = undefined;
      }
    } catch {
      // Fail open: a lookup error must not drop a live hire's session.
    }
  }

  private async laneAgreementIsTerminal(sessionId: string): Promise<boolean> {
    const agreementId = agreementIdFromLane(sessionId);
    if (!agreementId || !this.agreementService) return false;
    try {
      const agreement = await this.agreementService.get(agreementId);
      const status = String(
        (agreement as { status?: string } | null)?.status ?? '',
      );
      return (
        status === 'cancelled' || status === 'refunded' || status === 'fulfilled'
      );
    } catch {
      return false;
    }
  }

  /**
   * Whether the host answers this wake without spending a model turn.
   *
   * One decision, consulted by the live path and by {@link Agent.replayWake},
   * because a recording is only worth keeping if a replay can tell you what the
   * host would do now. It used to run only on the live path, so an edit to any
   * of these rules was invisible to a replay — the tool that exists to answer
   * "what changed?" could not see the change.
   *
   * Every rule here reads a row or the frame itself. None of them reads a lane,
   * an agent kind, a name or an id shape.
   */
  private async wakeSuppression(
    event: unknown,
    sessionId: string,
  ): Promise<{ reason: string; because: string } | null> {
    if (await this.laneAgreementIsTerminal(sessionId)) {
      return { reason: 'agreement_terminal', because: 'its agreement is terminal' };
    }
    if (this.isSettledTaskEcho(event)) {
      return {
        reason: 'task_already_settled',
        because: 'its task already reported a result',
      };
    }
    if (isHireActivationNotice(event)) {
      const id = agreementIdFromWake(event);
      const agreement = id && this.options.actsOnHireActivation !== true
        ? await this.agreementService.get(id).catch(() => null) as { formedBy?: AgreementFormedBy; terms?: { interactionMode?: string } } | null
        : null;
      if (agreement?.terms?.interactionMode === 'tasks')
        return { reason: 'task_only_activation', because: 'task-only service waits for assigned work' };
      const formedBy = formedByFromWake(event) ?? agreement?.formedBy;
      if (
        shouldSkipAgentFormedHireActivation({
          event,
          formedBy,
          actsOnHireActivation: this.options.actsOnHireActivation === true,
        })
      ) {
        return {
          reason: 'agent_formed_hire_activation',
          because: 'agent-formed hire activation',
        };
      }
    }
    return null;
  }

  /**
   * the trailing turn on work that is already reported.
   *
   * A lane session carries the whole engagement, so the LAST wake is the most
   * expensive one: on prod, the frame that followed a completed elicitation cost
   * **158,733 tokens** with the session's input at 366,417 before reset
   * it, and produced nothing — the spec had been written and the task closed one
   * frame earlier.
   *
   * A task frame that carries a terminal state AND a result is an echo of work
   * this agent has already finished: there is no decision left in it. Dropping it
   * is not the same suppression as {@link laneAgreementIsTerminal}, which waits
   * for the agreement to end — this fires while the engagement is still live,
   * which is where the cost actually was.
   *
   * Deliberately narrow: only a `task_result` frame, only with a terminal state,
   * and only when a result is attached. A completed task with no result recorded
   * still gets its turn, because that is an agent with something left to say.
   */
  private isSettledTaskEcho(event: unknown): boolean {
    const frame = event as
      | { type?: string; result?: Record<string, unknown> }
      | null
      | undefined;
    if (frame?.type !== 'task_result') return false;
    const result = frame.result;
    if (!result) return false;
    const state = String(result.state ?? '');
    if (state !== 'completed' && state !== 'cancelled' && state !== 'failed') {
      return false;
    }
    const reported = result.result;
    return reported !== undefined && reported !== null && reported !== '';
  }

  /** Providers of this agent's live connection grants. Its own seam, so the gate below is testable without a backend. */
  private async _listGrantProviders(
    operatorKey: string,
    agentId: string,
  ): Promise<Array<string | null | undefined>> {
    const groups = await new ConnectionsClient(operatorKey, agentId).listForHolder();
    return groups.filter((g) => (g.grants ?? []).length > 0).map((g) => g.provider);
  }

  /**
   * Short TTL on purpose: the gate runs on every wake, and a claim produces
   * several in seconds — but hire comes before grant, so a grant arriving
   * mid-engagement has to take effect without a restart.
   */
  private async _grantProvidersCached(
    operatorKey: string,
    agentId: string,
  ): Promise<Array<string | null | undefined>> {
    const now = Date.now();
    if (this.grantProviderCache && now - this.grantProviderCache.at < 30_000) {
      return this.grantProviderCache.providers;
    }
    const providers = await this._listGrantProviders(operatorKey, agentId);
    this.grantProviderCache = { at: now, providers };
    return providers;
  }

  /**
   * Refuse work this agent has no way to do, before it costs a turn.
   * Returns true when work was refused and the tick must not run.
   *
   * Enforced at wake for an agent holding assigned work, not at hire: hire comes
   * first and the grant second, so a hire-time gate would refuse every honest
   * one. Not limited to the task frame either — a store claim wakes the agent on
   * the agreement first, and a task-only gate let the model take that turn and
   * reason its own way to "I have no grant" (measured on linear-janitor: 8 calls,
   * 114,025 tokens, for what one HTTP call answers).
   *
   * It fails the task rather than skipping quietly, which would leave it active
   * with nothing working it — the same invisible stall from the buyer's side.
   */
  private async _refuseIfNeedsUnmet(_event: unknown, _laneKey: string): Promise<boolean> {
    const needs = normalizeNeeds(this.options.needs);
    if (!needs.length) return false;

    const operatorKey = this.options.operatorKey;
    const agentId = this.options.agentId;
    if (!operatorKey || !agentId || !this.taskService) return false;

    let providers: Array<string | null | undefined>;
    try {
      providers = await this._grantProvidersCached(operatorKey, agentId);
    } catch (err: unknown) {
      // A grants read that failed is not proof the grant is missing, and failing
      // the task on our own outage would be worse than letting the agent try.
      runtimeLog.warn(
        this.options.name || 'agent',
        `needs check skipped: ${(err as Error)?.message ?? err}`,
      );
      return false;
    }

    const unmet = unmetNeeds(needs, providers);
    if (!unmet.length) return false;

    // Only work already on this agent's plate is refused. A wake with no assigned
    // task is someone talking to it — an agent that cannot reach Linear can still
    // say so in a sentence, and muting it would be a worse silence.
    let assigned: Array<{ taskId?: string; assigneeId?: string | null }>;
    try {
      assigned = await this.taskService.getActiveTasksForAgent(agentId);
    } catch (err: unknown) {
      runtimeLog.warn(
        this.options.name || 'agent',
        `needs check could not read assigned work: ${(err as Error)?.message ?? err}`,
      );
      return false;
    }
    const mine = assigned.filter((t) => t.taskId && (!t.assigneeId || t.assigneeId === agentId));
    if (!mine.length) return false;

    const message = unmetNeedsMessage(unmet);

    /**
     * Ask BEFORE refusing, once per lane, when this agent can ask at all.
     *
     * Order is the whole fix. Failing the task first and then letting the wake
     * run does nothing: the brain declines a wake whose task already reported a
     * result, so the agent never speaks and the buyer is left with "ask the
     * connection owner to issue a grant" for a connection only they can make —
     * and no place in the web app to make it, because the grant dialog lists the
     * workspace's own agents and a fleet-hosted one is not among them.
     *
     * So the first unmet wake on a lane runs with the task still active: the
     * agent's own instructions send the consent card and fail the task. Whatever
     * it leaves active is failed right after the tick ({@link settleUnmetAfterAsk}),
     * so nothing hangs, and every later wake on the lane is refused up front as
     * before — a buyer who ignores the card is not billed for reminders.
     */
    if (this.canAskForAccess() && !this.askedForAccessLanes.has(_laneKey)) {
      this.askedForAccessLanes.add(_laneKey);
      this.unmetTasksPendingAsk.set(
        _laneKey,
        mine.map((t) => String(t.taskId)),
      );
      runtimeLog.info(
        this.options.name || 'agent',
        `no access for ${unmet.map((n) => ('connection' in n ? n.connection : 'checkout')).join('/')} on ${_laneKey} — letting this wake run once so it can ask, then failing whatever it leaves`,
      );
      return false;
    }

    for (const task of mine) {
      const taskId = String(task.taskId);
      runtimeLog.warn(this.options.name || 'agent', `refusing task ${taskId} — ${message}`);
      try {
        await this.taskService.updateState(taskId, 'failed' as TaskState, {
          summary: message,
          status: 'failed',
        });
      } catch (err: unknown) {
        runtimeLog.warn(
          this.options.name || 'agent',
          `could not fail task ${taskId} after refusing it: ${(err as Error)?.message ?? err}`,
        );
      }
    }

    return true;
  }

  /**
   * Fail whatever the asking turn left active.
   *
   * The one turn granted above runs with the task still active so the agent can
   * ask; the agent's own instructions then fail it. This is the backstop for when
   * they do not: an active task nobody is working is the invisible stall the gate
   * exists to prevent, and it must not be the price of asking.
   */
  private async settleUnmetAfterAsk(laneKey: string): Promise<void> {
    const pending = this.unmetTasksPendingAsk.get(laneKey);
    if (!pending?.length) return;
    this.unmetTasksPendingAsk.delete(laneKey);
    if (!this.taskService) return;

    for (const taskId of pending) {
      try {
        const active = await this.taskService.getActiveTasksForAgent(this.options.agentId);
        if (!active.some((t) => String(t.taskId) === taskId)) continue;
        runtimeLog.warn(
          this.options.name || 'agent',
          `failing task ${taskId} — it asked for the missing access but left the work open`,
        );
        await this.taskService.updateState(taskId, 'failed' as TaskState, {
          summary: unmetNeedsMessage(normalizeNeeds(this.options.needs)),
          status: 'failed',
        });
      } catch (err: unknown) {
        runtimeLog.warn(
          this.options.name || 'agent',
          `could not settle task ${taskId} after the access ask: ${(err as Error)?.message ?? err}`,
        );
      }
    }
  }

  /**
   * Whether this agent holds the tool that turns "I cannot" into "here is what I
   * need". Without it the extra turn buys nothing, so it is not spent.
   */
  private canAskForAccess(): boolean {
    const tools = this.options.tools ?? this.options.services?.tools ?? [];
    return tools.some((t) => toolName(t as ToolDefinition) === 'connection_request');
  }

  private async _processEvent(event: unknown, laneKey: string): Promise<void> {
    const session = this.sessions.get(laneKey);
    if (!session?.sessionId) return;

    // Presentation may call our sender an rpb-* room binding or the person we
    // stand in for. Only an exact (chat, messageId) we successfully sent proves
    // an echo; another message from the same binding still gets a full wake.
    const incoming = event as { type?: string; events?: unknown[] } | null;
    const events = incoming?.type === 'batch' && Array.isArray(incoming.events) ? incoming.events : [event];
    const remaining = events.filter((item) => {
      const e = item as { type?: string; source?: string; chatId?: string; messageId?: string; result?: { taskId?: string; state?: string; updatedAt?: string; assigneeId?: string } } | null;
      const task = e?.type === 'task_result' ? e.result : undefined;
      if (this.stateTimers.peek(laneKey)?.kind === 'wake-at'
        && e?.source === 'active-task-snapshot' && (task?.state === 'active' || task?.state === 'in-progress')
        && task?.assigneeId === this.options.agentId && task.taskId && task.updatedAt && this.confirmedPlanVersions.has(
        JSON.stringify([laneKey, JSON.stringify([task.taskId, task.updatedAt])]),
      )) return false;
      return e?.type !== 'message' || !e.messageId || !this.outboundMessages.has(
        JSON.stringify([e.chatId ?? session.sessionId, e.messageId]),
      );
    });
    if (remaining.length === 0) {
      this.recordWakeOutcome(session, { kind: 'no-op', reason: events.some(e => (e as { type?: string })?.type === 'task_result') ? 'own_plan_snapshot' : 'own_message_echo' });
      return;
    }
    if (remaining.length !== events.length) event = remaining.length === 1 ? remaining[0] : { type: 'batch', events: remaining };

    const suppressed = await this.wakeSuppression(event, session.sessionId);
    if (suppressed) {
      runtimeLog.info(
        this.options.name || 'agent',
        `skipping wake on ${session.sessionId} — ${suppressed.because}`,
      );
      this.recordWakeOutcome(session, { kind: 'no-op', reason: suppressed.reason });
      return;
    }

    // Before the tick spends anything: work this agent declared it cannot do
    // without access it does not hold.
    if (await this._refuseIfNeedsUnmet(event, laneKey)) return;

    // Stale timer frames (superseded epoch) are dropped BEFORE touching the
    // live timer — a pure-stale frame must not reset a freshly armed countdown.
    let frame = this.stateTimers.stripStale(event, laneKey);
    if (frame === null) return;
    frame = await withAgreementContext(frame, id => this.agreementService.get(id));

    // Traffic resets inactivity timers, but must not cancel an appointment
    // the agent explicitly requested. Only its own fresh timer frame consumes
    // that wake; a notice-only tick cannot ask the model to restore it.
    this.stateTimers.consumeForEvent(frame, laneKey);

    // Cold-start recovery: restore FSM state from sessionStore when the
    // in-memory lane has no prior context (e.g. after a container restart).
    if (this.sessionStore && session.ctx === undefined && session.state === undefined) {
      try {
        const persisted = await this.sessionStore.load(laneKey);
        if (persisted) {
          session.ctx = persisted.ctx;
          session.state = persisted.state;
        }
      } catch (err: unknown) {
        runtimeLog.warn('Agent', `sessionStore.load failed laneKey=${laneKey}: ${(err as Error)?.message || err}`);
      }
    }

    await this.dropStaleCancelledAgreementSession(session);

    const identity: Identity = {
      agentId: session.ownAgentId || this.options.agentId,
      sessionId: session.sessionId,
      laneKey,
    };
    // Cache only within this wake. Long turns refresh at action boundaries at
    // most once per second, without a read per tool or a fallible final read.
    const controls = new Map<string, { at: number; value: Awaited<ReturnType<Agent['taskExecutionControl']>> }>();
    const readControl = async (taskId: string) => {
      const cached = controls.get(taskId);
      if (cached && Date.now() - cached.at < 1000) return cached.value;
      const value = await this.taskExecutionControl(taskId);
      controls.set(taskId, { at: Date.now(), value });
      return value;
    };
    const frames = (frame as { type?: string; events?: unknown[] })?.type === 'batch'
      ? (frame as { events: unknown[] }).events : [frame];
    const runnable: unknown[] = [];
    for (const item of frames) {
      const taskId = workScopeFromWake(item, session.sessionId).taskId;
      const execution = taskId ? await readControl(taskId) : null;
      if (taskId && execution?.blocked) {
        // The brain never sees this frame, so close the books here the way a
        // task-closed outcome would; a paused task is still open work.
        if (session.ctx && execution.closed) removeTaskBook(session.ctx, taskId);
        if (session.ctx?.activeTaskId === taskId) session.ctx = { ...session.ctx, activeTaskId: null };
        if (this.sessionStore) await this.sessionStore.save(laneKey, { ctx: session.ctx, state: session.state });
        await this.acknowledgeExecutionControl(taskId, execution.control);
      } else {
        if (taskId && execution?.control?.action === 'resume') await this.acknowledgeExecutionControl(taskId, execution.control);
        runnable.push(item);
      }
    }
    if (!runnable.length) {
      this.recordWakeOutcome(session, { kind: 'no-op', reason: 'task_control' });
      return;
    }
    if (runnable.length !== frames.length) frame = runnable.length === 1 ? runnable[0] : { type: 'batch', events: runnable };
    const memory = this.memoryForWake(session, frame);
    const wakeTaskId = workScopeFromWake(frame, session.sessionId).taskId;

    // A checkout agent gets its box before the brain runs: the task names the
    // repository, the hire's GitHub grant backs the clone, and a task that
    // names nothing or holds no grant is refused here by name, like the needs
    // gate above.
    const checkout = await this._openCheckoutForWake(laneKey, session.sessionId, frame, wakeTaskId);
    if (checkout === 'refused') return;

    // Recorded here rather than after the tick: this is the last point where the
    // input is still exactly what the brain will see, and a wake that goes on to
    // throw is the one most worth replaying.
    if (this.options.wakeTap) {
      try {
        this.options.wakeTap({
          agentId: identity.agentId,
          sessionId: identity.sessionId,
          laneKey,
          event: frame,
          ctx: session.ctx,
          state: session.state,
        });
      } catch (err: unknown) {
        runtimeLog.warn('Agent', `wakeTap failed: ${(err as Error)?.message || err}`);
      }
    }

    // The watchdog timer must be cleared once the tick settles — leaving it
    // armed pinned one live 2-minute timer per tick (and kept short-lived
    // processes/tests alive until it fired).
    let tickWatchdog: ReturnType<typeof setTimeout> | undefined;
    // Aborting on timeout is load-bearing: Promise.race only abandons the tick
    // promise. A Claude-brain tick left unaborted keeps its query() running as
    // a zombie — burning tokens and racing the redelivered retry of the same
    // event (duplicate sends, runaway per-wake input).
    const tickAbort = new AbortController();
    const marks = WakeEffects.forWake(frame, session.sessionId);
    const executionController = this.executionController(identity, tickAbort.signal, taskId => registerTaskRun(taskId));
    let heldTask: { taskId: string; control?: TaskControl | null } | undefined;
    const pendingEffects = new Set<Promise<unknown>>();
    let savedSession: Promise<void> | undefined;
    let tickWork: Promise<TickOutput> | undefined;
    const taskRuns = new Map<string, { run: { abort: AbortController; control?: TaskControl | null }; release: () => void }>();
    const registerTaskRun = (taskId: string) => {
      if (taskRuns.has(taskId)) return;
      const run = { abort: tickAbort };
      const active = this.activeTaskRuns.get(taskId) ?? new Set();
      active.add(run);
      this.activeTaskRuns.set(taskId, active);
      taskRuns.set(taskId, { run, release: () => {
        active.delete(run);
        if (!active.size) this.activeTaskRuns.delete(taskId);
      } });
    };
    const releaseTaskRuns = () => {
      for (const { release } of taskRuns.values()) release();
      taskRuns.clear();
    };
    const checkpoint = async (namedTaskId?: string): Promise<{ error: string } | void> => {
      if (tickAbort.signal.aborted) {
        if (tickAbort.signal.reason?.code === 'TASK_CONTROL') heldTask = tickAbort.signal.reason;
        throw tickAbort.signal.reason;
      }
      if (heldTask) throw new Error('Task execution held');
      const wakeId = marks.scope.taskId ?? wakeTaskId;
      const taskId = namedTaskId ?? wakeId;
      if (!taskId) return;
      // Only this wake's own task shares the tick abort. A tool that names
      // some other task must not be able to cancel the rest of the wake.
      const ownsWake = namedTaskId == null || namedTaskId === wakeId;
      if (ownsWake) registerTaskRun(taskId);
      const execution = await readControl(taskId);
      if (heldTask) throw new Error('Task execution held');
      if (!execution?.blocked) return;
      if (!ownsWake || execution.unread) {
        const error = execution.unread
          ? `Task ${taskId} cannot be read. This call did not run.`
          : execution.closed
            ? `Task ${taskId} is cancelled. This call did not run.`
            : `Task ${taskId} is paused. This call did not run.`;
        return { error };
      }
      heldTask = { taskId, control: execution.control };
      taskRuns.get(taskId)!.run.control = execution.control;
      tickAbort.abort(Object.assign(new Error('Task execution held'), { code: 'TASK_CONTROL', taskId, control: execution.control }));
      throw new Error('Task execution held');
    };
    const taskIdNamedBy = (effect: { kind: string; name?: string; args?: unknown }): string | undefined => {
      if (effect.kind !== 'tool-call' || !effect.args || typeof effect.args !== 'object' || Array.isArray(effect.args)) return undefined;
      const args = effect.args as Record<string, unknown>;
      if (typeof args.taskId === 'string') return args.taskId;
      return undefined;
    };
    const eff: EffectHandler = async (effect) => {
      // Record-only telemetry can finish after interruption. Every action and
      // model call checks the current task before starting another operation.
      if (effect.kind === 'tool-call') {
        const refusal = await checkpoint(taskIdNamedBy(effect));
        // The handler is generic over every effect. This branch is only a tool call.
        if (refusal) return { ok: false, error: refusal.error } as never;
      } else if (effect.kind !== 'record-event') {
        await checkpoint();
      }
      const agreementId = marks.scope.agreementId;
      const sameRoom = 'sessionId' in effect && effect.sessionId === session.sessionId;
      const scopedEffect = sameRoom && effect.kind === 'read-context'
        ? { ...effect, opts: { ...(effect as { opts?: import('./types.js').ReadContextOpts }).opts, workScopes: contextScopesFromWake(frame, session.sessionId) } }
        : agreementId && effect.kind === 'send-message'
        ? { ...effect, underAgreementId: (effect as { underAgreementId?: string }).underAgreementId ?? agreementId }
        : agreementId && (effect.kind === 'tool-call' || effect.kind === 'record-event')
          ? { ...effect, serviceAgreementId: (effect as { serviceAgreementId?: string }).serviceAgreementId ?? agreementId }
          : effect;
      const operation = this.eff(scopedEffect);
      pendingEffects.add(operation);
      const response = await operation.finally(() => { pendingEffects.delete(operation); });
      marks.observe(effect, response);
      for (const key of marks.sentMessageKeys) this.outboundMessages.mark(key);
      return response;
    };
    try {
      await checkpoint();
      const tick = () => this.wakeEffects.run(marks, () => this.brain.tick({ event: frame, ctx: session.ctx, state: session.state, identity, eff, memory, transitionTap: this.options.transitionTap, signal: tickAbort.signal, ...(checkout ? { checkout: checkout.session } : {}) }));
      tickWork = executionController ? executionControllers.run(executionController, tick) : tick();
      const result = await Promise.race([
        tickWork,
        new Promise<never>((_, reject) => {
          tickWatchdog = setTimeout(() => {
            tickAbort.abort(new Error('tick timeout'));
            reject(new Error('tick timeout'));
          }, checkout ? Math.max(this.tickTimeoutMs, CHECKOUT_TICK_TIMEOUT_MS) : this.tickTimeoutMs);
        }),
      ]);
      session.ctx = result.ctx;
      this.carryExecutionState(session.ctx, executionController);
      session.state = result.state;
      this.sessions.set(laneKey, session);
      // The box dies with the wake, and what it cost rides the same cost line
      // as the wake's tokens.
      const boxCost = await this._closeCheckoutForWake(laneKey);
      if (boxCost && result.metrics) result.metrics = { ...result.metrics, box: boxCost };
      this.recordWakeOutcome(
        session,
        classifyWakeOutcome({
          skippedReason: result.skippedReason,
          llmCalls: result.metrics?.llmCalls ?? 0,
          sentMessage: marks.sentMessage,
          taskWrite: marks.taskWrite,
          asked: wakeWasAsked(frame, identity.agentId),
        }),
        result.metrics?.llmCalls ?? 0,
      );

      // One line per wake that actually spent LLM budget — the handle for
      // tracking a hosted agent live (grep `agent=<id>`). Parked no-op ticks
      // (FSM exits, wake-rate-skipped Claude wakes) report zero tokens and
      // stay quiet. A regressed self-wake loop shows here as a rapid stream of
      // these lines for one lane. Tokens are billable input (incl. cache).
      const m = result.metrics;
      if (m && (m.tokens?.total ?? 0) > 0) {
        runtimeLog.info(
          'Agent',
          `wake agent=${identity.agentId} lane=${laneKey} llmCalls=${m.llmCalls} ` +
            `tokens_in=${m.tokens.input} tokens_out=${m.tokens.output} total=${m.tokens.total}`,
        );
      }

      // Single source of truth for usage/cost: emit the tick's
      // authoritative token metrics once, for every cognition. Never let an
      // observability failure break the tick.
      if (this.options.metricsTap && result.metrics) {
        try {
          this.options.metricsTap({
            agentId: identity.agentId,
            sessionId: session.sessionId,
            model: this.options.model ?? 'unknown',
            cognition: this.options.cognition ?? 'fsm',
            metrics: result.metrics,
            ...marks.scope,
          });
        } catch (err: unknown) {
          runtimeLog.warn('Agent', `metricsTap failed: ${(err as Error)?.message || err}`);
        }
      }

      if (this.sessionStore) {
        savedSession = this.sessionStore.save(laneKey, { ctx: session.ctx, state: session.state });
        void savedSession.catch((err: unknown) => {
          runtimeLog.warn('Agent', `sessionStore.save failed laneKey=${laneKey}: ${(err as Error)?.message || err}`);
        });
      }

      // Arm only when the timeout was handled: an unhandled state-timeout must
      // not re-arm, or the lane would runtimeLog.error every timeoutMs forever.
      if (tickAbort.signal.reason?.code === 'TASK_CONTROL') heldTask = tickAbort.signal.reason;
      if (heldTask) {
        this.recordWakeOutcome(session, { kind: 'no-op', reason: 'task_control' });
        return;
      }
      if (!result.stateTimeoutUnhandled) this._armIfTimedParked(laneKey, result.state);

      /**
       * Only a wake that actually reached the brain counts as the asking turn.
       *
       * A notice-only wake (`type: 'notification'`) and a rate-gated one skip the
       * LLM entirely, so the agent had no chance to ask — spending the lane's one
       * turn on it, and failing the task straight after, killed the work before
       * the wake that would have done it ever arrived. Hand the turn back instead
       * and let the next real wake use it.
       */
      if ((result.metrics?.llmCalls ?? 0) > 0) {
        await this.settleUnmetAfterAsk(laneKey);
      } else if (this.unmetTasksPendingAsk.has(laneKey)) {
        this.unmetTasksPendingAsk.delete(laneKey);
        this.askedForAccessLanes.delete(laneKey);
      }
      // The poll can return the row just written by this wake. Only suppress
      // that exact version while this lane has an explicit future wake: a
      // successful but unfinished turn still needs the task poll to recover
      // when it did not schedule its own continuation.
      if (this.stateTimers.peek(laneKey)?.kind === 'wake-at') {
        for (const version of marks.planVersions) this.confirmedPlanVersions.mark(JSON.stringify([laneKey, version]));
      }
    } catch (err: unknown) {
      if (tickAbort.signal.reason?.code === 'TASK_CONTROL') heldTask = tickAbort.signal.reason;
      if (heldTask) {
        this.recordWakeOutcome(session, { kind: 'no-op', reason: 'task_control' });
        return;
      }
      this.recordWakeOutcome(session, {
        kind: 'no-op',
        reason: 'tick_failed',
      });
      runtimeLog.warn('Agent', `tick failed laneKey=${laneKey}: ${(err as Error)?.message || err}`);
      // Deliberate re-arm on failure. Exact scenario: the tick timed out at
      // tickTimeoutMs (or sessionStore.load threw) leaving session.state at a
      // timed parked state — without re-arming, that lane would never wake
      // again unless a real event happens to arrive.
      this._armIfTimedParked(laneKey, session.state ?? this.brain.workflow.initial);
      // Best-effort: also notify the user so the conversation isn't silently
      // stuck. Complements the timer re-arm above — that recovers a
      // parked lane; this tells a waiting human.
      const ev = event as Record<string, unknown> | undefined;
      const senderType = String(ev?.senderType ?? '').toUpperCase();
      const senderId = ev?.senderId as string | undefined;
      if (senderId && senderType === 'USER') {
        this.eff({ kind: 'send-message', sessionId: session.sessionId, receiverId: senderId, text: 'Something went wrong. Please try again.' }).catch(() => {});
      }
      // and then say so. Everything above is recovery for the lane —
      // it does not mean the event was handled, and the caller is about to
      // decide whether the delivery that carried it can be acked. Swallowing
      // here is what turned a failed wake into a lost one: two hand-off publish
      // notifications were acked after failing, so nothing ever redelivered
      // them and a claim stayed blocked on consent that no wake would give.
      throw err;
    } finally {
      clearTimeout(tickWatchdog);
      // Do not extend the tick watchdog with unbounded cleanup. Keep the
      // run registered until its actual work settles; only then can we attest.
      const finish = async () => {
        await Promise.allSettled([tickWork, ...pendingEffects]);
        try { await savedSession; } catch { releaseTaskRuns(); return; }
        const controlsToAck = [...taskRuns].map(([taskId, { run }]) => ({ taskId, control: run.control }));
        releaseTaskRuns();
        for (const { taskId, control } of controlsToAck) await this.acknowledgeExecutionControl(taskId, control);
      };
      void finish().catch(error => runtimeLog.warn('Agent', `task control cleanup failed: ${String(error)}`));
      // Also on the failure path: a tick that threw still must not leave the
      // work it was refused for sitting active.
      if (!heldTask) await this.settleUnmetAfterAsk(laneKey).catch(() => {});
      // A tick that threw still must not leave its box running.
      await this._closeCheckoutForWake(laneKey).catch(() => {});
    }
  }

  /**
   * The checkout a wake needs, opened before the brain runs. Null when this
   * wake needs none; `'refused'` when the task was failed here by name.
   */
  private async _openCheckoutForWake(
    laneKey: string,
    sessionId: string,
    frame: unknown,
    taskId: string | undefined,
  ): Promise<OpenCheckout | null | 'refused'> {
    const needs = normalizeNeeds(this.options.needs);
    if (!needs.some(isCheckoutNeed) || !taskId) return null;
    const operatorKey = this.options.operatorKey;
    const agentId = this.options.agentId;
    if (!operatorKey || !agentId || !this.taskService) return null;
    const laneId = laneUnderAgreement(sessionId, workScopeFromWake(frame, sessionId).agreementId);
    const open = await openCheckout({
      provider: this.options.checkout,
      needs,
      taskId,
      getTask: (id) => this.taskService.getTask(id),
      listConnections: () => new ConnectionsClient(operatorKey, agentId, undefined, laneId).listForHolder(),
      door: { backendUrl: resolveBackendUrl(), operatorKey, agentId, laneId },
      failTask: async (id, reason) => {
        await this.taskService.updateState(id, 'failed', { summary: reason, status: 'failed' });
      },
      log: (message) => runtimeLog.info(this.options.name || 'agent', message),
    });
    if (open && open !== 'refused') this.checkoutByLane.set(laneKey, open);
    return open;
  }

  /** Destroy the lane's box, if it still holds one, and say what it cost. */
  private async _closeCheckoutForWake(laneKey: string): Promise<{ kind: string; seconds: number; vcpu?: number; memoryMb?: number } | null> {
    const open = this.checkoutByLane.get(laneKey);
    if (!open) return null;
    this.checkoutByLane.delete(laneKey);
    try {
      const cost = await closeCheckout(open);
      runtimeLog.info(this.options.name || 'agent', `checkout closed: ${cost.kind} box held ${cost.seconds}s`);
      return cost;
    } catch (err: unknown) {
      runtimeLog.warn(this.options.name || 'agent', `could not save/close the checkout box: ${(err as Error)?.message ?? err}`);
      throw err;
    }
  }

  /**
   * Re-run one recorded wake against THIS agent, and nothing else.
   *
   * The dev loop for a prompt: record a wake off a live run, edit the agent, and
   * see what it does differently in seconds instead of standing a world back up
   * for one turn. The brain, tools and effect handler are the real ones, so the
   * turn is real — its tool calls hit the backend this agent is pointed at, which
   * is why it belongs against a disposable world and not a shared one.
   *
   * Deliberately NOT routed through `_processEvent`: everything that method does
   * around the tick is lane bookkeeping — session state, liveness timers, session
   * persistence, ack decisions, failure re-arm — and a replay has no lane to keep.
   * Borrowing that path would make a dev tool able to disturb a live one.
   */
  async replayWake(record: WakeRecord): Promise<TickOutput> {
    if (!record?.sessionId) throw new Error('replayWake: record.sessionId is required');
    const identity: Identity = {
      agentId: record.agentId || this.options.agentId!,
      sessionId: record.sessionId,
      laneKey: record.laneKey || record.sessionId,
    };
    // The host's own answer comes first, exactly as it does live. A replay that
    // skipped this would report a model turn the host would never have spent,
    // which is the opposite of what a recording is for.
    const suppressed = await this.wakeSuppression(record.event, record.sessionId);
    if (suppressed) {
      runtimeLog.info(
        this.options.name || 'agent',
        `replay: no wake on ${record.sessionId} — ${suppressed.because}`,
      );
      return { state: record.state } as TickOutput;
    }

    const memory = this.memoryForWake(
      {
        sessionId: record.sessionId,
        ctx: record.ctx as Ctx | undefined,
      },
      record.event,
    );

    // Same watchdog as a live wake, for the same reason: an unaborted Claude
    // query outlives the promise that abandoned it and keeps spending.
    const abort = new AbortController();
    const marks = WakeEffects.forWake(record.event, identity.sessionId);
    const controller = this.executionController(identity, abort.signal);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const tick = () => this.wakeEffects.run(marks, () => this.brain.tick({
          event: record.event,
          ctx: record.ctx as Ctx | undefined,
          state: record.state,
          identity,
          eff: this.eff,
          memory,
          transitionTap: this.options.transitionTap,
          signal: abort.signal,
        }));
      const result = await Promise.race([
        controller ? executionControllers.run(controller, tick) : tick(),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => {
            abort.abort(new Error('tick timeout'));
            reject(new Error('tick timeout'));
          }, this.tickTimeoutMs);
        }),
      ]);
      if (this.options.metricsTap && result.metrics) {
        try {
          this.options.metricsTap({
            agentId: identity.agentId,
            sessionId: identity.sessionId,
            model: this.options.model ?? 'unknown',
            cognition: this.options.cognition ?? 'fsm',
            metrics: result.metrics,
            ...marks.scope,
          });
        } catch (err: unknown) {
          runtimeLog.warn('Agent', `metricsTap failed: ${(err as Error)?.message || err}`);
        }
      }
      return result;
    } finally {
      clearTimeout(watchdog);
    }
  }

  /** Arms the lane's liveness timer iff stateName is a parked state declaring timeoutMs. */
  private _armIfTimedParked(laneKey: string, stateName: string | undefined): void {
    if (!stateName) return;
    const sd = this.brain.workflow.states[stateName];
    if (sd?.kind !== 'parked' || sd.timeoutMs === undefined) return;
    this.stateTimers.arm(laneKey, stateName, sd.timeoutMs);
  }

  private _resolveOwnAgentId(): string | null {
    // The body is constructed for exactly one identity; its own id is the only
    // source. (The socket-frame-era metadata fallbacks — self/agent/ziggsAgentId
    // — are gone: nothing on the inbox wire ever carried them.)
    return this.options.agentId || null;
  }

  async connectAsync(_timeout?: number) {
    if (this.started) return this;
    // Start the per-agent inbox long-poll loop — the agent's sole wake source.
    // There is no socket to connect and no reconnect: a crash is just the
    // loop's next iteration (the cursor is server-side). `_timeout` is accepted
    // for backward-compatible call sites but no longer gates a handshake.
    //
    // There is no separate catch-up sweep here any more. `tasksAwaitingMe` is
    // re-derived from the collection on every pass and redelivers an open
    // assigned task until it closes, so the loop's first pass IS the catch-up —
    // a restarted agent sees its standing work with nothing extra to run. The
    // sweep that used to sit here pulled the same list over
    // `GET /agents/:id/tasks` and reached one gate the inbox does not, which is
    // how a withheld join node got handed to its assignee before its turn.
    if (this.inboxLoopEnabled) {
      const label = this.options.name || 'agent';
      this.inboxLoop = runInboxLoop({
        creds: {
          operatorKey: this.options.operatorKey!,
          agentId: this.options.agentId!,
        },
        ownAgentId: this.options.agentId!,
        seen: this.seenMessages,
        label,
        onMessage: (text, metadata) => {
          return this.handleMessage(text, metadata);
        },
        onResourceEvent: (event) => {
          return this.handleResourceEvent(event);
        },
        // work delivered by the inbox's task channel, not by a chat
        // row — this is what reaches a task under a chat-less agreement or one
        // the agent assigned to itself.
        onTask: async (task) => {
          try {
            await this.wakeTaskAssignment(task.taskId, { fromInbox: true });
          } catch (err) {
            runtimeLog.warn(
              this.options.name || 'agent',
              `inbox task ${task.taskId} could not be woken: ${(err as Error).message}`,
            );
          }
        },
        // exact-match triage in code — miss acks with 0 tokens.
        onRequest: async (request) => {
          await this.triageRequestDelivery(request);
        },
      });
    }
    this.pollRunner?.start();
    this.started = true;
    return this;
  }

  /**
   * plain string compare against {@link AgentOptions.requestMatchTags}
   * and `specialization`. No match → return (caller acks). Match → normal wake.
   */
  private async triageRequestDelivery(request: {
    agreementId: string;
    match: string;
    title: string;
    ts: string;
  }): Promise<void> {
    const tags = [
      ...(this.options.requestMatchTags ?? []),
      ...(this.options.specialization ? [this.options.specialization] : []),
    ];
    if (!requestExactMatch(request.match, tags)) {
      runtimeLog.debug(
        this.options.name || 'agent',
        `request ${request.agreementId}: no tag match for ${JSON.stringify(request.match)} — ack without wake`,
      );
      return;
    }
    const needle = request.match.trim();
    const title = request.title?.trim() || needle;
    await this.handleMessage(
      `New marketplace request matching your tags (${needle}): ${title}. Claim with agreement_claim if you will take it.`,
      {
        messageId: `request-wake:${request.agreementId}:${request.ts}`,
        chatId: `marketplace:${request.agreementId}`,
        agreementId: request.agreementId,
      },
    );
  }
  /** replay task-assigned for an existing active task (demo recovery). */
  async wakeTaskAssignment(taskId: string, options?: { fromInbox?: boolean }): Promise<void> {
    const agentId = this.options.agentId;
    if (!agentId || !this.taskService) {
      throw new Error('wakeTaskAssignment: agent not configured');
    }
    const full = (await this.taskService.getTask(taskId)) as unknown as Record<string, unknown>;
    const state = String(full.state ?? '');
    if (state !== 'active' && state !== 'in-progress') {
      return;
    }
    const sessionId = laneSessionIdForTask(full as {
      originChatId?: string | null;
      agreementId?: string | null;
    });
    const laneKey = laneKeyFor(agentId, sessionId);
    if (!this.sessions.has(laneKey)) {
      this.sessions.set(laneKey, { sessionId, ownAgentId: agentId });
    }
    await this.eventQueue.enqueue(
      {
        type: 'task_result',
        ...(options?.fromInbox ? { source: 'active-task-snapshot' } : {}),
        result: {
          ...full,
          taskId: (full.taskId as string | undefined) ?? taskId,
          state,
          providerIsYou: true,
        },
        chatId: sessionId,
      },
      laneKey,
    );
  }

  /**
   * Stop taking work. Timers and polls stop at once; the inbox loop cancels
   * an idle long-poll and lets a pass already handed to this host finish and
   * acknowledge, then releases the host lease — within `timeoutMs`. A pass
   * that outlasts the bound does not keep the lease: it is released anyway
   * and the next host is handed what was not acknowledged. Resolves once the
   * lease is released either way. In-flight wakes keep running in the event
   * queue; `drain()` is what waits for those.
   */
  async disconnect(timeoutMs = INBOX_STOP_TIMEOUT_MS): Promise<void> {
    this.started = false;
    this.pollRunner?.stop();
    this.stateTimers.clearAll();
    const loop = this.inboxLoop;
    this.inboxLoop = null;
    if (loop) await loop.stop(timeoutMs);
  }
  /**
   * Waits for in-flight ticks to finish. Call before process.exit() on SIGTERM.
   * A timeout is returned, not thrown — the caller names it (lab verdict, fleet
   * shutdown log) instead of EventQueue printing a stray warning.
   */
  drain(timeoutMs = 30_000): Promise<WaitForIdleResult> { return this.eventQueue.waitForIdle(timeoutMs); }
  registerTool(tool: ToolDefinition) { return this.toolManager.register(this.executionControlOn() ? customToolAsWork(tool) : tool); }
  isConnected() { return this.started && (!this.inboxLoopEnabled || (this.inboxLoop?.running ?? false)); }

  /**
   * Whether this agent is still reading its inbox, and when it last did. One
   * signal, three readers: the store's online badge, an operator's health
   * check, and monitoring. `lastPassAt` is the read itself; `lastAttemptAt`
   * says the loop still turns when the server is the thing that is down.
   * A `pollingInbox: false` agent (inboxCatchUp disabled, lab and eval paths)
   * has nothing to be stale about and reports no timestamps.
   */
  inboxLiveness(): {
    agentId: string;
    connected: boolean;
    pollingInbox: boolean;
    lastPassAt: number | null;
    lastAttemptAt: number | null;
  } {
    return {
      agentId: this.options.agentId,
      connected: this.isConnected(),
      pollingInbox: this.inboxLoopEnabled,
      lastPassAt: this.inboxLoop?.lastPassAt ?? null,
      lastAttemptAt: this.inboxLoop?.lastAttemptAt ?? null,
    };
  }
}

/**
 * createAgent(config)            → Agent
 * createAgentPool([cfg, ...])    → ConnectionPool (lazy fleet, async-loaded)
 */
export function createAgent(options: AgentOptions | AgentConfig = {}): Agent {
  return new Agent(options as AgentOptions);
}

export async function createAgentPool(
  configs: AgentOptions[] | AgentConfig[],
): Promise<unknown> {
  const ConnectionPool = await loadConnectionPool();
  const pool = new ConnectionPool();
  (pool as { register: (configs: unknown[]) => void }).register(configs);
  try {
    await (pool as { connectAll: () => Promise<void> }).connectAll();
    return pool;
  } catch (err) {
    await (pool as { shutdown: () => Promise<void> }).shutdown();
    throw err;
  }
}

export default Agent;
