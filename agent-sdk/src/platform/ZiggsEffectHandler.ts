import { MessageRecordsClient } from '@ziggs-ai/api-client';
import type { MessageCommand, MessageCommandResult, MessageRecord } from '@ziggs-ai/contracts';
/**
 * Ziggs-flavored EffectHandler.
 *
 * Translates the brain's Effect requests into concrete backend calls:
 * reads go through the grant-fenced ContextReadClient snapshot, writes through
 * artifactsClient / taskService / agreementService / messageSender, and LLM
 * turns through the adapter. This is the only place where brain intent meets
 * backend reality.
 *
 * Belongs to the SDK body. The operator runner owns process startup and
 * health serving; it does not perform the brain’s effects.
 */
import type {
  Effect, EffectHandler,
  ContextSnapshot, HistoryEntry, LlmMessage, LlmResponse, LlmToolSchema, ToolCallResult,
} from '../types.js';
import { OutboxBuffer } from './OutboxBuffer.js';
import { currentLaneKey } from './laneKey.js';
import { runtimeLog } from '../shared/runtimeLog.js';
import { resolveBackendUrl } from '../shared/backendUrl.js';
import { toolFailureText } from '../brain/toolFailureText.js';
import { ExecutionRefusal, executionControllers } from '../runtime/executionController.js';
import { assertRequiredContext } from '../runtime/requiredContext.js';
import type { WakeSchedulerPort } from './tools/tier1/wakeTools.js';
/** Minimal LLM adapter contract — OpenAIAdapter satisfies this. */
interface LlmAdapter {
  chatMessages(messages: LlmMessage[], tools?: LlmToolSchema[], options?: Record<string, unknown>): Promise<LlmResponse>;
  chatMessagesStream?(messages: LlmMessage[], onChunk: (text: string) => void): Promise<{ text: string; usage?: LlmResponse['usage'] }>;
}
import type { TaskService } from './tasks/TaskService.js';
import type { AgreementService } from './agreements/AgreementService.js';
import type { ToolManager } from '../tools/ToolManager.js';
import type {
  ArtifactsClient,
  ContextReadClient,
  TelemetryClient,
} from '@ziggs-ai/api-client';
import { artifactScope } from '@ziggs-ai/api-client';
import {
  buildLlmIngestPayload,
  buildToolIngestPayload,
  isTelemetryIngestEnabled,
  sendTelemetry,
} from './telemetryIngest.js';

export interface ZiggsEffectDeps {
  /**
   * LLM adapter for `llm-call` / `stream-text`. Optional: the Claude brain
   * drives its own model via `query()` and emits neither effect, so it wires
   * no adapter. Those two cases throw if reached without one.
   */
  llm?: LlmAdapter;
  artifactsClient: ArtifactsClient;
  /** Grant-fenced aggregate read backbone — sources the read-context snapshot. */
  contextReadClient: ContextReadClient;
  taskService: TaskService;
  agreementService: AgreementService;
  messageSender: (command: MessageCommand) => Promise<MessageCommandResult>;
  /**
   * The explicit conversation and work selected for this wake. A processing
   * lane alone cannot select a destination; task-first and restored wakes
   * use their execution context without waiting for a message.
   */
  conversationFor?: (sessionId: string) => { agreementId?: string; taskId?: string; message?: { messageId: string; senderId?: string } } | undefined;
  /** Sends a streaming chunk to a client. Called per-token during stream-text effects. */
  chunkSender?: (sessionId: string, receiverId: string, text: string, messageId: string) => void;
  toolManager: ToolManager;
  operatorKey: string;
  agentId: string;
  telemetryClient?: TelemetryClient;
  /** When false, skips POST /agents/monitoring/ingest (default: env on). */
  telemetryIngest?: boolean;
  effectTap?: (effect: Effect, response: unknown) => void;
  /**
   * How `wake_at` arms the lane's timer. Optional: an effect
   * handler built outside Agent (tests, embedders) has no timer to arm, and
   * `wake_at` says so plainly rather than pretending to have scheduled one.
   */
  wakeScheduler?: WakeSchedulerPort;
}

