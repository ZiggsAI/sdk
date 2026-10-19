import { permitsAutomaticMandate } from './agreementContext.js';
import { isAgreementId } from '@ziggs-ai/api-client';
import type {
  Action, Ctx, Outcome, ToolResultEntry,
  EffectHandler, LlmMessage, LlmResponse, LlmToolSchema, LlmToolCall,
  ContextSnapshot, ToolCallResult, DeliveryWriteKeys,
} from '../types.js';
import type { MemoryStore } from '../memory/MemoryStore.js';
import { outcomeFromActionResult, type RawEvent, type EmittedEvent, type WireResult } from './buildOutcome.js';
import { PromptBuilder } from './PromptBuilder.js';
import { runtimeLog } from '../shared/runtimeLog.js';
import { safeParseJSON } from '../utils/jsonExtractor.js';
import type { ToolManager } from '../tools/ToolManager.js';
import { withDeclaredMandate } from './mandateDeclaration.js';
import type { ToolDefinition } from '../tools/defineTool.js';
import {
  resolveOnBehalfAgreementId,
  type OnBehalfAgreementRow,
} from '../brain/onBehalfAgreement.js';

interface ParsedDecision {
  action: string;
  tool?: string;
  thought?: string;
  message?: string;
  messages?: Array<{ receiverId: string; message: string; chatId?: string }>;
  receiverId?: string;
  chatId?: string;
  args?: Record<string, unknown>;
}

const MAX_TOOL_LOOP_ITERS = 20;
const MAX_MSG_CHARS = 3500;

/**
 * Legacy "name set" classifications. The runtime now prefers per-tool flags
 * (`isAgreementCreation`, `isGenericFallback`) set via `defineTool` options,
 * but these sets remain as a fallback so tools authored before the flag API
 * existed continue to work without modification.
 */
const LEGACY_AGREEMENT_CREATION_NAMES = new Set([
  'agreement_propose',
  'agreement_subcontract',
]);
const LEGACY_GENERIC_FALLBACK_NAMES = new Set(['agent_network', 'task_board']);

function isAgreementCreationTool(name: string, toolManager: ToolManager): boolean {
  if (!name) return false;
  if (toolManager?.getTool?.(name)?.isAgreementCreation === true) return true;
  return LEGACY_AGREEMENT_CREATION_NAMES.has(name);
}
function isGenericFallbackTool(name: string, toolManager: ToolManager): boolean {
  if (!name) return false;
  if (toolManager?.getTool?.(name)?.isGenericFallback === true) return true;
  return LEGACY_GENERIC_FALLBACK_NAMES.has(name);
}

interface RunTurnInput {
  stateId: string;
  statePrompt: import('../types.js').PromptDef;
  actions: Record<string, Action>;
  incomingEvent: RawEvent | null;
  ctx: Ctx;
  /** The only side channel. Every I/O — context, LLM, tools, send, record — flows through here. */
  eff: EffectHandler;
  /** Pure metadata: tool schemas, flags. Owned by the Agent. */
  toolManager: ToolManager;
  promptBuilder: PromptBuilder;
  /**
   * Agent-private long-term memory, threaded from Agent. Currently
   * surfaced into `eff` as part of the tool-call effect payload so tools
   * can read/write notes; the prompt builder doesn't consume it yet.
   */
  memory?: MemoryStore;
  definition: { description?: string };
  /**
   * Respond actions use 2-call streaming: Call 1 picks action+receiverId,
   * Call 2 streams the text. On by default; pass false
   * (or set ENABLE_LLM_STREAMING=false) to fold the reply text back into the
   * single decision call. The env flag is a deployment kill-switch — the
   * streaming path once broke long replies in production, so ops keeps a way
   * to disable it without a code change.
   */
  streamRespondActions?: boolean;
  /** This wake's replay-stable write keys (shared across every turn of the tick — see AgentMachine). */
  writeKeys?: DeliveryWriteKeys;
}

interface RunTurnResult {
  outcome: Outcome;
  toolResults: ToolResultEntry[];
  llmCalls: number;
  tokens: { total: number; input: number; output: number };
  skippedReason?: string;
}

/**
 * Run a single thinking-state turn.
 *
 * Reads context → builds prompt → tool loop with the LLM → executes one
 * action → returns exactly one Outcome via outcomeFromActionResult.
 *
 * No direct service calls. Every impure operation goes through `eff`:
 *   • eff('read-context')  — history/agreements/agents snapshot
 *   • eff('llm-call')      — model invocation
 *   • eff('tool-call')     — tool execution (Server runs the tool body)
 *   • eff('send-message')  — outbound peer message
 *   • eff('record-event')  — persist a thought / decision marker
 *
 * The Server is responsible for turning each effect into the right HTTP/WS
 * call and (optionally) wrapping it in telemetry / dedup / retries.
 */
