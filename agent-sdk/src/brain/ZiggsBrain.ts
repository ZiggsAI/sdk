import type { Brain } from './index.js';
import type { Ctx, Identity, Workflow, EffectHandler } from '../types.js';
import { AgentMachine, type TransitionEvent } from '../runtime/AgentMachine.js';
import { createDeliveryWriteKeys } from '../runtime/deliveryWriteKeys.js';
import { runTurn } from '../runtime/runTurn.js';
import { PromptBuilder } from '../runtime/PromptBuilder.js';
import type { MemoryStore } from '../memory/MemoryStore.js';
import type { ToolManager } from '../tools/ToolManager.js';
import type { RawEvent } from '../runtime/buildOutcome.js';

export interface ZiggsBrainOptions {
  workflow: Workflow;
  toolManager: ToolManager;
  promptBuilder?: PromptBuilder;
}

export interface TickInput {
  /** Wire event (already normalized: a `message` or `task_result`-style envelope). */
  event: unknown;
  /** Agent-provided per-session state. Omit on the first tick — a fresh ctx is constructed. */
  ctx?: Ctx;
  /** Agent-provided workflow state name. Omit on the first tick — defaults to `workflow.initial`. */
  state?: string;
  /** Who am I and what session am I running in. The ZiggsBrain carries this through Ctx. */
  identity: Identity;
  /** The single side channel for I/O — LLM, context, tools, send, record. */
  eff: EffectHandler;
  /**
   * Agent-private long-term memory. Operator-provided (default
   * `InMemoryStore` when omitted by `Agent`). The agent already scopes
   * this to the hire the wake is inside; key shape inside that section is
   * the agent's choice — `counterparty:<id>`, `agreement:<id>:notes`, etc.
   */
  memory?: MemoryStore;
  /** Optional tap for FSM transition events. */
  transitionTap?: (event: TransitionEvent) => void;
  /**
   * Aborted by the agent when the tick watchdog fires. A brain driving an
   * external loop (the Claude ZiggsBrain SDK query) MUST stop consuming it on
   * abort — the agent's Promise.race only abandons the tick promise, so
   * without this the query keeps running as a zombie: burning tokens and
   * racing its own redelivered retry (observed as duplicate kickoffs and a
   * 363k-token wake, 2026-07-26).
   */
  signal?: AbortSignal;
}

export interface TickOutput {
  /** Updated ctx — Agent persists this against the session. */
  ctx: Ctx;
  /** Workflow state name after the tick — Agent persists this against the session. */
  state: string;
  /** Whether the machine settled at a parked state. */
  parked: boolean;
  /** True when a state-timeout outcome matched no transition this tick — the agent must NOT re-arm. */
  stateTimeoutUnhandled: boolean;
  /**
   * Accumulated LLM call count and token usage for this tick.
   * `cacheRead` / `cacheCreation` are populated by the Claude brain (its usage
   * exposes cache traffic, which is the bulk of real cost/813); the
   * FSM path leaves them undefined. `total` includes cache tokens when present.
   */
  metrics: {
    llmCalls: number;
    tokens: { total: number; input: number; output: number; cacheRead?: number; cacheCreation?: number };
  };
  /** Tick skipped the model; host records a no-op naming why. */
  skippedReason?: string;
}

/**
 * Workflow brain: workflow definition + cognition machinery. No I/O, no transport,
 * no services. The brain's only side channel is the `eff` handler it receives
 * on each `tick`. Body state (sessions, lanes, queue, outbox) lives in
 * `Agent` — not here.
 *
 * The contract:
 *
 *   `tick({ event, ctx, state, identity, eff })` →
 *   `{ ctx, state, parked }`
 *
 * Reads top-to-bottom like a synchronous function. Every `await eff(...)`
 * inside the cognition core is a yield to the body, which performs the
 * impure operation and resumes the ZiggsBrain with the result.
 */
export class ZiggsBrain implements Brain {
  readonly kind = 'ziggs' as const;
  workflow: Workflow;
  toolManager: ToolManager;
  promptBuilder: PromptBuilder;

  constructor({ workflow, toolManager, promptBuilder }: ZiggsBrainOptions) {
    if (!workflow?.states) throw new Error('ZiggsBrain: workflow with states is required');
    if (!toolManager) throw new Error('ZiggsBrain: toolManager is required');
    this.workflow = workflow;
    this.toolManager = toolManager;
    this.promptBuilder = promptBuilder || new PromptBuilder();
  }

  async tick({ event, ctx, state, identity, eff, memory, transitionTap, signal }: TickInput): Promise<TickOutput> {
    if (!identity?.sessionId) throw new Error('ZiggsBrain.tick: identity.sessionId is required');
    if (!eff) throw new Error('ZiggsBrain.tick: eff is required');

    const machine = new AgentMachine({
      workflow: this.workflow,
      executionCore: runTurn,
      eff,
      toolManager: this.toolManager,
      promptBuilder: this.promptBuilder,
      memory,
      input: { identity, ctx, state },
      transitionTap,
      // One key stream per wake, shared by every state this tick runs through —
      // per-state streams would restart the ordinal and collide across states.
      writeKeys: createDeliveryWriteKeys(identity.laneKey, event),
    });

    // `send` awaits the recursive _step until the machine settles at a
    // parked state (or stops). When it returns, we have the final state.
    try {
      await machine.send({ event: event as RawEvent | undefined, identity });
    } catch (error) {
      if (!signal?.aborted || signal.reason?.code !== 'TASK_CONTROL') throw error;
      // Preserve completed FSM progress so Resume does not restart the task.
    }

    return {
      ctx: machine.ctx,
      state: machine.state,
      parked: machine.isParked,
      stateTimeoutUnhandled: machine.stateTimeoutUnhandled,
      metrics: { llmCalls: machine.llmCalls, tokens: machine.tokens },
      ...(machine.skippedReason ? { skippedReason: machine.skippedReason } : {}),
    };
  }
}
