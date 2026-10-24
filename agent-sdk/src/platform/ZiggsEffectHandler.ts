import type { WriteSource } from '@ziggs-ai/api-client';
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
import { runtimeLog } from '../shared/runtimeLog.js';
import { toolFailureText } from '../brain/toolFailureText.js';
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
import { artifactScopeForSession } from '@ziggs-ai/api-client';
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
  messageSender: (text: string, receiverId: string | undefined, sessionId: string, messageId?: string, conversationAgreementId?: string, underAgreementId?: string, taskId?: string, sources?: WriteSource[]) => Promise<unknown>;
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

/**
 * Compose a `ContextSnapshot` for a chatId via the grant-fenced aggregate read
 * (`GET /context/snapshot`, follow-up). The backend assembles history +
 * agreements + roster through the same `assertScopeAccess` + temporal fence as
 * the per-type context reads, and annotates `*IsYou` / self server-side against
 * the acting agent. This function only preserves the never-throw/degrade
 * contract that the cognition code depends on — the shape is unchanged.
 */
const emptySnapshot = (agentId: string, chatMissing = false): ContextSnapshot => ({
  history: [],
  agreements: [],
  users: [],
  agents: [{ agentId, role: 'self', isYou: true, kind: 'agent' }],
  latestSequence: null,
  ...(chatMissing ? { chatMissing: true } : {}),
});