export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const { stateId, statePrompt, actions, incomingEvent, ctx, eff, toolManager, promptBuilder, memory, definition, writeKeys } = input;
  // Default on; ENABLE_LLM_STREAMING=false is the deployment
  // kill-switch. Any other value (unset, 'true', …) streams.
  const streamRespondActions =
    input.streamRespondActions ?? process.env.ENABLE_LLM_STREAMING !== 'false';
  const sessionId = ctx.identity.sessionId;
  const runId = crypto.randomUUID();

  // Wrap eff to stamp runId + stateId onto llm-call and tool-call effects,
  // and the wake's replay-stable write keys onto tool-call effects.
  // Send-message effects without an explicit messageId get a wake-derived one
  // here — a crash-replay of the wake re-derives the same id and the backend's
  // (chatId, messageId) dedup drops the duplicate. Undefined on
  // keyless wakes, where the transport generates a fresh id as before.
  const effWithTrace: typeof eff = (effect) => {
    if (effect.kind === 'llm-call') {
      return eff({ ...effect, runId, stateId } as typeof effect);
    }
    if (effect.kind === 'tool-call') {
      return eff({ ...effect, runId, stateId, writeKeys } as typeof effect);
    }
    if (effect.kind === 'send-message' && !(effect as { messageId?: string }).messageId) {
      const send = effect as { text: string; sessionId: string; receiverId: string };
      return eff({
        ...effect,
        messageId: writeKeys?.messageKey({
          text: send.text,
          sessionId: send.sessionId,
          receiverId: send.receiverId,
        }),
      } as typeof effect);
    }
    return eff(effect);
  };

  const emitThought = async (text: unknown): Promise<void> => {
    if (text == null) return;
    const s = String(text).trim();
    if (s.length === 0) return;
    try {
      await eff({ kind: 'record-event', sessionId, entry: { kind: 'thought', text: s }, idempotencyKey: writeKeys?.artifactKey({ kind: 'thought', text: s }) });
    } catch (err) {
      runtimeLog.warn('runTurn', `record-event:thought failed: ${(err as Error).message}`);
    }
  };

  runtimeLog.info('runTurn', `enter state=${stateId} runId=${runId}`);

  // Parallel: read session context + collect tool schemas (pure).
  // Filter tools to only those bound to an action in the current state — the
  // runtime rejects tool calls that don't map to an allowed action (see
  // findActionForTool), so don't advertise tools the LLM can't actually use.
  const allTools: ToolDefinition[] = await Promise.resolve(toolManager?.getAvailableTools?.() ?? []);
  const allowedToolNames = new Set(
    Object.values(actions).map(a => a.tool).filter((t): t is string => !!t),
  );
  const toolName = (t: ToolDefinition): string | undefined => {
    const fn = (t.schema as Record<string, unknown>).function as Record<string, unknown> | undefined;
    return (fn?.name ?? (t.schema as Record<string, unknown>).name) as string | undefined;
  };
  const tools = allowedToolNames.size > 0
    ? allTools.filter(t => {
        const n = toolName(t);
        return n != null && allowedToolNames.has(n);
      })
    : [];
  const serverContext = await effWithTrace({ kind: 'read-context', sessionId, opts: {} });
  const ctxObj = normalizeContextSnapshot(serverContext);

  // A wake whose chat no longer resolves (deleted, or never visible to this
  // agent) has no world to decide over — deciding anyway means reasoning
  // about a fabricated empty history plus whatever stale scraps other
  // fetches returned. Skip the LLM and park. Resource wakes used to slip
  // past a message-only gate and burn a full turn. A bare
  // agreement id as sessionId is a mis-keyed lane — loud-log the empty
  // snapshot rather than staying silent.
  if (ctxObj.chatMissing) {
    const looksLikeBareAgreement = isAgreementId(sessionId);
    if (looksLikeBareAgreement) {
      runtimeLog.warn(
        'runTurn',
        `chatMissing on non-chat sessionId=${sessionId} (state=${stateId}) — ` +
          `lane was keyed by agreementId instead of the agreement's origin/notification chat; ` +
          `wake continues with an empty snapshot`,
      );
    } else {
      // Any wake in a room this agent cannot read — not only
      // message wakes. Resource notices used to spend a full turn here.
      runtimeLog.warn(
        'runTurn',
        `chat ${sessionId} not readable — skipping wake (state=${stateId})`,
      );
      return {
        outcome: { kind: 'wait' },
        toolResults: [],
        llmCalls: 0,
        tokens: { total: 0, input: 0, output: 0 },
        skippedReason: `chat_unreadable:${sessionId}`,
      };
    }
  }

  const prompt = promptBuilder.buildFromState({
    statePrompt, actions,
    serverContext: { context: ctxObj as Record<string, unknown>, tools: tools as unknown as Record<string, unknown>[] },
    incomingEvent, definition,
    chatId: sessionId, stateId, ctx,
    omitMessageFromRespond: streamRespondActions,
  });

  const systemContent = tools.length > 0
    ? 'You are a helpful AI agent. Use the available tools to complete your tasks. When you are finished using tools, respond with a valid JSON decision object.'
    : 'Respond with valid JSON.';
  const messages: LlmMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: prompt },
  ];

  const allEmittedEvents: EmittedEvent[] = [];
  let lastAction: string | null = null;
  let lastActionDef: Action | null = null;
  let lastArgs: unknown = null;
  let llmCallsTotal = 0;
  let tokensTotal = 0, tokensInput = 0, tokensOutput = 0;
  // Fold a tool's nested LLM usage (llmTool) into the turn's authoritative
  // token count so tool-internal spend reaches result.metrics.
  const addToolUsage = (u: LlmResponse['usage']): void => {
    if (!u) return;
    llmCallsTotal++;
    tokensTotal  += (u.total_tokens  ?? u.totalTokens)  || 0;
    tokensInput  += (u.prompt_tokens ?? u.promptTokens) || 0;
    tokensOutput += (u.completion_tokens ?? u.completionTokens) || 0;
  };
  // Tracks whether a successful agreement creation has already happened in
  // this turn. Used by annotateToolCallDedup to reject any second creation
  // attempt across iterations of the tool loop.
  let turnHadAgreementCreation = false;
  // Hard failure at the decision/send boundary. When set, the turn's outcome
  // is forced to kind 'error' regardless of partial events accumulated — the
  // FSM must see the failure, not a best-effort inference over half-finished
  // work. Causes are stable strings so workflow transitions can match them.
  let turnError: { source: 'llm' | 'protocol'; cause: 'send-failed' | 'unparseable-decision' } | null = null;
  // One corrective retry when the LLM's non-tool output cannot be turned into
  // an executable decision (parse failure, or missing message/receiverId).
  let repromptedForDecision = false;
  const actionNames = Object.keys(actions);

  runtimeLog.info('runTurn', `calling LLM tools=${tools.length}`);

  for (let iter = 0; iter < MAX_TOOL_LOOP_ITERS; iter++) {
    const llmResponse: LlmResponse = await effWithTrace({
      kind: 'llm-call',
      messages,
      tools: tools as unknown as LlmToolSchema[],
      sessionId,
    });
    llmCallsTotal++;
    const usage = llmResponse?.usage;
    tokensTotal  += (usage?.total_tokens  ?? usage?.totalTokens)  || 0;
    tokensInput  += (usage?.prompt_tokens ?? usage?.promptTokens) || 0;
    tokensOutput += (usage?.completion_tokens ?? usage?.completionTokens) || 0;

    if (llmResponse?.tool_calls?.length) {
      // Emit a thought for every tool-call turn so the chat timeline keeps
      // showing the agent's reasoning. OpenAI's tool_call responses usually
      // arrive with `content: null` (the standard "function calling"
      // shape), so relying on `llmResponse.content` alone silently dropped
      // the thought card whenever the agent chose to act via a tool —
      // i.e. essentially every first turn that produces a proposal. Fall
      // back to a deterministic "Calling tool: …" line so the user still
      // sees that the agent decided on something, with the args appended
      // when present.
      const toolCallThought = (() => {
        if (typeof llmResponse.content === 'string' && llmResponse.content.trim()) {
          return llmResponse.content;
        }
        const fn = llmResponse.tool_calls[0]?.function;
        if (!fn?.name) return null;
        const argsBlob = (() => {
          if (!fn.arguments) return '';
          try {
            const parsed = JSON.parse(fn.arguments);
            const flat = JSON.stringify(parsed);
            return flat.length > 240 ? ` ${flat.slice(0, 237)}…` : ` ${flat}`;
          } catch {
            return '';
          }
        })();
        const suffix = llmResponse.tool_calls.length > 1
          ? ` (+${llmResponse.tool_calls.length - 1} more)`
          : '';
        return `Calling tool: ${fn.name}${argsBlob}${suffix}`;
      })();
      await emitThought(toolCallThought);

      const tcs = llmResponse.tool_calls;
      const annotated = annotateToolCallDedup(tcs, toolManager, turnHadAgreementCreation);
      const dupCount = annotated.filter(a => a.skipExecute).length;
      if (dupCount > 0) {
        runtimeLog.warn('runTurn', `iter=${iter} skipping ${dupCount} duplicate tool call(s) in same message`);
      }

      messages.push({ role: 'assistant', tool_calls: tcs });

      const toolCallResults: Array<{ tc: LlmToolCall; matchingAction: string | null; result: unknown; skippedDuplicate?: boolean; skipReason?: string; args?: Record<string, unknown>; actionDef?: Action | null }> = [];
      for (const ann of annotated) {
        const { tc, skipExecute, skipReason } = ann;
        if (skipExecute) {
          toolCallResults.push({ tc, matchingAction: null, result: null, skippedDuplicate: true, skipReason });
          continue;
        }
        const toolName = tc?.function?.name;
        if (!toolName) {
          toolCallResults.push({ tc, matchingAction: null, result: null });
          continue;
        }

        let matchingAction = findActionForTool(toolName, actionNames, actions);
        let actionDef: Action | null = matchingAction ? actions[matchingAction] : null;

        if (!matchingAction && isGenericFallbackTool(toolName, toolManager) && toolManager.getTool?.(toolName)) {
          matchingAction = '_genericDiscoveryTool';
          actionDef = null;
        } else if (!matchingAction) {
          runtimeLog.info('runTurn', `iter=${iter} tool "${toolName}" not bound to any action — skipping`);
          toolCallResults.push({ tc, matchingAction: null, result: null });
          continue;
        }

        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        // Say which job this is part of, when the tool asks and the model did
        // not. The runtime knows; the model would have to be told.
        args = withDeclaredMandate(args, toolName, toolManager, ctx.activeAgreementId, permitsAutomaticMandate(incomingEvent));
        const decision = { action: matchingAction, tool: toolName, args };

        const result = await executeDecision(
          decision,
          actionDef,
          effWithTrace,
          sessionId,
          memory,
          incomingEvent,
          addToolUsage,
          ctx.identity.agentId,
          Array.isArray(ctxObj.agreements)
            ? (ctxObj.agreements as OnBehalfAgreementRow[])
            : null,
        );
        toolCallResults.push({ tc, matchingAction, result, args, actionDef });
      }

      let hasTerminal = false;
      for (const item of toolCallResults) {
        const { tc, matchingAction, result, skippedDuplicate, skipReason, args, actionDef } = item;
        if (skippedDuplicate) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ skipped: true, reason: skipReason || 'deduplicated' }) });
          continue;
        }
        if (!matchingAction || !result) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: '{"error":"unknown tool or no result"}' });
          continue;
        }

        const events = (Array.isArray(result) ? result : [result]) as EmittedEvent[];
        allEmittedEvents.push(...events);
        lastAction = matchingAction;
        lastActionDef = actionDef as Action | null;
        lastArgs = args;

        const firstEvent = (events[0] || {}) as EmittedEvent;
        const toolResultContent = JSON.stringify(firstEvent.result ?? firstEvent);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResultContent });

        if (!turnHadAgreementCreation && eventsContainAgreementCreation(events)) {
          turnHadAgreementCreation = true;
        }
        if (eventsAreTerminal(events) || actionDef?.terminatesLoop) hasTerminal = true;
      }

      if (hasTerminal) break;
      messages.push({ role: 'user', content: 'Tools done. Return your JSON decision now (follow the decision_schema). Do not write prose.' });

    } else {
      // — non-tool (JSON) response path —
      const parsed = parseLLMDecision(llmResponse, actionNames, actions);
      if (!parsed.ok) {
        if (repromptedForDecision) {
          runtimeLog.error('runTurn', `unparseable decision after reprompt: ${parsed.error}`);
          turnError = { source: 'llm', cause: 'unparseable-decision' };
          break;
        }
        repromptedForDecision = true;
        runtimeLog.warn('runTurn', `unparseable decision — reprompting once: ${parsed.error}`);
        messages.push({ role: 'assistant', content: llmResponse.content ?? '' });
        messages.push({ role: 'user', content: `Your last output was not a valid action: ${parsed.error}. Respond with exactly one action from the schema.` });
        continue;
      }
      const decision = parsed.decision;
      const chosenAction = decision.action;
      const actionDef = actions[chosenAction];
      // Same mandate declaration as the tool-call path above. Both routes reach
      // the same tools, so filling it on only one would make the excuse depend on
      // which shape the model happened to answer in.
      decision.args = withDeclaredMandate(
        (decision.args ?? {}) as Record<string, unknown>,
        actionDef?.tool,
        toolManager,
        ctx.activeAgreementId, permitsAutomaticMandate(incomingEvent),
      );

      if (decision.thought) await emitThought(decision.thought);

      // 2-call streaming: if this is a respond action (has receiverId, no bound tool),
      // use the streaming effect to generate text and send chunks to the client.
      // Streaming is a user-delivery optimization (chunks go to a user's socket).
      // For agent-to-agent replies (e.g. an orchestrator's pool dispatch captured
      // via ConnectionPool.requestFrom) there is no streaming channel — the chunk
      // send fails with empty content and, critically, no `send-message` effect is
      // emitted, so the caller's requestFrom never resolves and times out. Skip
      // streaming whenever the inbound message came from another agent.
      const inboundFromAgent = String(incomingEvent?.senderType || '').toUpperCase() === 'AGENT';
      runtimeLog.info('runTurn', `streaming check: enabled=${streamRespondActions} receiverId=${decision.receiverId ?? 'none'} tool=${actionDef?.tool ?? 'none'} action=${chosenAction} inboundFromAgent=${inboundFromAgent}`);
      if (streamRespondActions && !inboundFromAgent && decision.receiverId && !actionDef?.tool && chosenAction !== 'wait') {
        // Live chunks use a provisional id (text not known yet). The persisted
        // send below switches to a content-derived wake key once the
        // reply text exists — a crash-replay of the same text reuses that key
        //, and a re-think with different text does not collide.
        const chunkMessageId = crypto.randomUUID();
        runtimeLog.info('runTurn', `stream-text start action=${chosenAction} receiverId=${decision.receiverId} msgId=${chunkMessageId}`);
        const streamMessages: LlmMessage[] = [
          ...messages,
          {
            role: 'assistant' as const,
            content: JSON.stringify({ thought: decision.thought, action: decision.action, receiverId: decision.receiverId }),
          },
          {
            role: 'user' as const,
            content: 'Write your reply now. Output ONLY the message text — no JSON wrapping, no preamble.',
          },
        ];
        let replyText = '';
        try {
          const streamResult = await eff({ kind: 'stream-text', sessionId, receiverId: decision.receiverId, messageId: chunkMessageId, messages: streamMessages });
          replyText = streamResult.text ?? '';
          // Count the streamed reply only when it actually produced the text we
          // send (an empty resolve falls through to the llm-call fallback below,
          // which counts itself). The streamed reply is a real billed completion
          // (call 2 2-call streaming) — count it or the largest single
          // output of the turn leaks from every usage/cost sink.
          if (replyText) {
            llmCallsTotal++;
            const su = streamResult.usage;
            tokensTotal  += (su?.total_tokens  ?? su?.totalTokens)  || 0;
            tokensInput  += (su?.prompt_tokens ?? su?.promptTokens) || 0;
            tokensOutput += (su?.completion_tokens ?? su?.completionTokens) || 0;
            runtimeLog.info('runTurn', `stream-text done chars=${replyText.length} tokens=${(su?.total_tokens ?? su?.totalTokens) || 0}`);
          }
        } catch (err) {
          // Streaming transport failed before the reply text existed (call 2
          // runs inside the stream-text effect). Fall back to a plain
          // llm-call + send-message below so the user still gets a reply.
          runtimeLog.error('runTurn', `stream-text failed: ${(err as Error).message} — falling back to non-streaming send`);
        }
        let persistMessageId: string = chunkMessageId;
        try {
          if (!replyText) {
            const fallbackResponse: LlmResponse = await effWithTrace({ kind: 'llm-call', messages: streamMessages, tools: [], sessionId });
            llmCallsTotal++;
            const fu = fallbackResponse?.usage;
            tokensTotal  += (fu?.total_tokens  ?? fu?.totalTokens)  || 0;
            tokensInput  += (fu?.prompt_tokens ?? fu?.promptTokens) || 0;
            tokensOutput += (fu?.completion_tokens ?? fu?.completionTokens) || 0;
            replyText = (fallbackResponse?.content ?? '').trim();
            if (!replyText) throw new Error('fallback llm-call returned empty reply text');
          }
          const safeText = truncateMsg(replyText);
          persistMessageId =
            writeKeys?.messageKey({
              text: safeText,
              sessionId,
              receiverId: decision.receiverId,
            }) ?? chunkMessageId;
          await eff({ kind: 'send-message', sessionId, receiverId: decision.receiverId, text: safeText, messageId: persistMessageId });
          allEmittedEvents.push({ type: 'message_sent', receiverId: decision.receiverId, chatId: sessionId, message: safeText, senderId: 'system' });
          lastAction = chosenAction;
          lastActionDef = actionDef;
        } catch (err) {
          if (isReplySlotTaken(err)) {
            runtimeLog.warn('runTurn', `reply already persisted under ${persistMessageId} (idempotency 409) — a replay or second host answered this wake first; dropping duplicate`);
            allEmittedEvents.push({ type: 'message_duplicate_skipped', receiverId: decision.receiverId, chatId: sessionId, senderId: 'system' });
            lastAction = chosenAction;
            lastActionDef = actionDef;
          } else {
            // Both the streaming path AND the non-streaming fallback failed —
            // the user got nothing. End the turn with a loud send-failed error.
            runtimeLog.error('runTurn', `respond send failed after stream fallback: ${(err as Error).message}`);
            turnError = { source: 'protocol', cause: 'send-failed' };
          }
        }
        break;
      }

      let result: EmittedEvent[] | EmittedEvent | null;
      try {
        // effWithTrace, not eff: JSON-path tool calls must carry runId/stateId
        // and the wake's write keys exactly like tool-loop calls do.
        result = await executeDecision(
          decision,
          actionDef,
          effWithTrace,
          sessionId,
          memory,
          incomingEvent,
          addToolUsage,
          ctx.identity.agentId,
          Array.isArray(ctxObj.agreements)
            ? (ctxObj.agreements as OnBehalfAgreementRow[])
            : null,
        );
      } catch (err) {
        // Only outbound sends can throw out of executeDecision — executeTool
        // traps its own errors into tool_error events. A throw here means the
        // message never reached the backend; the turn must end loudly.
        runtimeLog.error('runTurn', `action "${chosenAction}" send failed: ${(err as Error).message}`);
        turnError = { source: 'protocol', cause: 'send-failed' };
        break;
      }
      if (!result) {
        // The decision parsed but could not be executed — e.g. a respond
        // action missing message/receiverId. Same defect class as a parse
        // failure. Nothing was executed for this decision, so a single
        // reprompt is safe (no duplicate side effects).
        if (repromptedForDecision) {
          runtimeLog.error('runTurn', `unexecutable decision after reprompt: action "${chosenAction}"`);
          turnError = { source: 'llm', cause: 'unparseable-decision' };
          break;
        }
        repromptedForDecision = true;
        runtimeLog.warn('runTurn', `unexecutable decision — reprompting once: action "${chosenAction}" missing required fields`);
        messages.push({ role: 'assistant', content: llmResponse.content ?? '' });
        messages.push({ role: 'user', content: `Your last output was not a valid action: action "${chosenAction}" was missing required fields (for a message this means "message"). Respond with exactly one action from the schema.` });
        continue;
      }
      const events = (Array.isArray(result) ? result : [result]) as EmittedEvent[];
      allEmittedEvents.push(...events);
      lastAction = chosenAction;
      lastActionDef = actionDef;
      lastArgs = decision.args;

      if (actionDef?.tool) {
        const firstEvent = (events[0] || {}) as EmittedEvent;
        const toolResultContent = JSON.stringify(firstEvent.result ?? firstEvent);
        messages.push({ role: 'assistant', content: llmResponse.content });
        messages.push({ role: 'user', content: `Tool "${actionDef.tool}" result:\n${toolResultContent}\n\nContinue with your next action.` });
        if (!turnHadAgreementCreation && eventsContainAgreementCreation(events)) {
          turnHadAgreementCreation = true;
        }
        if (eventsAreTerminal(events)) break;
        continue;
      }
      break;
    }
  }

  if (!turnError) {
    // effWithTrace, not eff: the echoed summary is a user-visible send and
    // must carry a wake-derived messageId like every other send of the turn.
    await echoOptInToolSummaryIfNeeded({
      allEmittedEvents, eff: effWithTrace, sessionId,
      context: ctxObj, toolManager, incomingEvent,
    });
  }

  const toolResults: ToolResultEntry[] = [];
  let outcome: Outcome = outcomeFromActionResult(lastAction, lastActionDef, lastArgs, allEmittedEvents, toolResults);
  if (turnError) {
    // A hard failure at the decision/send boundary outranks whatever partial
    // (always non-terminal — terminal protocol events break the loop before
    // the JSON-decision path) events accumulated this turn.
    outcome = { kind: 'error', source: turnError.source, cause: turnError.cause, retryable: false };
  }

  runtimeLog.info('runTurn', `done state=${stateId} action=${lastAction} outcome=${outcome.kind} llmCalls=${llmCallsTotal}`);

  return { outcome, toolResults, llmCalls: llmCallsTotal, tokens: { total: tokensTotal, input: tokensInput, output: tokensOutput } };
}