const CONTEXT_CACHE_MAX = 256;

/** Said in place of a read when nothing selects one. Not a failure: the wake can still act on explicit resources. */
const NO_CONTEXT = 'This wake selects no message, artifact or work. Name an exact message, artifact, task or agreement before reading context.';

/** Required work context and optional messaging inputs share the same access
 * checks, but are fetched independently. */
const emptySnapshot = (agentId: string): ContextSnapshot => ({
  history: [],
  agreements: [],
  users: [],
  agents: [{ agentId, role: 'self', isYou: true, kind: 'agent' }],
  latestSequence: null,
});

async function buildSnapshot(
  deps: ZiggsEffectDeps,
  agentId: string,
  opts: { via?: string; limit?: number; workScope?: { agreementId?: string; taskId?: string; messageId?: string; artifactId?: string }; includeHistory?: boolean } = {},
): Promise<ContextSnapshot> {
  const scope = opts.workScope;
  const via = opts.via ?? (scope?.taskId ? `task:${scope.taskId}` : scope?.agreementId ? `agreement:${scope.agreementId}` : scope?.messageId ? `message:${scope.messageId}` : scope?.artifactId ? `artifact:${scope.artifactId}` : undefined);
  try {
    if (!via) throw new Error('Context requires an explicit message, artifact, task or agreement');
    const agreementId = scope?.agreementId ?? (via.startsWith('agreement:') ? via.slice('agreement:'.length) : undefined);
    const messageId = scope?.messageId ?? (via.startsWith('message:') ? via.slice('message:'.length) : undefined);
    // Select the work independently of its triggering message. A message is
    // the snapshot entry only when it is the selected resource itself.
    const snap = await deps.contextReadClient.snapshot({
      via, maxMessages: opts.includeHistory === false && via.startsWith('message:') ? 1 : opts.limit,
      ...(agreementId ? { agreementId } : {}),
      ...(scope?.artifactId ? { artifactId: scope.artifactId } : {}),
    });
    assertRequiredContext(snap);
    const messages = new MessageRecordsClient(deps.operatorKey, agentId, resolveBackendUrl());
    const trigger = messageId ? await messages.get(messageId) : undefined;
    if (trigger && agreementId && trigger.mandate?.agreementId !== agreementId)
      throw Object.assign(new Error('Trigger belongs to different work'), { status: 403 });
    if (trigger && opts.workScope?.taskId && trigger.mandate?.taskId !== opts.workScope.taskId)
      throw Object.assign(new Error('Trigger belongs to different task work'), { status: 403 });
    const present = (m: MessageRecord): HistoryEntry => ({ messageId: m.messageId, text: m.content.text, entryType: 'message', timestamp: Date.parse(m.timestamp), sender: { id: m.sender.isSelf ? agentId : m.sender.ref, type: m.sender.kind }, receiver: { id: m.recipients[0]?.ref } });
    const required = trigger ? [present(trigger)] : [];
    const context = { ...snap, messageRecord: trigger, messageMandate: agreementId ? { agreementId, ...(opts.workScope?.taskId ? { taskId: opts.workScope.taskId } : {}) } : trigger?.mandate ?? undefined };
    if (trigger && opts.includeHistory !== false) {
      try {
        // An ordinary follow-up needs the preceding conversation, even when it
        // does not explicitly quote a message. The server matches the exact
        // stored audience and mandate and authorizes every history record.
        // Keep selected work separate: context never selects execution authority.
        const conversation = via === `message:${trigger.messageId}`
          ? snap
          : await deps.contextReadClient.snapshot({ via: `message:${trigger.messageId}`, maxMessages: opts.limit ?? 12 });
        assertRequiredContext(conversation);
        const history = new Map((conversation.history as MessageRecord[]).map(m => [m.messageId, present(m)]));
        history.set(trigger.messageId, present(trigger));
        return { ...context, history: [...history.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp)) };
      } catch (error) {
        const refusal = error as { status?: number; code?: string };
        if (refusal.status === 401 || refusal.code?.startsWith('EXECUTION_')) throw error;
        return { ...context, history: required, historyUnavailable: true };
      }
    }
    if (trigger || agreementId) {
      if (opts.includeHistory === true) {
        try {
          const page = await messages.list({ agreementId, taskId: opts.workScope?.taskId, limit: Math.min(opts.limit ?? 12, 30) });
          const history = page.messages.map(present);
          if (trigger && !page.messages.some(m => m.messageId === trigger.messageId)) history.unshift(present(trigger));
          return { ...context, history };
        } catch (error) {
          const refusal = error as { status?: number; code?: string };
          if (refusal.status === 401 || refusal.code?.startsWith('EXECUTION_')) throw error;
          return { ...context, history: required, historyUnavailable: true };
        }
      }
      return { ...context, history: required };
    }
    return { ...snap, history: (snap.history as MessageRecord[]).map(present) };

  } catch (err: unknown) {
    // A refused/missing exact resource is required context failure.
    const status = (err as { status?: number })?.status;
    // 403 = exists but this agent has no grant. Same as deleted:
    // no world to act in. Leaving it as an empty snapshot used to run a
    // full turn against refusals.
    if (status === 404 || status === 403) {
      return { ...emptySnapshot(agentId), unavailable: true, refused: true, refusedVia: via, work: { minimumComplete: false, authorization: { active: false }, instruction: 'Required context is unavailable. Do not start work without verified scope and access.' } };
    }
    runtimeLog.warn(
      'ZiggsEffectHandler',
      `snapshot fetch failed: ${(err as Error)?.message ?? err}`,
    );
    return { ...emptySnapshot(agentId), unavailable: true, work: { minimumComplete: false, authorization: { active: false }, instruction: 'Context read failed. Retry or request access before acting; an empty packet is not permission.' } };
  }
}

