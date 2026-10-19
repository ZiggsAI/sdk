import { getAgreement } from '@ziggs-ai/api-client';
import { permitsAutomaticMandate } from '../runtime/agreementContext.js';
import type { Brain } from './index.js';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Workflow, Ctx } from '../types.js';
import type { ToolManager } from '../tools/ToolManager.js';
import { outcomeFromEvent, type RawEvent } from '../runtime/buildOutcome.js';
import { getBatchEvents } from '../context/batch.js';
import { bootstrapCtx } from '../runtime/bootstrapCtx.js';
import { createDeliveryWriteKeys } from '../runtime/deliveryWriteKeys.js';
import { CLAUDE_SDK_PROTOCOL } from './claudeSdkProtocol.js';
import { hireIdsFromEvent, memorySectionForWake } from '../memory/MemoryStore.js';
import { hostedModelTools, isHostedDeferred } from './hostedToolSurface.js';
import { buildZiggsSdkMcpServer } from './toolManagerToSdkMcp.js';
import type { ClaudeSdkToolContext } from './claudeSdkTools.js';
import {
  claudeQueryOptions,
  buildClaudeEventPrompt,
  summarizeContext,
  extractAssistantText,
} from './claudeCognition.js';
import { assertHostedAgentZiggsTools } from './hostedAgentConnection.js';
import { runtimeLog } from '../shared/runtimeLog.js';
import type { TickInput, TickOutput } from './ZiggsBrain.js';
import {
  resolveOnBehalfAgreementId,
  type OnBehalfAgreementRow,
} from './onBehalfAgreement.js';
import { filterStandingOfferNotices, isReadableAgreementNoticeLane } from './standingOfferNotice.js';
import {
  formedByFromWake,
  shouldSkipAgentFormedHireActivation,
} from './hireActivationNotice.js';
import { isPublishProbeChat } from '../probeChat.js';
import { gateableMessages, wakeAgreementId, type AskWakeGate } from './wakeGate.js';

export { isPublishProbeChat } from '../probeChat.js';

/**
 * status notices must not spend a Claude turn answering
 * nobody. Real work wakes arrive as chat `message`, synthetic `task_result`
 * from `wakeTaskAssignment`, or `agreement_lifecycle` (hire / proposal
 * resolution — the FSM kickoffs on the same event; Claude must act too).
 *
 * Intentionally not mirrored as an FSM "notice skip": the FSM already no-ops
 * enter-only outcomes in AgentMachine; `agreement_lifecycle` never produces
 * `enter`, so hire wakes always step. Claude's filter is narrower — pure
 * `notification` only.
 *
 * Empty / missing batch → notice-only (do not burn a turn on a malformed wake).
 *
 * Who a message is for is not decided here: the backend picks the receiver,
 * and the inbox hands this agent only the rows assigned to it. Whether a
 * message needs a turn at all is the wake gate's question.
 */
export function isNoticeOnlyWake(event: RawEvent | undefined): boolean {
  const events = getBatchEvents(event) as RawEvent[];
  if (events.length === 0) return true;
  return events.every((ev) => ev?.type === 'notification');
}

export type CognitionKind = 'fsm' | 'claude-sdk';

export interface ClaudeBrainOptions {
  workflow: Workflow;
  toolManager: ToolManager;
  /** Store-facing one-liner. Used as the role block only when `systemPrompt` is absent. */
  description: string;
  /** The agent's system prompt. Preferred over `description` for the role block. */
  systemPrompt?: string;
  specialization?: string | null;
  model: string;
  anthropicKey: string;
  operatorKey: string;
  agentId: string;
  maxTurns?: number;
  /** when true, never resume the prior Claude session — each wake is a
   *  fresh transcript. Keeps per-wake input flat on step-driven orchestrators
   *  whose wakes already carry their state. */
  statelessPerWake?: boolean;
  /** Injectable for tests. Defaults to @anthropic-ai/claude-agent-sdk query(). */
  queryFn?: typeof query;
  /** Full authoritative agreement read used to recognize listing bookkeeping. */
  readAgreement?: (agreementId: string) => Promise<unknown>;
  /**
   * Opt in to spending a model turn on an activation notice for a hire
   * this agent's counterparty formed. Default is off — the host records a
   * no-op and waits for the task.
   */
  actsOnHireActivation?: boolean;
  /**
   * Asked before a turn is spent on chat messages; a confident
   * "context" skips the turn. Absent means no gate (the default here; the
   * host wires the backend gate in).
   */
  askWakeGate?: AskWakeGate;
}

const DEFAULT_STATE = 'ready';