// ─────────────────────────────────────────────────────────────────────────────

function normalizeContextSnapshot(raw: ContextSnapshot | undefined | null): ContextSnapshot {
  if (!raw || typeof raw !== 'object') {
    return { history: [], agreements: [], agents: [], users: [] };
  }
  const out = { ...raw } as Record<string, unknown>;
  for (const key of ['history', 'agreements', 'agents', 'users']) {
    if (!Array.isArray(out[key])) out[key] = [];
  }
  return out as unknown as ContextSnapshot;
}

function eventsAreTerminal(events: EmittedEvent[]): boolean {
  return events.some(e => {
    if (!e) return false;
    const t = e.type;
    if (t === 'message_sent' || t === 'message_duplicate_skipped' || t === 'waited') return true;
    // Successful protocol-level state changes (agreement creation, task
    // assignment/closure) end the turn. The next turn re-enters with the
    // matching outcome and the workflow takes it from there. Without this,
    // the LLM is nudged with "Continue with your next action." and often
    // re-issues the same agreement_propose, producing duplicate proposal
    // cards within a single user turn.
    if (t === 'tool_result' || t === 'task_result') {
      const r = (e.result as Record<string, unknown>) || {};
      if (r.success === false || r.error) return false;
      // Support both nested { agreement: {...} } and flat Agreement objects
      // (api-client now returns Agreement directly, not wrapped in { agreement }).
      const ag = (r.agreement ?? (r.agreementId ? r : null)) as Record<string, unknown> | null | undefined;
      const task = (r.task || (r.taskId ? r : null)) as Record<string, unknown> | null | undefined;
      // Agreement's own status lives flat as `proposalStatus` (see api-client
      // Agreement type) — not nested under `.proposal.status`. Check both so
      // a successful agreement_propose is recognized as terminal instead of
      // being re-issued by the LLM on the next loop iteration.
      const agProposal = ag?.proposal as Record<string, unknown> | undefined;
      const taskProposal = task?.proposal as Record<string, unknown> | undefined;
      const proposalStatus = ag?.proposalStatus ?? agProposal?.status ?? taskProposal?.status;
      if (proposalStatus === 'pending' || proposalStatus === 'approved') return true;
      const state = task?.state || r.state;
      if (state === 'active' || state === 'in-progress' ||
          state === 'completed' || state === 'failed' || state === 'cancelled') {
        return true;
      }
    }
    return false;
  });
}