const OP_ARTIFACT_MAX_CHARS = 900;

function clipForOperationArtifact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > OP_ARTIFACT_MAX_CHARS ? `${value.slice(0, OP_ARTIFACT_MAX_CHARS - 1)}…` : value;
  }
  try {
    const s = JSON.stringify(value);
    if (s.length <= OP_ARTIFACT_MAX_CHARS) return value;
    return `${s.slice(0, OP_ARTIFACT_MAX_CHARS - 1)}…`;
  } catch {
    return String(value).slice(0, OP_ARTIFACT_MAX_CHARS);
  }
}

function previewToolArgs(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = Object.keys(args);
  if (keys.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < keys.length && i < 16; i++) {
    const k = keys[i];
    out[k] = clipForOperationArtifact(args[k]);
  }
  return out;
}

/**
 * Chat timeline: `Message.tsx` parses `entryType: artifact`, `contentType: operation` with
 * `operation_*:{json}` where json includes `state` and `tool`.
 */
async function emitToolOperationArtifact(
  client: ArtifactsClient,
  phase: 'started' | 'completed' | 'error',
  payload: Record<string, unknown>,
  idempotencyKey?: string,
  serviceAgreementId?: string,
  taskId?: string,
): Promise<void> {
  // Operation history belongs to selected work.
  // An unbound processing lane must not accumulate shared private context.
  if (!serviceAgreementId && !taskId) return;
  const prefix =
    phase === 'started' ? 'operation_started' : phase === 'completed' ? 'operation_completed' : 'operation_error';
  const text = `${prefix}:${JSON.stringify(payload)}`;
  try {
    await client.write({
      // The wake's own work. A processing lane is a routing key, never a
      // destination: a breadcrumb without work is refused here.
      ...artifactScope({ agreementId: serviceAgreementId }),
      text,
      contentType: 'operation',
      visibility: 'agent-private',
      serviceAgreementId,
      ...(taskId ? { taskId } : {}),
      idempotencyKey,
    });
  } catch (e: unknown) {
    runtimeLog.warn(
      'ZiggsEffectHandler',
      `tool operation artifact (${phase}): ${(e as Error)?.message ?? String(e)}`,
    );
  }
}