/**
 * Per-wake turn cap — a runaway backstop, NOT a budget.
 *
 * Cost is bounded by the priced spend guard below, so this only has to sit above
 * the longest honest job, with room for a retry inside it. A job that gathers
 * before it works — reading the engagement, listing grants, discovering a
 * connection's tools, pulling the data — spends around ten turns before it
 * starts on the work it was hired for, then needs several more to draft, record
 * the artifact and close the task. Set below that, the cap ends wakes with the
 * gathering done and nothing filed.
 */
const DEFAULT_MAX_TURNS = Number(process.env.CLAUDE_SDK_MAX_TURNS ?? 30);

/**
 * Hard ceiling on billable input tokens (incl. cache read/write) a single wake
 * may spend before we abort the query. Defense-in-depth on the host's LLM key
 * against a runaway loop; set high enough that normal tasks never trip it. The
 * task ends unfinished (and logs loudly) rather than burning unbounded. */
const MAX_TASK_INPUT_TOKENS = Number(process.env.CLAUDE_SDK_MAX_INPUT_TOKENS ?? 500_000);

/**
 * Per-lane wake-rate circuit breaker. The per-wake caps above bound one wake;
 * nothing bounds the NUMBER of wakes. An echo path — anything that turns an
 * agent's own write back into a delivery addressed to it — drives one wake per
 * wake, forever. Targeting never routes an agent its own writes, so this is a
 * backstop: a lane waking faster than real traffic plausibly drives it skips the
 * LLM (and logs loudly) instead of draining the key. */
const WAKE_WINDOW_MS = 10 * 60_000;
const MAX_WAKES_PER_WINDOW = Number(process.env.CLAUDE_SDK_MAX_WAKES_PER_WINDOW ?? 40);

/**
 * Resumed-transcript ceiling. Each wake resumes the lane's Claude
 * session, so the whole transcript (event prompts, tool results, summaries)
 * replays on every turn — mostly as cache reads, but it grows without bound on
 * a long-lived lane and dominates per-wake cost. When a wake's billable input
 * crosses this, we drop the session id so the NEXT wake starts fresh. The
 * protocol is backend-authoritative (the brain re-reads via context_snapshot),
 * so the transcript is convenience memory, not the source of truth — safe to
 * discard. Env-overridable. Kept below MAX_TASK_INPUT_TOKENS so a lane resets
 * before it can approach the per-wake abort. */
const MAX_SESSION_RESUME_INPUT_TOKENS = Number(
  process.env.CLAUDE_SDK_MAX_SESSION_INPUT_TOKENS ?? 200_000,
);

/**
 * "the transcript you asked me to resume is not here".
 *
 * Claude Code answers a `resume` of an unknown id with this, and it is the only
 * failure that a fresh session reliably fixes: the id is valid-looking but its
 * transcript lived on a container that is gone. Matched on the message because
 * that is all the CLI gives us — no code, no typed error — so keep it narrow
 * enough that a different failure never claims the retry.
 */
/**
 * "I ran out of turns", as Claude Code reports it.
 *
 * Turn exhaustion is not a crash: the wake did real work and stopped at a cap
 * we set. It arrives as a thrown error result with no code and no type, so the
 * message is all there is to match on — kept narrow so no other failure claims
 * the handling.
 */
export function isMaxTurnsError(err: unknown): boolean {
  const message = (err as { message?: unknown } | null)?.message;
  return (
    typeof message === 'string' &&
    /reached maximum number of turns/i.test(message)
  );
}

export function isMissingSessionError(err: unknown): boolean {
  const message = (err as { message?: unknown } | null)?.message;
  return (
    typeof message === 'string' &&
    /no conversation found with session id/i.test(message)
  );
}

type SdkUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/** Total billable input for one API response (base + cache read + cache write). */
function billableInput(usage: SdkUsage | undefined): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * The same tokens, priced.
 *
 * A cache READ bills at ~0.1x base input and a cache WRITE at ~1.25x. The spend
 * guard below exists to stop a runaway from draining the key, so it has to count
 * what the key is actually charged — and counting a cache read as a full input
 * token makes every multi-turn wake look like a runaway. The transcript replays
 * on every turn, so a 40k context over ten turns reads as 400k of "spend" while
 * costing about a tenth of that: unpriced, the guard fires on ordinary work long
 * before any runaway would, and it fires mid-job — right after the gathering
 * calls and before the deliverable, which is the whole of "the wake ends before
 * it files anything".
 *
 * Weights, not prices: the ratio between the three input kinds is stable across
 * Claude models even as the per-million rates change, so this stays right
 * without tracking a price table.
 */
const CACHE_READ_WEIGHT = 0.1;
const CACHE_WRITE_WEIGHT = 1.25;