function eventsContainAgreementCreation(events: EmittedEvent[]): boolean {
  return events.some(e => {
    if (!e || e.type !== 'tool_result') return false;
    const r = (e.result as Record<string, unknown>) || {};
    if (r.success === false || r.error) return false;
    // Support both nested { agreement: {...} } and flat Agreement objects.
    const ag = (r.agreement ?? (r.agreementId ? r : null)) as Record<string, unknown> | undefined;
    // See eventsAreTerminal above: proposalStatus is flat on Agreement, not nested.
    const agProposal = ag?.proposal as Record<string, unknown> | undefined;
    const task = r.task as Record<string, unknown> | undefined;
    const taskProposal = task?.proposal as Record<string, unknown> | undefined;
    const proposalStatus = ag?.proposalStatus ?? agProposal?.status ?? taskProposal?.status;
    return proposalStatus === 'pending' || proposalStatus === 'approved';
  });
}

function annotateToolCallDedup(
  toolCalls: LlmToolCall[],
  toolManager: ToolManager,
  initialSawCreate = false,
): Array<{ tc: LlmToolCall; skipExecute: boolean; skipReason?: string }> {
  let sawCreate = initialSawCreate;
  const seenUpdateTaskIds = new Set<string>();
  return (toolCalls || []).map((tc: LlmToolCall) => {
    const name = tc?.function?.name;
    if (name && isAgreementCreationTool(name, toolManager)) {
      if (sawCreate) {
        return {
          tc,
          skipExecute: true,
          skipReason: initialSawCreate
            ? 'agreement creation already executed earlier in this turn'
            : 'duplicate agreement creation in same assistant message',
        };
      }
      sawCreate = true;
      return { tc, skipExecute: false };
    }
    if (name === 'task_set_result') {
      let taskId: string | null = null;
      try { const a = JSON.parse(tc.function.arguments || '{}'); taskId = typeof a.taskId === 'string' ? a.taskId : null; } catch {}
      const key = taskId || tc.id || '_';
      if (seenUpdateTaskIds.has(key)) return { tc, skipExecute: true, skipReason: 'duplicate task_set_result for same taskId' };
      seenUpdateTaskIds.add(key);
      return { tc, skipExecute: false };
    }
    return { tc, skipExecute: false };
  });
}