/**
 * The single tool-execution path for BOTH cognitions.
 *
 * Executing a tool is more than calling its handler: it emits the operation
 * timeline artifacts (started / completed / error) and tool telemetry, and
 * resolves the invoking user + roster. The FSM reaches this via
 * `eff({ kind: 'tool-call' })` inside `runTurn`; the Claude Agent SDK bridge
 * (`toolManagerToSdkMcp`) emits the SAME effect — so a hosted Claude-brain
 * agent's tool activity is as observable as an FSM agent's (needed for
 * hired-agent visibility). A caller cannot run a tool and skip these
 * side effects — that is the whole point of funneling both paths here.
 *
 * `eff` is threaded into the tool context so eff-backed tools
 * (`context_snapshot`, `message_send`) resolve through this same path
 * regardless of which cognition invoked them.
 */
export async function executeToolWithSideEffects(
  deps: Pick<
    ZiggsEffectDeps,
    | 'toolManager'
    | 'artifactsClient'
    | 'telemetryClient'
    | 'telemetryIngest'
    | 'operatorKey'
    | 'agentId'
    | 'taskService'
    | 'agreementService'
    | 'contextReadClient'
    | 'messageSender'
    | 'wakeScheduler'
    | 'conversationFor'
  >,
  eff: EffectHandler,
  effect: Extract<Effect, { kind: 'tool-call' }>,
  roster: { agents: unknown[]; users: unknown[]; agreements?: unknown[] },
): Promise<ToolCallResult> {
  const toolT0 = Date.now();
  let args = (effect.args as Record<string, unknown>) || {};
  const controller = executionControllers.getStore();
  let binding: { agreementId: string; taskId: string } | undefined;
  let argsPreview: Record<string, unknown> | undefined;
  // #6 — breadcrumbs are best-effort. Awaiting them bracketed every
  // tool call; a slow/wedged artifacts backend stalled the whole wake. Match
  // ClaudeBrain thought writes (fire-and-forget).
  try {
    if (controller) {
      const checked = await controller.beforeTool(deps.toolManager.getTool(effect.name), args);
      args = checked.args;
      binding = checked.binding;
    } else if ('taskId' in args && deps.toolManager.getTool(effect.name)?.workTaskParam) {
      // The host added this parameter for the controller; a handler never sees it.
      args = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'taskId'));
    }
    argsPreview = previewToolArgs(args);
    void emitToolOperationArtifact(deps.artifactsClient, 'started', {
      state: 'started',
      tool: effect.name,
      ...(argsPreview ? { args: argsPreview } : {}),
    }, effect.writeKeys?.artifactKey({ s: 'started', t: effect.name, a: argsPreview }), binding?.agreementId ?? effect.serviceAgreementId, binding?.taskId);
    const lastUser = (roster.users as Array<{ userId?: string; id?: string }>).find(
      (u) => u.userId || u.id,
    );
    // Accumulate token usage from any nested LLM call the tool makes (llmTool),
    // so it can be folded into the turn's authoritative token count.
    let nestedUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    const reportUsage = (u: LlmResponse['usage']): void => {
      if (!u) return;
      const p = u.prompt_tokens ?? u.promptTokens ?? 0;
      const c = u.completion_tokens ?? u.completionTokens ?? 0;
      const t = u.total_tokens ?? u.totalTokens ?? p + c;
      nestedUsage = {
        prompt_tokens: (nestedUsage?.prompt_tokens ?? 0) + p,
        completion_tokens: (nestedUsage?.completion_tokens ?? 0) + c,
        total_tokens: (nestedUsage?.total_tokens ?? 0) + t,
      };
    };
    const result = await deps.toolManager.executeTool(effect.name, args, {
      operatorKey: deps.operatorKey,
      agentId: deps.agentId,
      sessionId: effect.sessionId,
      taskService: deps.taskService,
      agreementService: deps.agreementService,
      contextReadClient: deps.contextReadClient,
      sendMessage: deps.messageSender,
      eff,
      agents: roster.agents,
      users: roster.users,
      // #8 — session snapshot already has agreements; protocolRunner
      // used to re-fetch them over HTTP on every spawn/subcontract.
      agreements: roster.agreements ?? [],
      senderId: effect.senderId ?? lastUser?.userId ?? lastUser?.id,
      senderType: effect.senderType ?? (lastUser ? 'USER' : undefined),
      onBehalfOfAgreementId: binding?.agreementId ?? effect.onBehalfOfAgreementId,
      serviceAgreementId: binding?.agreementId ?? effect.serviceAgreementId,
      ...(binding ? { executionTaskId: binding.taskId, wakeAgreementId: binding.agreementId } : {}),
      memory: effect.memory,
      writeKeys: effect.writeKeys,
      // The wake's checkout, when the host opened one.
      ...(effect.checkout ? { checkout: effect.checkout } : {}),
      // `wake_at` reads this off the tool context.
      wakeScheduler: deps.wakeScheduler,
      reportUsage,
      turnScratch: {},
    });
    controller?.observeTool(effect.name.replace(/^(functions|tools|function|tool)\./, ''), result);
    // One clip per tool call: this is a full JSON.stringify of the untruncated
    // result, and the artifact body and the idempotency key want the same string.
    const clipped = clipForOperationArtifact(result);
    void emitToolOperationArtifact(deps.artifactsClient, 'completed', {
      state: 'completed',
      tool: effect.name,
      result: clipped,
    }, effect.writeKeys?.artifactKey({ s: 'completed', t: effect.name, r: clipped }), binding?.agreementId ?? effect.serviceAgreementId, binding?.taskId);
    sendTelemetry(
      deps.telemetryClient,
      buildToolIngestPayload({
        sessionId: effect.sessionId,
        tool: effect.name,
        durationMs: Date.now() - toolT0,
        ok: true,
        runId: effect.runId,
        stateId: effect.stateId,
      }),
      isTelemetryIngestEnabled(deps.telemetryIngest),
    );
    return { ok: true, result, ...(binding ? { execution: binding } : {}), ...(nestedUsage ? { usage: nestedUsage } : {}) } satisfies ToolCallResult;
  } catch (error: unknown) {
    const errMsg = toolFailureText(error);
    runtimeLog.warn('ZiggsEffectHandler', `tool-call "${effect.name}" failed: ${errMsg}`);
    void emitToolOperationArtifact(deps.artifactsClient, 'error', {
      state: 'failed',
      tool: effect.name,
      error: errMsg,
    }, effect.writeKeys?.artifactKey({ s: 'failed', t: effect.name, e: errMsg }), binding?.agreementId ?? effect.serviceAgreementId, binding?.taskId);
    sendTelemetry(
      deps.telemetryClient,
      buildToolIngestPayload({
        sessionId: effect.sessionId,
        tool: effect.name,
        durationMs: Date.now() - toolT0,
        ok: false,
        runId: effect.runId,
        stateId: effect.stateId,
      }),
      isTelemetryIngestEnabled(deps.telemetryIngest),
    );
    return { ok: false, error: errMsg, ...(error instanceof ExecutionRefusal ? { errorCode: error.code } : {}) } satisfies ToolCallResult;
  }
}