function costWeightedInput(usage: SdkUsage | undefined): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) * CACHE_READ_WEIGHT +
    (usage.cache_creation_input_tokens ?? 0) * CACHE_WRITE_WEIGHT
  );
}

/**
 * Per-API-call usage. Only assistant turns carry it — the result message's
 * usage is the CUMULATIVE total of the whole query, so adding it on top of
 * the per-turn sums would double-count the wake.
 */
function usageOf(message: SDKMessage): SdkUsage | undefined {
  if (message.type === 'assistant') {
    return (message as { message?: { usage?: SdkUsage } }).message?.usage;
  }
  return undefined;
}

function extractMetrics(message: SDKMessage): { llmCalls: number; tokens: { total: number; input: number; output: number; cacheRead: number; cacheCreation: number } } | null {
  if (message.type !== 'result') return null;
  const usage = message.usage as SdkUsage | undefined;
  // Billable input includes cache reads/writes — that is what the Anthropic
  // console counts and what the key is charged for. Reporting only the uncached
  // slice understates real usage by more than an order of magnitude.
  const input = billableInput(usage);
  const output = usage?.output_tokens ?? 0;
  // Cache read/write are already folded into `input` above; surfaced separately
  // here for per-tick visibility (metricsTap metadata / dashboards).
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  return {
    llmCalls: message.num_turns ?? 1,
    // `input` is already the full billable input (base + cache); total = input + output.
    tokens: { total: input + output, input, output, cacheRead, cacheCreation },
  };
}

/**
 * A brain driven by the Claude Agent SDK. Same body, same `eff`
 * side channel, same tool surface as `ZiggsBrain` — the ONLY difference is
 * the loop: instead of the FSM + `runTurn`, a wake drives a headless Claude
 * `query()` (see "host is the product; the brain is how it decides").
 */
export class ClaudeBrain implements Brain {
  readonly kind = 'claude' as const;
  workflow: Workflow;
  toolManager: ToolManager;
  private rolePrompt: string;
  private specialization: string | null;
  private model: string;
  private anthropicKey: string;
  private operatorKey: string;
  private agentId: string;
  private maxTurns: number;
  private statelessPerWake: boolean;
  private queryFn: typeof query;
  private readAgreement: (agreementId: string) => Promise<unknown>;
  private actsOnHireActivation: boolean;
  private askWakeGate: AskWakeGate | null;
  /**
   * Per-lane tool context. One agent object serves every room, and a
   * wake's query can still be running when another lane starts. A single
   * `current` field meant B's room/sender/write keys overwrote A's
   * mid-query. Wakes on one lane stay serialized; one server per lane is
   * enough, and getContext closes over that lane's key.
   */
  private toolContextByLane = new Map<string, ClaudeSdkToolContext>();
  private sdkMcpByLane = new Map<
    string,
    ReturnType<typeof buildZiggsSdkMcpServer>
  >();

  constructor(opts: ClaudeBrainOptions) {
    if (!opts.workflow?.states) throw new Error('ClaudeBrain: workflow with states is required');
    if (!opts.toolManager) throw new Error('ClaudeBrain: toolManager is required');
    if (!opts.anthropicKey) throw new Error('ClaudeBrain: anthropicKey is required');
    this.workflow = opts.workflow;
    this.toolManager = opts.toolManager;
    // the prompt and the store blurb are two different strings. Agents
    // written before the split still carry the prompt in `description`, so fall
    // back to it rather than silently dropping their role.
    this.rolePrompt = opts.systemPrompt || opts.description;
    this.specialization = opts.specialization ?? null;
    this.model = opts.model;
    this.anthropicKey = opts.anthropicKey;
    this.operatorKey = opts.operatorKey;
    this.agentId = opts.agentId;
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.statelessPerWake = opts.statelessPerWake ?? false;
    this.queryFn = opts.queryFn ?? query;
    this.readAgreement = opts.readAgreement ?? ((agreementId) => getAgreement(agreementId, {
      operatorKey: this.operatorKey,
      agentId: this.agentId,
    }));
    this.actsOnHireActivation = opts.actsOnHireActivation === true;
    this.askWakeGate = opts.askWakeGate ?? null;
  }