type DecisionParse =
  | { ok: true; decision: ParsedDecision }
  | { ok: false; error: string };

function parseLLMDecision(llmResponse: LlmResponse, allowedActionNames: string[], actions: Record<string, Action>): DecisionParse {
  if (llmResponse?.tool_calls?.length) {
    const tc = llmResponse.tool_calls[0];
    if (!tc?.function?.name) return { ok: false, error: 'tool call had no function name' };
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
    const matchingAction = findActionForTool(tc.function.name!, allowedActionNames, actions);
    if (!matchingAction) return { ok: false, error: `tool "${tc.function.name}" is not bound to any action in this state` };
    return { ok: true, decision: { thought: `Using tool: ${tc.function.name}`, action: matchingAction, tool: tc.function.name, args } };
  }

  const parsed = safeParseJSON(llmResponse?.content || '', null) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'output was not a JSON object' };
  }
  if (!parsed['action'] || !allowedActionNames.includes(parsed['action'] as string)) {
    return { ok: false, error: `missing or unknown "action" — allowed: ${allowedActionNames.join(', ')}` };
  }
  return { ok: true, decision: parsed as unknown as ParsedDecision };
}

function findActionForTool(toolName: string, allowedActionNames: string[], actions: Record<string, Action>): string | null {
  if (!toolName) return null;
  const matches = allowedActionNames.filter(n => actions[n]?.tool === toolName);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    runtimeLog.warn('runTurn', `ambiguous: ${matches.length} actions bind tool "${toolName}"`);
    return null;
  }
  return null;
}