async function buildSnapshot(
  deps: ZiggsEffectDeps,
  chatId: string,
  agentId: string,
  opts: { limit?: number; workScope?: { agreementId?: string; taskId?: string; messageId?: string; artifactId?: string } } = {},
): Promise<ContextSnapshot> {
  try {
    // Server returns 200 + chatMissing:true for a deleted chat, so its
    // annotations (roster, *IsYou, self) are already applied — pass through.
    // Read as this wake: the session is the lane, the way its tool calls are
    // sent. Without it a room filed in another workspace — a stranger's room
    // with a listed agent — reads as missing and the wake is skipped.
    const reader = deps.contextReadClient.withLane?.(chatId) ?? deps.contextReadClient;
    const snap = await reader.snapshot(chatId, {
      maxMessages: opts.limit,
      ...opts.workScope,
    });
    // Built rather than cast: the roster rows are typed on both sides now (they
    // carry the declared participant kind), and only `history` is loose on the
    // wire, so a whole-object cast would be asserting past the one field that
    // actually needs it.
    return { ...snap, history: snap.history as HistoryEntry[] };
  } catch (err: unknown) {
    // Defensive: server normally signals a dead chat as 200 + chatMissing, but
    // a raw 404 degrades the same way so message wakes still skip it.
    const status = (err as { status?: number })?.status;
    // 403 = exists but this agent has no grant. Same as deleted:
    // no world to act in. Leaving it as an empty snapshot used to run a
    // full turn against refusals.
    if (status === 404 || status === 403) {
      return { ...emptySnapshot(agentId, true), unavailable: true, work: { minimumComplete: false, authorization: { active: false }, instruction: 'Required context is unavailable. Do not start work without verified scope and access.' } };
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
  sessionId: string,
  phase: 'started' | 'completed' | 'error',
  payload: Record<string, unknown>,
  idempotencyKey?: string,
  serviceAgreementId?: string,
): Promise<void> {
  const prefix =
    phase === 'started' ? 'operation_started' : phase === 'completed' ? 'operation_completed' : 'operation_error';
  const text = `${prefix}:${JSON.stringify(payload)}`;
  try {
    await client.write({
      // an agreement lane (`agrn-…`) is a routing key, not a chat —
      // passing it as chatId asked the backend to write into a chat that does
      // not exist and 403'd every breadcrumb on agreement-lane work.
      ...artifactScopeForSession(sessionId),
      text,
      contentType: 'operation',
      visibility: 'agent-private',
      serviceAgreementId,
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
 * (`context_snapshot`, `chat_send`) resolve through this same path
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
  >,
  eff: EffectHandler,
  effect: Extract<Effect, { kind: 'tool-call' }>,
  roster: { agents: unknown[]; users: unknown[]; agreements?: unknown[] },
): Promise<ToolCallResult> {
  const toolT0 = Date.now();
  const args = (effect.args as Record<string, unknown>) || {};
  const argsPreview = previewToolArgs(args);
  // #6 — breadcrumbs are best-effort. Awaiting them bracketed every
  // tool call; a slow/wedged artifacts backend stalled the whole wake. Match
  // ClaudeBrain thought writes (fire-and-forget).
  void emitToolOperationArtifact(deps.artifactsClient, effect.sessionId, 'started', {
    state: 'started',
    tool: effect.name,
    ...(argsPreview ? { args: argsPreview } : {}),
  }, effect.writeKeys?.artifactKey({ s: 'started', t: effect.name, a: argsPreview }), effect.serviceAgreementId);
  try {
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
      chatId: effect.sessionId,
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
      onBehalfOfAgreementId: effect.onBehalfOfAgreementId,
      serviceAgreementId: effect.serviceAgreementId,
      memory: effect.memory,
      writeKeys: effect.writeKeys,
      // The wake's checkout, when the host opened one.
      ...(effect.checkout ? { checkout: effect.checkout } : {}),
      // `wake_at` reads this off the tool context.
      wakeScheduler: deps.wakeScheduler,
      reportUsage,
      turnScratch: {},
    });
    // One clip per tool call: this is a full JSON.stringify of the untruncated
    // result, and the artifact body and the idempotency key want the same string.
    const clipped = clipForOperationArtifact(result);
    void emitToolOperationArtifact(deps.artifactsClient, effect.sessionId, 'completed', {
      state: 'completed',
      tool: effect.name,
      result: clipped,
    }, effect.writeKeys?.artifactKey({ s: 'completed', t: effect.name, r: clipped }), effect.serviceAgreementId);
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
    return { ok: true, result, ...(nestedUsage ? { usage: nestedUsage } : {}) } satisfies ToolCallResult;
  } catch (error: unknown) {
    const errMsg = toolFailureText(error);
    runtimeLog.warn('ZiggsEffectHandler', `tool-call "${effect.name}" failed: ${errMsg}`);
    void emitToolOperationArtifact(deps.artifactsClient, effect.sessionId, 'error', {
      state: 'failed',
      tool: effect.name,
      error: errMsg,
    }, effect.writeKeys?.artifactKey({ s: 'failed', t: effect.name, e: errMsg }), effect.serviceAgreementId);
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
    return { ok: false, error: errMsg } satisfies ToolCallResult;
  }
}

/**
 * Build a single shared EffectHandler. The handler is stateful — it caches
 * the latest ContextSnapshot per sessionId so tool-call effects can resolve
 * session-coupled deps (the `agents` roster) without forcing the Agent to
 * pass them through. Cache is bounded with simple LRU eviction (re-set on
 * read promotes the entry; oldest entry drops when size exceeds the cap).
 */
export function createZiggsEffectHandler(deps: ZiggsEffectDeps): EffectHandler {
  const contextCache = new Map<string, ContextSnapshot>();
  const outbox = new OutboxBuffer();

  const cachePut = (sessionId: string, snap: ContextSnapshot): void => {
    if (contextCache.has(sessionId)) contextCache.delete(sessionId);
    contextCache.set(sessionId, snap);
    if (contextCache.size > CONTEXT_CACHE_MAX) {
      const oldest = contextCache.keys().next().value;
      if (oldest !== undefined) contextCache.delete(oldest);
    }
  };
  const cacheGet = (sessionId: string): ContextSnapshot | undefined => {
    const snap = contextCache.get(sessionId);
    if (snap !== undefined) {
      contextCache.delete(sessionId);
      contextCache.set(sessionId, snap);
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
        const packets = await Promise.all((scopes.length ? scopes : [undefined]).map(workScope =>
          buildSnapshot(deps, effect.sessionId, deps.agentId, { limit: effect.opts?.maxMessages, workScope })));
        const snap: ContextSnapshot = packets.length === 1 ? packets[0] : {
          ...emptySnapshot(deps.agentId),
          work: { contexts: packets.map(p => ({ ...p.work as object, workBrief: p.workBrief, agreements: p.agreements, history: p.history, artifacts: p.artifacts })),
            instruction: 'Separate work items: select one exact agreement for each action. Context and authority do not transfer between these packets.' },
          unavailable: packets.some(p => p.unavailable),
        };
        const me = (snap.agents as Array<{ isYou?: boolean; agentId?: string }>).find((a) => a?.isYou)?.agentId || null;
        outbox.merge(effect.sessionId, snap.history as Record<string, unknown>[], me);
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
        const sent = await deps.messageSender(effect.text, effect.receiverId, effect.sessionId, effect.messageId, effect.conversationAgreementId, effect.underAgreementId, effect.taskId, effect.sources);
        outbox.track(effect.sessionId, { text: effect.text, receiverId: effect.receiverId });
        // Carry the send's own report back to whoever asked for the send. A
        // sender that cannot see where its message went cannot tell a delivered
        // answer from a dropped one, which is the whole failure here.
        const report = (sent ?? {}) as {
          chatId?: string; messageId?: string; delivered?: string;
          to?: { id: string; type: string };
        };
        return {
          ok: true,
          ...(report.chatId ? { chatId: report.chatId } : {}),
          ...(report.messageId ? { messageId: report.messageId } : {}),
          ...(report.delivered ? { delivered: report.delivered } : {}),
          ...(report.to ? { to: report.to } : {}),
        };
      }

      case 'record-event': {
        // Routes through ArtifactsClient as an agent-private artifact —
        // visible to this agent across turns, not to other chat parties.
        try {
          if (effect.entry.kind === 'thought' && typeof effect.entry.text === 'string') {
            await deps.artifactsClient.recordThought(effect.sessionId, effect.entry.text, {
              idempotencyKey: effect.idempotencyKey,
              serviceAgreementId: effect.serviceAgreementId,
            });
          } else {
            await deps.artifactsClient.write({
              ...artifactScopeForSession(effect.sessionId),
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