  async tick({ event, ctx, state, identity, eff, memory, signal }: TickInput): Promise<TickOutput> {
    if (!identity?.sessionId) throw new Error('ClaudeBrain.tick: identity.sessionId is required');
    if (!eff) throw new Error('ClaudeBrain.tick: eff is required');

    let rawEvent = event as RawEvent | undefined;
    // Listing triage and missing-mailbox verification share one fresh read.
    const agreementReads = new Map<string, Promise<unknown>>();
    const readAgreement = (agreementId: string): Promise<unknown> => {
      if (!agreementReads.has(agreementId)) {
        agreementReads.set(agreementId, Promise.resolve()
          .then(() => this.readAgreement(agreementId)).catch(() => null));
      }
      return agreementReads.get(agreementId)!;
    };
    const nextCtx: Ctx = bootstrapCtx(identity, ctx);
    nextCtx.lastOutcome = outcomeFromEvent(rawEvent ?? null, identity.agentId);

    if (
      shouldSkipAgentFormedHireActivation({
        event: rawEvent,
        formedBy: formedByFromWake(rawEvent),
        actsOnHireActivation: this.actsOnHireActivation,
      })
    ) {
      const sessionId = identity.sessionId;
      runtimeLog.info(
        'ClaudeBrain',
        `agent-formed hire activation — skipping LLM session=${sessionId} agent=${this.agentId}`,
      );
      return {
        ctx: nextCtx,
        state: state ?? DEFAULT_STATE,
        parked: true,
        stateTimeoutUnhandled: false,
        metrics: { llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } },
        skippedReason: 'agent_formed_hire_activation',
      };
    }