async function executeDecision(
  decision: ParsedDecision,
  actionDef: Action | null,
  eff: EffectHandler,
  sessionId: string,
  memory?: MemoryStore,
  incomingEvent: RawEvent | null = null,
  onUsage?: (usage: LlmResponse['usage']) => void,
  agentId: string | null = null,
  agreements: OnBehalfAgreementRow[] | null = null,
): Promise<EmittedEvent[] | EmittedEvent | null> {
  const boundTool = actionDef?.tool || null;

  if (boundTool) {
    decision.tool = boundTool;
    return await executeTool(
      decision,
      eff,
      sessionId,
      memory,
      incomingEvent,
      onUsage,
      agentId,
      agreements,
    );
  }
  if (decision.action === '_genericDiscoveryTool' && decision.tool) {
    return await executeTool(
      decision,
      eff,
      sessionId,
      memory,
      incomingEvent,
      onUsage,
      agentId,
      agreements,
    );
  }
  if (decision.tool) {
    return await executeTool(
      decision,
      eff,
      sessionId,
      memory,
      incomingEvent,
      onUsage,
      agentId,
      agreements,
    );
  }
  if (decision.messages && Array.isArray(decision.messages) && decision.messages.length > 0) {
    return await executeSendMessages(decision, eff, sessionId);
  }
  if (decision.message) {
    return await executeSendMessage(decision, eff, sessionId);
  }
  // Fallback: LLM may place message/receiverId inside args due to format ambiguity
  // between prompt.format ("args: { receiverId, message }") and the top-level schema.
  if (!decision.message && !decision.receiverId && decision.args) {
    const a = decision.args as Record<string, unknown>;
    if (typeof a.message === 'string' && typeof a.receiverId === 'string') {
      return await executeSendMessage({ ...decision, message: a.message, receiverId: a.receiverId }, eff, sessionId);
    }
  }
  // An action with no tool and no message that is named "wait" OR statically
  // declares `produces: 'wait'` (e.g. "pause"/"hold") is an explicit
  // do-nothing — emit `waited` so the turn ends honestly instead of falling
  // through to the unexecutable-decision reprompt.
  if (decision.action === 'wait' || actionDef?.produces === 'wait') return { type: 'waited' };
  return null;
}