/**
 * Build a single shared EffectHandler. The handler is stateful — it caches
 * the latest ContextSnapshot per sessionId so tool-call effects can resolve
 * session-coupled deps (the `agents` roster) without forcing the Agent to
 * pass them through. Cache is bounded with simple LRU eviction (re-set on
 * read promotes the entry; oldest entry drops when size exceeds the cap).
 *
 * Inside a running wake the cache and the outbox are kept per lane as well:
 * two lanes can share a session id (two threads under one agreement, read by
 * different people) and run at the same time, and one must never see the
 * other's roster or unsynced sends.
 */
export function createZiggsEffectHandler(deps: ZiggsEffectDeps): EffectHandler {
  const contextCache = new Map<string, ContextSnapshot>();
  const outbox = new OutboxBuffer();
  const scoped = (sessionId: string): string => {
    const lane = currentLaneKey();
    return lane ? `${lane}\n${sessionId}` : sessionId;
  };

  const cachePut = (sessionId: string, snap: ContextSnapshot): void => {
    const key = scoped(sessionId);
    if (contextCache.has(key)) contextCache.delete(key);
    contextCache.set(key, snap);
    if (contextCache.size > CONTEXT_CACHE_MAX) {
      const oldest = contextCache.keys().next().value;
      if (oldest !== undefined) contextCache.delete(oldest);
    }
  };
  const cacheGet = (sessionId: string): ContextSnapshot | undefined => {
    const key = scoped(sessionId);
    const snap = contextCache.get(key);
    if (snap !== undefined) {
      contextCache.delete(key);
      contextCache.set(key, snap);
    }
    return snap;
  };

  const dispatch = async (effect: Effect): Promise<unknown> => {
    switch (effect.kind) {
      case 'read-context': {
        // Grant-fenced aggregate read: the backend composes the ContextSnapshot
        // (GET /context/snapshot) through the same access + temporal fence as
        // the per-type reads. Every producer — ClaudeBrain.tick, runTurn,
        // and the on-demand context_snapshot tool — routes through here.
        const scopes = effect.opts?.workScopes ?? [];
        const destination = deps.conversationFor?.(effect.sessionId);
        const defaultScope = destination ? { agreementId: destination.agreementId, taskId: destination.taskId, messageId: destination.message?.messageId } : undefined;
        const selects = (scope: typeof defaultScope) => !!(effect.opts?.via || scope?.agreementId || scope?.taskId || scope?.messageId);
        if (!scopes.length && !selects(defaultScope)) {
          const none: ContextSnapshot = { ...emptySnapshot(deps.agentId), work: { instruction: NO_CONTEXT } };
          cachePut(effect.sessionId, none);
          return none;
        }
        // An explicit resource read never inherits another wake's work selection.
        const selectedScopes = scopes.length ? scopes : [effect.opts?.via ? undefined : defaultScope];
        const packets = await Promise.all(selectedScopes.map(workScope =>
          buildSnapshot(deps, deps.agentId, { limit: effect.opts?.maxMessages, workScope, via: effect.opts?.via, includeHistory: effect.opts?.includeHistory })));
        const snap: ContextSnapshot = packets.length === 1 ? packets[0] : {
          ...emptySnapshot(deps.agentId),
          work: { contexts: packets.map(p => ({ ...p.work as object, workBrief: p.workBrief, agreements: p.agreements, history: p.history, artifacts: p.artifacts })),
            instruction: 'Separate work items: select one exact agreement for each action. Context and authority do not transfer between these packets.' },
          unavailable: packets.some(p => p.unavailable),
        };
        const me = (snap.agents as Array<{ isYou?: boolean; agentId?: string }>).find((a) => a?.isYou)?.agentId || null;
        outbox.merge(scoped(effect.sessionId), snap.history as Record<string, unknown>[], me);
        cachePut(effect.sessionId, snap);
        return snap;
      }


      case 'llm-call': {
        if (!deps.llm) throw new Error('llm-call effect requires an LLM adapter — none configured for this cognition');
        const t0 = Date.now();
        const r: LlmResponse = await deps.llm.chatMessages(effect.messages, effect.tools);
        sendTelemetry(
          deps.telemetryClient,
          buildLlmIngestPayload(r, {
            sessionId: effect.sessionId,
            durationMs: Date.now() - t0,
            runId: effect.runId,
            stateId: effect.stateId,
          }),
          isTelemetryIngestEnabled(deps.telemetryIngest),
        );
        return r;
      }

      case 'stream-text': {
        if (!deps.llm) throw new Error('stream-text effect requires an LLM adapter — none configured for this cognition');
        const { sessionId, receiverId, messageId, messages } = effect;
        let text = '';
        let usage: LlmResponse['usage'];
        if (deps.llm.chatMessagesStream) {
          const streamed = await deps.llm.chatMessagesStream(messages as LlmMessage[], (chunk) => {
            // Live-token display is best-effort and optional. Hosted agents wire
            // no chunkSender (delivery law, phase 4: no agent socket, no live
            // chunk transport), so partials are simply dropped — `text`
            // accumulates independently and the final send-message (below, in
            // runTurn) carries the full reply as one whole HTTP message. Any
            // chunk-send failure is swallowed so a display hiccup never aborts
            // the stream and loses the reply.
            try {
              if (chunk && chunk.trim()) deps.chunkSender?.(sessionId, receiverId, chunk, messageId);
            } catch { /* ignore — streaming display only */ }
          });
          text = streamed.text;
          usage = streamed.usage;
        } else {
          const r = await deps.llm.chatMessages(messages as LlmMessage[]);
          text = r.content ?? '';
          usage = r.usage;
          if (text) deps.chunkSender?.(sessionId, receiverId, text, messageId);
        }
        return { text, usage };
      }

      case 'tool-call': {
        // Roster + agreements come from the cached snapshot (populated by
        // read-context). Both cognitions land here — the FSM via runTurn's
        // executeTool, the Claude Agent SDK via the toolManagerToSdkMcp bridge —
        // so tool side effects are emitted exactly once, in one place.
        const cached = cacheGet(effect.sessionId);
        return executeToolWithSideEffects(deps, handler as EffectHandler, effect, {
          agents: (cached?.agents as unknown[]) || [],
          users: (cached?.users as unknown[]) || [],
          agreements: (cached?.agreements as unknown[]) || [],
        });
      }

      case 'send-message': {
        const sent = await deps.messageSender(effect.command);
        outbox.track(scoped(effect.sessionId), { text: effect.command.content.text, receiverId: sent.message.recipients[0]?.ref });
        return { ...sent, ok: true };
      }

      case 'record-event': {
        // Routes through ArtifactsClient as an agent-private artifact —
        // visible to this agent across turns, not to other chat parties.
        try {
          if (effect.entry.kind === 'thought' && typeof effect.entry.text === 'string') {
            await deps.artifactsClient.recordThought(effect.entry.text, {
              idempotencyKey: effect.idempotencyKey,
              serviceAgreementId: effect.serviceAgreementId,
            });
          } else {
            await deps.artifactsClient.write({
              ...artifactScope({ agreementId: effect.serviceAgreementId }),
              text: JSON.stringify(effect.entry),
              contentType: String(effect.entry.kind ?? 'event'),
              visibility: 'agent-private',
              serviceAgreementId: effect.serviceAgreementId,
              idempotencyKey: effect.idempotencyKey,
            });
          }
        } catch (err: unknown) {
          runtimeLog.warn('ZiggsEffectHandler', `record-event failed: ${(err as Error)?.message ?? String(err)}`);
        }
        return { ok: true };
      }

      default: {
        const exhaustive: never = effect;
        throw new Error(`ZiggsEffectHandler: unknown effect kind ${(exhaustive as Record<string, unknown>).kind}`);
      }
    }
  };

  const handler = async (effect: Effect): Promise<unknown> => {
    const response = await dispatch(effect);
    // A tap observes; it must never decide the effect's fate. This call was bare,
    // so a tap that threw took the effect down with it — and taps stringify
    // arbitrary tool results, which throws on a circular value or a BigInt. The
    // other two taps (metrics, wake) are already guarded; this is the last one.
    try {
      deps.effectTap?.(effect, response);
    } catch (err: unknown) {
      runtimeLog.warn('ZiggsEffectHandler', `effectTap failed: ${(err as Error)?.message || err}`);
    }
    return response;
  };

  return handler as EffectHandler;
}