    if (isNoticeOnlyWake(rawEvent)) {
      runtimeLog.info(
        'ClaudeBrain',
        `notice-only wake — skipping LLM session=${identity.sessionId} agent=${this.agentId} ` +
          `type=${rawEvent?.type ?? 'unknown'}`,
      );
      return {
        ctx: nextCtx,
        state: state ?? DEFAULT_STATE,
        parked: true,
        stateTimeoutUnhandled: false,
        metrics: { llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } },
      };
    }

    const listingCheck = await filterStandingOfferNotices(rawEvent, this.agentId, readAgreement);
    if (listingCheck.ignoredAgreementIds.length > 0) {
      rawEvent = listingCheck.event;
      nextCtx.lastOutcome = outcomeFromEvent(rawEvent ?? null, identity.agentId);
      runtimeLog.info('ClaudeBrain',
        `standing listing acceptance — no customer hire agent=${this.agentId} ` +
        `agreements=${listingCheck.ignoredAgreementIds.join(',')}`);
      if (!rawEvent || isNoticeOnlyWake(rawEvent)) {
        return {
          ctx: nextCtx,
          state: state ?? DEFAULT_STATE,
          parked: true,
          stateTimeoutUnhandled: false,
          skippedReason: 'standing_listing_acceptance',
          metrics: { llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } },
        };
      }
    }

    // Before the breaker counts this wake: a skipped turn costs
    // nothing, so it must not bring the breaker closer. Store publish still
    // has to hear a model reply, so its probe chat is never asked.
    const gateMessages = this.askWakeGate && !isPublishProbeChat(identity.sessionId)
      ? gateableMessages(rawEvent)
      : null;
    if (gateMessages && this.askWakeGate) {
      const gate = await this.askWakeGate({
        messages: gateMessages,
        chatId: identity.sessionId,
        ...(wakeAgreementId(rawEvent) ? { agreementId: wakeAgreementId(rawEvent) } : {}),
      });
      if (gate && gate.wake === false) {
        runtimeLog.info(
          'ClaudeBrain',
          `wake gate: context only — skipping LLM session=${identity.sessionId} agent=${this.agentId} ` +
            `messages=${gateMessages.length} confidence=${gate.confidence ?? '?'}`,
        );
        return {
          ctx: nextCtx,
          state: state ?? DEFAULT_STATE,
          parked: true,
          stateTimeoutUnhandled: false,
          skippedReason: 'wake_gate_context',
          metrics: { llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } },
        };
      }
    }

    const now = Date.now();
    const recentDeliveries = (nextCtx.recentDeliveries ?? []).filter((t) => now - t < WAKE_WINDOW_MS);
    // Store publish still has to hear a model reply when leftover mail already
    // tripped the breaker. The prefix only skips the park — it does not write
    // a canned answer.
    if (
      recentDeliveries.length >= MAX_WAKES_PER_WINDOW &&
      !isPublishProbeChat(identity.sessionId)
    ) {
      runtimeLog.warn(
        'ClaudeBrain',
        `wake-rate breaker tripped: ${recentDeliveries.length} wakes in ${WAKE_WINDOW_MS / 60_000}min ` +
          `session=${identity.sessionId} agent=${this.agentId} — skipping LLM for this wake`,
      );
      nextCtx.recentDeliveries = recentDeliveries;
      return {
        ctx: nextCtx,
        state: state ?? DEFAULT_STATE,
        parked: true,
        stateTimeoutUnhandled: false,
        metrics: { llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } },
      };
    }
    nextCtx.recentDeliveries = [...recentDeliveries, now];

    let contextSnap: Record<string, unknown> | null = null;
    try {
      // #5: pre-read is for wake gating + summarizeContext (a count) +
      // onBehalf agreement resolution — same 12-message cap as the tool path.
      // Uncapped pulls burned 35–47k input tokens/wake on long chats.
      contextSnap = await eff({
        kind: 'read-context',
        sessionId: identity.sessionId,
        opts: { maxMessages: 12 },
      }) as Record<string, unknown>;
    } catch (err) {
      runtimeLog.warn('ClaudeBrain', `read-context failed session=${identity.sessionId}: ${(err as Error).message}`);
    }

    // Same guard as the FSM's runTurn: a wake for a chat the backend
    // no longer resolves (deleted / not visible / no grant) has no world to
    // act in — skip the query instead of burning a wake on a fabricated
    // empty history. Resource wakes used to slip past a message-only gate.
    //
    // An agreement notification mailbox need not have a chat row. Its prefix
    // alone is insufficient: verify the event's scope and actual read access.
    if (contextSnap?.chatMissing === true) {
      const sessionId = identity.sessionId;
      const readableMailbox = await isReadableAgreementNoticeLane(sessionId, rawEvent, readAgreement);
      if (readableMailbox) {
        runtimeLog.info(
          'ClaudeBrain',
          `verified agreement mailbox session=${sessionId} agent=${this.agentId}; no chat row needed`,
        );
      }
      if (!readableMailbox) {
        // A room this agent cannot read is no world to act in,
        // including resource wakes that used to burn the model on refusals.
        runtimeLog.warn(
          'ClaudeBrain',
          `chat ${sessionId} not readable — skipping wake agent=${this.agentId}`,
        );
        return {
          ctx: nextCtx,
          state: state ?? DEFAULT_STATE,
          parked: true,
          stateTimeoutUnhandled: false,
          metrics: { llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } },
          skippedReason: `chat_unreadable:${sessionId}`,
        };
      }
    }

    const roleBlock = [
      `## Your role`,
      this.rolePrompt,
      this.specialization ? `Specialization: ${this.specialization}` : '',
    ].filter(Boolean).join('\n');
    // Two blocks, not one string: the shared protocol first so its cache prefix
    // is reachable by every hosted agent, this agent's role second.
    const systemPrompt = [CLAUDE_SDK_PROTOCOL, roleBlock];

    const runId = crypto.randomUUID();
    // Replay-stable write keys for this wake (runId is random and can't serve):
    // a crash-replay of the same event derives the same keys, so the backend
    // drops the duplicate artifacts / no-ops the repeated task transitions.
    const writeKeys = createDeliveryWriteKeys(identity.laneKey, rawEvent);
    const toolContext: ClaudeSdkToolContext = {
      operatorKey: this.operatorKey,
      agentId: this.agentId,
      chatId: identity.sessionId,
      sessionId: identity.sessionId,
      eff,
      senderId: rawEvent?.senderId != null ? String(rawEvent.senderId) : undefined,
      senderType: rawEvent?.senderType != null ? String(rawEvent.senderType) : undefined,
      ///832: agreement this wake acts under → lets a delegated per-user
      // MCP call resolve the originating end-user (payer) rather than the
      // delegating agent (senderId). Resolved from every reliable wire source,
      // not just task_result events — see resolveOnBehalfAgreementId.
      // Skip payer-only subs named on the worker result; bind to the
      // provider hire (see onBehalfAgreement.ts).
      allowAutomaticMandate: permitsAutomaticMandate(rawEvent),
      onBehalfOfAgreementId: resolveOnBehalfAgreementId(
        rawEvent,
        Array.isArray(contextSnap?.agreements)
          ? (contextSnap!.agreements as OnBehalfAgreementRow[])
          : null,
        this.agentId,
        identity.sessionId,
      ),
      runId,
      writeKeys,
      // Hire-partitioned store. The host already scoped this wake;
      // Claude tools that persist notes must use this, not a process-wide bag.
      memory,
    };
    const lane = identity.laneKey;
    this.toolContextByLane.set(lane, toolContext);

    let sdkMcpServer = this.sdkMcpByLane.get(lane);
    if (!sdkMcpServer) {
      const availableTools = await this.toolManager.getAvailableTools();
      const mounted = hostedModelTools(availableTools);
      sdkMcpServer = buildZiggsSdkMcpServer(
        mounted,
        () => {
          const ctx = this.toolContextByLane.get(lane);
          if (!ctx) {
            throw new Error(
              `ClaudeBrain: tool context missing for lane ${lane}`,
            );
          }
          return ctx;
        },
        {
          name: 'ziggs',
          instructions:
            'In-process Ziggs tools. Everyday tools and your own tools are loaded; every other Ziggs tool loads when you search for it.',
          alwaysLoad: (name) => !isHostedDeferred(name),
        },
      );
      this.sdkMcpByLane.set(lane, sdkMcpServer);
    }

    const prompt = buildClaudeEventPrompt(rawEvent, summarizeContext(contextSnap));
    const mcpServers = { ziggs: sdkMcpServer };
    assertHostedAgentZiggsTools(mcpServers);
    const queryOptions = claudeQueryOptions({
      systemPrompt,
      model: this.model,
      mcpServers,
      maxTurns: this.maxTurns,
      apiKey: this.anthropicKey,
      stderr: (data: string) => {
        const line = data.trim();
        if (line) runtimeLog.warn('ClaudeBrain', `stderr session=${identity.sessionId}: ${line}`);
      },
    });

    const workIds = hireIdsFromEvent(rawEvent);
    const selectedWork = contextSnap?.work as { agreementId?: string; task?: { taskId?: string }; contexts?: Array<{ agreementId?: string; task?: { taskId?: string } }> } | undefined;
    const workScope = JSON.stringify([
      selectedWork?.contexts?.map(p => [p.agreementId, p.task?.taskId]) ?? [selectedWork?.agreementId, selectedWork?.task?.taskId],
      memorySectionForWake({
        sessionId: identity.sessionId,
        wakeAgreementIds: workIds,
        activeAgreementId: workIds.length ? undefined : nextCtx.activeAgreementId,
      }),
      (contextSnap?.workBrief as { audience?: unknown } | undefined)?.audience ??
      (contextSnap?.work as { contexts?: Array<{ workBrief?: { audience?: unknown } }> } | undefined)?.contexts?.map(p => p.workBrief?.audience ?? null) ?? {
        users: contextSnap?.users ?? [], agents: contextSnap?.agents ?? [],
      },
    ]);
    if (nextCtx.claudeWorkScope !== workScope) nextCtx.claudeSessionId = undefined;
    nextCtx.claudeWorkScope = workScope;
    let metrics = { llmCalls: 0, tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } };
    let sessionId = nextCtx.claudeSessionId;
    // Cost-weighted, cumulative: what this wake has charged the key so far.
    let spentInput = 0;
    // The transcript's SIZE, which is a different question from spend and needs
    // a different measure: the largest single turn's input, unweighted. On the
    // cumulative sum a lane with a modest transcript crosses the resume ceiling
    // simply by taking enough turns, and forgets its session after every wake —
    // so each wake re-gathers from zero and stalls at the same step.
    let peakTurnInput = 0;
    // Why the wake stopped, when it stopped on a guard rather than on its own.
    let abortedBy: 'input-budget' | 'max-turns' | null = null;

    // stateless-per-wake never resumes — each wake is a fresh
    // transcript, so per-wake input stays flat instead of replaying the whole
    // lane history every turn.
    const resumeId = this.statelessPerWake ? undefined : nextCtx.claudeSessionId;

    const consumeQuery = async (resume: string | undefined): Promise<void> => {
    // Host watchdog abort (see TickInput.signal): stop consuming AND interrupt
    // the query, so a timed-out wake never lingers as a token-burning zombie
    // racing its own redelivered retry. Breaking the for-await returns the
    // generator; interrupt() additionally stops a query blocked mid-turn.
    const query = this.queryFn({ prompt, options: { ...queryOptions, resume } });
    const onAbort = () => {
      void (query as { interrupt?: () => Promise<void> }).interrupt?.()?.catch(() => {});
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for await (const message of query) {
        if (signal?.aborted) {
          runtimeLog.warn(
            'ClaudeBrain',
            `host watchdog aborted wake session=${identity.sessionId} agent=${this.agentId} — stopping query`,
          );
          break;
        }
        if ('session_id' in message && typeof message.session_id === 'string') {
          sessionId = message.session_id;
        }

        // Surface the model's own prose so a hired Claude agent is as legible as
        // an FSM agent. Each completed assistant turn's text is recorded
        // as a `thought` — the SAME agent-private channel the FSM uses for its
        // reasoning (runTurn `emitThought` → record-event → recordThought), so it
        // shows in the hired-agent view without cluttering the counterparty chat.
        // Pure tool-use turns carry no text and record nothing.
        //
        // Fire-and-forget on purpose: this runs inside `for await (query())`, so
        // awaiting an artifacts round-trip per turn would couple model-stream
        // consumption to the artifacts backend — a slow/wedged backend would stall
        // the whole wake, not just fail a breadcrumb. Recording is best-effort and
        // thought ordering is not load-bearing, so we let it run in the background
        // and swallow failures with a warn.
        if (message.type === 'assistant') {
          const text = extractAssistantText(message).trim();
          if (text) {
            // Ordinal drawn synchronously so the fire-and-forget below can't
            // reorder key assignment against other writes of this wake.
            const idempotencyKey = writeKeys.artifactKey({ kind: 'thought', text });
            void eff({ kind: 'record-event', sessionId: identity.sessionId, entry: { kind: 'thought', text }, idempotencyKey })
              .catch((err) => runtimeLog.warn(
                'ClaudeBrain',
                `record thought failed session=${identity.sessionId}: ${(err as Error).message}`,
              ));
          }
        }

        const m = extractMetrics(message);
        if (m) metrics = m;
        if (message.type === 'result' && message.subtype !== 'success') {
          runtimeLog.warn(
            'ClaudeBrain',
            `query ended without success subtype=${message.subtype} session=${identity.sessionId}`,
          );
        }
        // Runaway guard: abort before an unbounded loop drains the
        // key. Breaking the for-await calls the generator's return(),
        // which terminates the underlying query.
        const turnUsage = usageOf(message);
        spentInput += costWeightedInput(turnUsage);
        peakTurnInput = Math.max(peakTurnInput, billableInput(turnUsage));
        // A wake that produced no per-turn usage still reports a cumulative
        // total on the result message. Divided by the turns it covers, that is
        // the average context per turn — a coarser read of the same transcript,
        // used only when the precise one is unavailable.
        if (message.type === 'result') {
          const turns = Math.max(1, (message as { num_turns?: number }).num_turns ?? 1);
          peakTurnInput = Math.max(
            peakTurnInput,
            billableInput(message.usage as SdkUsage | undefined) / turns,
          );
        }
        if (spentInput > MAX_TASK_INPUT_TOKENS) {
          abortedBy = 'input-budget';
          runtimeLog.warn(
            'ClaudeBrain',
            `input-token budget exceeded (~${Math.round(spentInput)} cost-weighted > ${MAX_TASK_INPUT_TOKENS}) session=${identity.sessionId} agent=${this.agentId} — aborting query to cap spend`,
          );
          break;
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    };

    /**
     * Say, on the agent's own reasoning channel, that this wake stopped before
     * it finished. Without the note a wake cut off by a guard is
     * indistinguishable from one that delivered: the task stays `active` with
     * `processing: false`, no artifact, no result, and nothing anywhere says
     * why. The lane's history carries the reason instead, so a wedged-task
     * detector has something to read.
     */
    /**
     * Close the task this wake was woken for, when a guard stopped the wake
     * before the agent could close it itself.
     *
     * The note above records the reason where a detector could read it. Nothing
     * reads it, and the hirer reads none of it: the task stays `active` with no
     * result, the wake returns parked like any other, its inbox item is acked,
     * and the engagement looks alive forever. Measured on production — a
     * connector agent whose tool schema costs ~20-45k input per wake spent the
     * session budget across four wakes on one lane and its task sat untouched
     * for as long as anyone cared to watch. The buyer had a greeting, a hire,
     * and silence.
     *
     * So the guard now says the same thing the prompt tells every agent to say
     * when it cannot do the work: fail the task, with the reason, because a
     * visible failure the counterparty can re-route beats a silent drop.
     * Best-effort — a wake already cut short must not throw on the way out.
     */
    const failTaskCutShort = async (reason: string): Promise<void> => {
      const taskId = nextCtx.activeTaskId;
      if (!taskId) return;
      await eff({
        kind: 'tool-call',
        sessionId: identity.sessionId,
        name: 'task_set_result',
        args: {
          taskId,
          state: 'failed',
          result: {
            summary: `Stopped before finishing: ${reason}. Nothing was filed for this task.`,
            status: 'failed',
          },
        },
      }).catch((err) =>
        runtimeLog.warn(
          'ClaudeBrain',
          `could not fail task ${taskId} after a cut-short wake ` +
            `session=${identity.sessionId}: ${(err as Error).message}`,
        ),
      );
      runtimeLog.warn(
        'ClaudeBrain',
        `failed task ${taskId} because the wake was cut short session=${identity.sessionId} agent=${this.agentId}`,
      );
    };

    const noteWakeCutShort = async (reason: string): Promise<void> => {
      const text =
        `Wake stopped early: ${reason}. Work in progress was NOT filed — no ` +
        `artifact was recorded and no task was closed by this wake.`;
      await eff({
        kind: 'record-event',
        sessionId: identity.sessionId,
        entry: { kind: 'thought', text },
        idempotencyKey: writeKeys.artifactKey({ kind: 'thought', text }),
      }).catch((err) =>
        runtimeLog.warn(
          'ClaudeBrain',
          `record abort note failed session=${identity.sessionId}: ${(err as Error).message}`,
        ),
      );
    };

    try {
      await consumeQuery(resumeId);
    } catch (err) {
      if (signal?.aborted && signal.reason?.code === 'TASK_CONTROL') {
        nextCtx.claudeSessionId = this.statelessPerWake ? undefined : sessionId;
        return { ctx: nextCtx, state: state ?? DEFAULT_STATE, parked: true, stateTimeoutUnhandled: false, metrics };
      }
      // Turn exhaustion arrives as a thrown error result, not a break, so it
      // needs its own note before the throw propagates.
      if (isMaxTurnsError(err)) {
        abortedBy = 'max-turns';
        // Same reasoning as the spend guard below: a cap that stops the work
        // has to close the work, or the hirer is left watching an active task
        // nobody is on.
        const reason = `the turn cap (${this.maxTurns}) was reached`;
        await noteWakeCutShort(reason);
        await failTaskCutShort(reason);
      }
      // the resumed transcript is gone. Claude Code stores transcripts
      // on the container's own disk while the session id outlives it — persisted
      // per lane in the session store with a 24h TTL — so a redeployed agents
      // task inherits an id pointing at a file that no longer exists. Every wake
      // on that lane then failed identically for as long as the TTL held, and the
      // human saw one "Something went wrong. Please try again." per attempt.
      //
      // Retrying here is safe precisely because this failure happens BEFORE any
      // turn runs: nothing was emitted, no tool ran, no idempotency ordinal was
      // spent. That is why the retry is scoped to this one error and to one
      // attempt — a mid-wake failure must keep propagating, since its partial
      // writes are already out.
      if (!isMissingSessionError(err) || !resumeId) {
        runtimeLog.warn('ClaudeBrain', `query failed session=${identity.sessionId}: ${(err as Error).message}`);
        throw err;
      }
      runtimeLog.info(
        'ClaudeBrain',
        `resumed Claude session ${resumeId} no longer exists (container replaced?) ` +
          `session=${identity.sessionId} agent=${this.agentId} — retrying once on a fresh session`,
      );
      nextCtx.claudeSessionId = undefined;
      sessionId = undefined;
      // The first attempt failed before any turn ran, so it spent nothing and
      // left no transcript. Carrying its counters into the retry would halve the
      // budget the real attempt gets to work with.
      spentInput = 0;
      peakTurnInput = 0;
      abortedBy = null;
      try {
        await consumeQuery(undefined);
      } catch (retryErr) {
        runtimeLog.warn('ClaudeBrain', `query failed session=${identity.sessionId}: ${(retryErr as Error).message}`);
        throw retryErr;
      }
    }

    // Stateless-per-wake keeps no session id — clear any carried over from the
    // prior ctx so the next wake starts fresh too. Otherwise remember
    // this wake's session for resume.
    if (this.statelessPerWake) nextCtx.claudeSessionId = undefined;
    else if (sessionId) nextCtx.claudeSessionId = sessionId;

    // bound resumed-transcript growth. Past the ceiling, forget the session so
    // the next wake starts fresh rather than paying an ever-larger replay.
    //
    // Measured as the largest SINGLE turn's input — that is the transcript,
    // since every turn re-reads the whole thing. Summing the wake's turns
    // instead measures how much WORK a wake did, not how much it carries: a lane
    // whose transcript never leaves ~40k crosses the ceiling on turn five and
    // drops its session on every wake. Resuming then never happens, so each wake
    // re-reads the world from scratch and runs out of budget at the same step,
    // and a standing job cannot advance.
    if (nextCtx.claudeSessionId && peakTurnInput > MAX_SESSION_RESUME_INPUT_TOKENS) {
      runtimeLog.info(
        'ClaudeBrain',
        `resetting Claude session (transcript ~${peakTurnInput} > ${MAX_SESSION_RESUME_INPUT_TOKENS}) ` +
          `session=${identity.sessionId} agent=${this.agentId} — next wake starts fresh`,
      );
      nextCtx.claudeSessionId = undefined;
    }

    if (abortedBy === 'input-budget') {
      const reason =
        `the per-wake spend guard cut this run off (~${Math.round(spentInput)} ` +
        `cost-weighted input tokens > ${MAX_TASK_INPUT_TOKENS})`;
      await noteWakeCutShort(reason);
      await failTaskCutShort(reason);
    }

    return {
      ctx: nextCtx,
      state: state ?? DEFAULT_STATE,
      parked: true,
      stateTimeoutUnhandled: false,
      metrics,
    };
  }
}