function truncateMsg(msg: unknown): string {
  if (typeof msg !== 'string') return String(msg ?? '');
  if (msg.length <= MAX_MSG_CHARS) return msg;
  return msg.slice(0, MAX_MSG_CHARS) + `\n\n[truncated to ${MAX_MSG_CHARS} of ${msg.length} chars]`;
}

/**
 * A send rejected with 409 hit the backend's (chatId, messageId) idempotency
 * gate on a wake-derived id: this wake's reply already exists. Two legal ways
 * that happens — a crash-replay re-ran the wake, or a second host raced the
 * same at-least-once delivery — and in both the re-run LLM produced different
 * text, so the backend rejects instead of no-op'ing (treats
 * same-key-same-content as replay, same-key-different-content as conflict).
 * The user already has the winner's reply. Re-sending under a fresh id would
 * double-message; failing the turn marks an answered wake as an error. Treat
 * it as delivered-by-the-other-attempt and move on.
 */
function isReplySlotTaken(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 409;
}

async function executeSendMessage(decision: ParsedDecision, eff: EffectHandler, sessionId: string): Promise<EmittedEvent[]> {
  // Callers guarantee message text. receiverId is set only when the model
  // named someone; an answer without one is sent without one. sessionId is
  // always ctx.identity.sessionId. A send failure throws to the turn loop,
  // which converts it into the 'send-failed' error outcome — no silent nulls,
  // and message_sent is only emitted after the send effect resolved.
  // `decision.chatId` is what the LLM emitted in its JSON decision; honor it
  // for cross-session sends (e.g. reporting to a parent task chat), fall back
  // to the current session otherwise.
  const targetSessionId = decision.chatId || sessionId;
  const safeMessage = truncateMsg(decision.message);
  const receiverId = decision.receiverId || undefined;
  try {
    await eff({
      kind: 'send-message',
      sessionId: targetSessionId,
      ...(receiverId ? { receiverId } : {}),
      text: safeMessage,
    });
  } catch (err) {
    if (!isReplySlotTaken(err)) throw err;
    runtimeLog.warn('runTurn', `reply already persisted for this wake (idempotency 409) — a replay or second host answered first; dropping duplicate${receiverId ? ` to ${receiverId}` : ''}`);
    return [{ type: 'message_duplicate_skipped', ...(receiverId ? { receiverId } : {}), chatId: targetSessionId, senderId: 'system' }];
  }
  const events: EmittedEvent[] = [{ type: 'message_sent', ...(receiverId ? { receiverId } : {}), chatId: targetSessionId, message: safeMessage, senderId: 'system' }];
  if (targetSessionId !== sessionId) events.push({ type: 'report_sent', message: 'Reported to owner.', senderId: 'system' });
  return events;
}

/**
 * Multi-message send. `message_sent` is emitted ONLY for sends that actually
 * succeeded. Malformed entries (missing receiverId/message) and transport
 * failures are collected: if nothing was even attempted the caller sees null
 * and reprompts (LLM output defect); if every attempted send failed the whole
 * action throws (→ 'send-failed' error outcome); a partial failure keeps the
 * successful sends and logs loudly — reprompting after partial execution
 * would risk duplicate messages.
 */
async function executeSendMessages(decision: ParsedDecision, eff: EffectHandler, sessionId: string): Promise<EmittedEvent[] | null> {
  const events: EmittedEvent[] = [];
  const failures: Array<{ receiverId: string; error: string }> = [];
  let attempted = 0;
  for (const msg of decision.messages ?? []) {
    if (!msg.message) {
      failures.push({ receiverId: msg.receiverId || '<missing>', error: 'missing message' });
      continue;
    }
    const targetSessionId = msg.chatId || sessionId;
    const safeMessage = truncateMsg(msg.message);
    attempted++;
    try {
      await eff({
        kind: 'send-message',
        sessionId: targetSessionId,
        ...(msg.receiverId ? { receiverId: msg.receiverId } : {}),
        text: safeMessage,
      });
    } catch (err) {
      if (isReplySlotTaken(err)) {
        runtimeLog.warn('runTurn', `reply already persisted for this wake (idempotency 409) — dropping duplicate to ${msg.receiverId}`);
        events.push({ type: 'message_duplicate_skipped', receiverId: msg.receiverId, chatId: targetSessionId, senderId: 'system' });
        continue;
      }
      // Scenario: backend rejected or transport dropped this one send. Record
      // it and keep going — remaining recipients must still get their message.
      failures.push({ receiverId: msg.receiverId, error: (err as Error).message });
      continue;
    }
    events.push({ type: 'message_sent', receiverId: msg.receiverId, chatId: targetSessionId, message: safeMessage, senderId: 'system' });
    if (targetSessionId !== sessionId) events.push({ type: 'report_sent', message: 'Reported to owner.', senderId: 'system' } as unknown as EmittedEvent);
  }
  if (attempted === 0) return null; // every entry malformed — LLM output defect, caller reprompts
  if (events.length === 0) {
    throw new Error(`all ${failures.length} send(s) failed: ${failures.map(f => `${f.receiverId}: ${f.error}`).join('; ')}`);
  }
  if (failures.length > 0) {
    runtimeLog.error('runTurn', `partial send failure (${failures.length} of ${(decision.messages ?? []).length} entries): ${failures.map(f => `${f.receiverId}: ${f.error}`).join('; ')}`);
  }
  return events;
}

/**
 * Tool execution becomes a single effect call. The Server is responsible for
 * dispatching the named tool to its implementation, providing the impure
 * dependencies (taskService, agreementService, agents list, etc.), and
 * wrapping the call in telemetry / operation-record entries if it wants.
 */
async function executeTool(
  decision: ParsedDecision,
  eff: EffectHandler,
  sessionId: string,
  memory?: MemoryStore,
  incomingEvent: RawEvent | null = null,
  onUsage?: (usage: LlmResponse['usage']) => void,
  agentId: string | null = null,
  agreements: OnBehalfAgreementRow[] | null = null,
): Promise<EmittedEvent[] | EmittedEvent | null> {
  const { tool, args } = decision;
  if (!tool) return null;
  try {
    const r = await eff({
      kind: 'tool-call',
      sessionId,
      name: tool,
      args: args || {},
      memory,
      senderId: incomingEvent?.senderId != null ? String(incomingEvent.senderId) : undefined,
      senderType: incomingEvent?.senderType != null ? String(incomingEvent.senderType) : undefined,
      // Never bind on-behalf to a sub the agent only pays for.
      onBehalfOfAgreementId: resolveOnBehalfAgreementId(
        incomingEvent ?? undefined,
        agreements,
        agentId,
        sessionId,
      ),
    }) as ToolCallResult;
    if (r.usage) onUsage?.(r.usage);
    if (!r.ok) return { type: 'tool_error', tool, error: r.error || 'unknown', senderId: 'system' };
    // Tools may emit terminal markers (e.g. `message_sent`, `waited`) via
    // `events` — propagate so the loop can detect terminal turns.
    if (r.events && (r.events as unknown[]).length > 0) return r.events as unknown as EmittedEvent[];
    return { type: 'tool_result', tool, result: r.result as WireResult | undefined, senderId: 'system' };
  } catch (error: unknown) {
    return { type: 'tool_error', tool, error: (error as Error)?.message ?? String(error), senderId: 'system' };
  }
}

function shouldEchoToolSummaryToUser(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  if (typeof r.message !== 'string' || !(r.message as string).trim()) return false;
  if (r.success === false) return false;
  if (r.error) return false;
  return true;
}

async function echoOptInToolSummaryIfNeeded({ allEmittedEvents, eff, sessionId, context, toolManager, incomingEvent }: {
  allEmittedEvents: EmittedEvent[];
  eff: EffectHandler;
  sessionId: string;
  context: ContextSnapshot;
  toolManager: ToolManager;
  incomingEvent: RawEvent | null;
}): Promise<void> {
  if (!eff || !sessionId || !context || !toolManager?.getTool) return;
  if (allEmittedEvents.some((e) => e?.type === 'message_sent')) return;

  let summary: string | null = null;
  for (const ev of allEmittedEvents) {
    if (ev?.type !== 'tool_result' || !ev.tool) continue;
    const reg = toolManager.getTool(ev.tool);
    if (!reg?.echoUserSummaryOnSuccess) continue;
    if (!shouldEchoToolSummaryToUser(ev.result)) continue;
    summary = (ev.result as Record<string, unknown>).message as string;
  }
  if (!summary) return;

  const receiverId = pickReceiverForEcho(context, incomingEvent);
  if (!receiverId) return;

  const safe = truncateMsg(summary);
  const wasTruncated = safe !== summary;
  try {
    await eff({ kind: 'send-message', sessionId, receiverId, text: safe });
  } catch { return; }
  const event: Record<string, unknown> = { type: 'message_sent', receiverId, chatId: sessionId, message: safe, senderId: 'system' };
  if (wasTruncated) { event['truncated'] = true; event['originalLength'] = summary.length; }
  allEmittedEvents.push(event as unknown as EmittedEvent);
}

function pickReceiverForEcho(context: ContextSnapshot, incomingEvent: RawEvent | null): string | null {
  const senderId = incomingEvent?.senderId;
  const senderType = String(incomingEvent?.senderType || '').toUpperCase();
  if (senderId && senderType === 'USER') return String(senderId);
  return pickPrimaryUserIdFromContext(context);
}

function pickPrimaryUserIdFromContext(context: ContextSnapshot): string | null {
  const users = context?.users || [];
  for (const u of users as Record<string, unknown>[]) {
    const id = (u?.userId || u?.id) as string | undefined;
    if (id && typeof id === 'string') return id;
  }
  const hist = context?.history || [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const row = hist[i] as Record<string, unknown>;
    const sender = row?.sender as Record<string, unknown> | undefined;
    const type = String(sender?.type || '').toUpperCase();
    const id = sender?.id as string | undefined;
    if (type === 'USER' && id) return id;
  }
  return null;
}
