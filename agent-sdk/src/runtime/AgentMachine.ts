import type { Ctx, Outcome, Workflow, Identity, EffectHandler, DeliveryWriteKeys } from '../types.js';
import { runtimeLog } from '../shared/runtimeLog.js';
import { applyOutcomeToCtx, outcomeFromEvent, type RawEvent } from './buildOutcome.js';
import type { runTurn as RunTurnFn } from './runTurn.js';
import { runMechanical } from './runMechanical.js';
import { PromptBuilder } from './PromptBuilder.js';
import { bootstrapCtx } from './bootstrapCtx.js';
import type { MemoryStore } from '../memory/MemoryStore.js';
import type { ToolManager } from '../tools/ToolManager.js';

export interface MachineSnapshot {
  value: string;
  ctx: Ctx;
  status: 'active' | 'stopped';
}

export type TransitionEvent =
  | { kind: 'transition'; fromState: string; toState: string; outcomeKind: string; depth: number }
  | { kind: 'no-match'; state: string; outcomeKind: string; depth: number }
  | { kind: 'depth-guard'; state: string; depth: number }
  | { kind: 'turn-budget-guard'; state: string; turns: number }
  | { kind: 'error-escape'; fromState: string; toState: string }
  | { kind: 'unmatched-escape'; fromState: string; toState: string }
  | { kind: 'timeout-unhandled'; state: string; waitedMs: number };

/**
 * Max thinking turns a session may run without any human (USER) input before it
 * is treated as a runaway loop and parked. The depth-guard only bounds
 * re-entries within a single event chain; this bounds turns ACROSS events, which
 * is how a supervising session ran 436 turns in a day. The counter resets on
 * every USER frame, so human-driven conversations are never affected — only
 * autonomous agent↔agent loops accumulate toward it.
 */
const DEFAULT_MAX_TURNS_WITHOUT_USER_INPUT = 100;

interface MachineInput {
  identity: Identity;
  /** Server-provided ctx for an existing session. If omitted, a fresh ctx is built. */
  ctx?: Ctx;
  /** Server-provided state name for an existing session. Defaults to workflow.initial. */
  state?: string;
}

interface MachineOptions {
  workflow: Workflow;
  executionCore: typeof RunTurnFn;
  /** Side channel for all I/O. Provided by the Server. */
  eff: EffectHandler;
  /** Pure tool metadata (schemas, flags). Owned by the Agent. */
  toolManager: ToolManager;
  promptBuilder: PromptBuilder;
  /** Agent-private long-term memory. Operator-provided. */
  memory?: MemoryStore;
  input: MachineInput;
  /** Optional tap for FSM transition events — called synchronously on each transition. */
  transitionTap?: (event: TransitionEvent) => void;
  /** Runaway-loop backstop: max thinking turns without human input before parking. Default 100. */
  maxTurnsWithoutUserInput?: number;
  /** This wake's replay-stable write keys — one stream shared by every turn of the tick. */
  writeKeys?: DeliveryWriteKeys;
}

interface IncomingFrame {
  event?: RawEvent;
  identity?: Identity;
}

type Subscriber = (snapshot: MachineSnapshot) => void;

/**
 * Per-lane interpreter. Holds (current state name, Ctx). Re-entry is the
 * single primitive: every external event and every turn produces exactly
 * one Outcome that re-enters the current state.
 *
 * Parked states stop on entry. Thinking states run an LLM turn → produce an
 * outcome → re-enter. Transitions are evaluated against the new outcome
 * (first matching `when` wins; no `when` is fallthrough).
 *
 * `_running` guards against concurrent turns on the same machine — outer
 * runtime is expected to serialize via EventQueue, but we belt-and-suspenders.
 */
export class AgentMachine {
  workflow: Workflow;
  executionCore: typeof RunTurnFn;
  eff: EffectHandler;
  toolManager: ToolManager;
  promptBuilder: PromptBuilder;
  memory?: MemoryStore;
  writeKeys?: DeliveryWriteKeys;
  state: string;
  status: 'active' | 'stopped' = 'active';
  ctx: Ctx;
  _running = false;
  _subscribers = new Set<Subscriber>();
  _prevSnapshot: MachineSnapshot | null = null;
  _pendingFrames: IncomingFrame[] = [];
  _draining = false;
  _llmCalls = 0;
  _tokens = { total: 0, input: 0, output: 0 };
  /** Last turn skipped the model; host records a no-op naming why. */
  _skippedReason: string | undefined;
  _lastUserSenderId: string | null = null;
  _stateTimeoutUnhandled = false;
  _transitionTap: ((event: TransitionEvent) => void) | undefined;
  /** Thinking turns run since the last human (USER) frame. Reset on USER input. */
  _turnsSinceUserInput = 0;
  _maxTurnsWithoutUserInput: number;

  get llmCalls(): number { return this._llmCalls; }
  get tokens(): { total: number; input: number; output: number } { return this._tokens; }
  get skippedReason(): string | undefined { return this._skippedReason; }
  get stateTimeoutUnhandled(): boolean { return this._stateTimeoutUnhandled; }

  constructor({ workflow, executionCore, eff, toolManager, promptBuilder, memory, input, transitionTap, maxTurnsWithoutUserInput, writeKeys }: MachineOptions) {
    this.workflow = workflow;
    this.executionCore = executionCore;
    this.eff = eff;
    this.toolManager = toolManager;
    this.promptBuilder = promptBuilder;
    this.memory = memory;
    this.writeKeys = writeKeys;
    this._transitionTap = transitionTap;
    this._maxTurnsWithoutUserInput = maxTurnsWithoutUserInput ?? DEFAULT_MAX_TURNS_WITHOUT_USER_INPUT;
    this.state = input.state || workflow.initial;
    this.ctx = bootstrapCtx(input.identity, input.ctx);
  }

  getSnapshot(): MachineSnapshot {
    return { value: this.state, ctx: this.ctx, status: this.status };
  }

  /** Parked = currently in a parked state and not executing a turn. */
  get isParked(): boolean {
    if (this._running) return false;
    const sd = this.workflow.states[this.state];
    return sd?.kind === 'parked';
  }

  subscribe(fn: Subscriber): { unsubscribe: () => void } {
    this._subscribers.add(fn);
    return { unsubscribe: () => this._subscribers.delete(fn) };
  }

  /**
   * Process an incoming wire event: convert to outcome → apply to ctx →
   * evaluate current state's transitions → re-enter or stop.
   *
   * Serialized via a single-slot queue: if a turn is already in flight, the
   * frame is held until the running turn settles, then drained. Without this,
   * an inbound event mid-turn re-entered _step with a stale state and a hot
   * `_running=true`, which spawned overlapping turns and re-created the
   * clarifyingDuringApproval feedback loop even after fixing the workflow
   * fall-through.
   */
  async send(frame: IncomingFrame): Promise<void> {
    if (this.status !== 'active') return;
    this._pendingFrames.push(frame);
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._pendingFrames.length) {
        const next = this._pendingFrames.shift()!;
        await this._handleFrame(next);
      }
    } finally {
      this._draining = false;
    }
  }

  async _handleFrame(frame: IncomingFrame): Promise<void> {
    if (this.status !== 'active') return;
    if (frame.identity) this.ctx.identity = frame.identity;

    const ev = frame.event;
    this._lastIncomingEvent = ev ?? null;
    if (ev?.senderId && String(ev?.senderType ?? '').toUpperCase() === 'USER') {
      this._lastUserSenderId = String(ev.senderId);
      // Human input is real progress — reset the runaway-loop budget.
      this._turnsSinceUserInput = 0;
    }
    runtimeLog.debug(
      'FSM',
      `_handleFrame ev.type=${ev?.type} ev.senderId=${ev?.senderId} ev.receiverId=${ev?.receiverId} myId=${this.ctx.identity?.agentId}`,
    );
    const outcome = outcomeFromEvent(ev, this.ctx.identity.agentId);

    // `outcomeFromEvent` never returns null — it falls back to `{ kind: 'enter' }`
    // when all events in a batch are no-ops (resource_changed, self-echo, etc.).
    // If a real raw event produced `enter`, that means the event carried no
    // meaningful signal for the FSM, so skip it entirely.  Without this guard
    // `idle`'s unconditional `{ to: 'understanding' }` transition fires on every
    // resource_changed wake-up, kicking off an LLM turn that sends a duplicate
    // message, which triggers another resource_changed, and so on.
    if (ev && outcome.kind === 'enter') return;

    // Proposer detection must read pendingProposalAgreementId BEFORE
    // applyOutcomeToCtx clears it on resolution (buildOutcome.ts). Wire frames
    // carry no trustworthy proposer field — agreement_lifecycle drops `parties`
    // in normalizeIncomingEvent, and parties.creator is a principal id, not an
    // agentId (backend) — so the SDK's own "I made this proposal"
    // memory is the signal. Side effect we rely on: the first resolution clears
    // the pending id, so duplicate approval frames compute proposedByMe=false
    // and can never double-kickoff.
    if (outcome.kind === 'proposal-resolved') {
      outcome.proposedByMe =
        this.ctx.pendingProposalAgreementId !== null &&
        outcome.proposal.agreementId === this.ctx.pendingProposalAgreementId;
    }

    applyOutcomeToCtx(this.ctx, outcome);
    await this._step(outcome);
  }

  /**
   * Give up on a wedged state and go back to listening.
   *
   * Both runaway guards used to just `return`, which left `this.state` AT the
   * state that had run away. Parking inside a thinking state is not parking —
   * it is a lane stuck in a room whose transitions were written for one
   * occasion, so every later event is evaluated against the wrong state and
   * anything that state does not route is swallowed. Measured: three lab
   * workers tripped the depth guard inside the injected `claimKickingOff`
   * greeting; `claimKickingOff` has no `task-assigned` route, so the task wake
   * that arrived next was dropped and three graph nodes were never worked at
   * all. The greeting is best-effort; the work is not.
   *
   * The initial state is the one the author wrote to receive anything, so it is
   * the only safe place to land.
   */
  private _parkAtInitial(): void {
    const initial = this.workflow.initial;
    if (this.state !== initial) {
      runtimeLog.warn('AgentMachine', `recovering wedged state=${this.state} → ${initial}`);
      this.state = initial;
    }
    this._notify();
  }

  async _step(outcome: Outcome, depth = 0): Promise<void> {
    const fromState = this.state;
    const target = this._evaluateTransitions(outcome);
    const o = outcome as Record<string, unknown>;
    runtimeLog.debug(
      'FSM',
      `_step from=${fromState} outcome.kind=${o?.kind} senderId=${o?.senderId ?? '<none>'} myId=${this.ctx.identity?.agentId ?? '<none>'} → target=${target ?? '(stay)'} depth=${depth}`,
    );
    if (target && target !== this.state) {
      this._transitionTap?.({ kind: 'transition', fromState, toState: target, outcomeKind: (outcome as Record<string, unknown>).kind as string, depth });
      this.state = target;
      this._notify();
    }

    // A state-timeout only enters at depth 0 (host-armed frame via _handleFrame;
    // turns cannot produce it — validateWorkflow rejects produces:'state-timeout').
    // No matching transition = the author declared timeoutMs but no route: park
    // loudly and tell the host not to re-arm (re-arming would error every
    // timeoutMs forever). Next real event still recovers the lane. A matched
    // transition (target !== null) — including an explicit self-loop — is
    // "handled" and re-arms as a heartbeat.
    if (outcome.kind === 'state-timeout' && depth === 0 && !target) {
      this._stateTimeoutUnhandled = true;
      runtimeLog.error(
        'AgentMachine',
        `state=${this.state} timed out after ${outcome.waitedMs}ms but no transition matches { kind: 'state-timeout' } — parking without a timer. Add a state-timeout transition to "${this.state}" or remove timeoutMs.`,
      );
      this._transitionTap?.({ kind: 'timeout-unhandled', state: this.state, waitedMs: outcome.waitedMs });
      this._notify();
      return;
    }

    const sd = this.workflow.states[this.state];
    if (!sd) return;
    if (sd.kind === 'parked') {
      runtimeLog.debug('FSM', `_step parked state=${this.state} — exit`);
      // Notify so runtime detects park and resolves the wait promise.
      this._notify();
      return;
    }

    if (sd.kind === 'mechanical') {
      if (depth >= 12) {
        runtimeLog.warn(
          'AgentMachine',
          `state=${this.state} runaway mechanical loop (depth=${depth}); parking`,
        );
        this._transitionTap?.({ kind: 'depth-guard', state: this.state, depth });
        await this._sendFallbackIfUserWaiting('Something went wrong. Please try again.');
        this._parkAtInitial();
        return;
      }
      if (this._turnsSinceUserInput >= this._maxTurnsWithoutUserInput) {
        runtimeLog.warn(
          'AgentMachine',
          `state=${this.state} runaway loop: ${this._turnsSinceUserInput} turns without user input (cap ${this._maxTurnsWithoutUserInput}); parking`,
        );
        this._transitionTap?.({ kind: 'turn-budget-guard', state: this.state, turns: this._turnsSinceUserInput });
        await this._sendFallbackIfUserWaiting('I got stuck in a loop and paused. Please send another message to continue.');
        this._parkAtInitial();
        return;
      }
      runtimeLog.debug('FSM', `_step mechanical state=${this.state} — run tool`);
      this._running = true;
      try {
        const { outcome: turnOutcome, toolResults, llmCalls, tokens } = await runMechanical({
          stateId: this.state,
          state: sd,
          ctx: this.ctx,
          eff: this.eff,
          memory: this.memory,
          incomingEvent: this._lastIncomingEvent,
          writeKeys: this.writeKeys,
        });
        this.ctx.toolResults = toolResults;
        this._llmCalls += llmCalls;
        this._turnsSinceUserInput += 1;
        this._tokens.total += tokens.total;
        this._tokens.input += tokens.input;
        this._tokens.output += tokens.output;
        applyOutcomeToCtx(this.ctx, turnOutcome);
        this._running = false;
        this._notify();
        await this._step(turnOutcome, depth + 1);
      } catch (error: unknown) {
        await this._recoverFromTurnError(error, 'mechanical');
      }
      return;
    }

    // A thinking turn that yields an outcome no transition handles must not
    // silently re-enter the same state and burn another LLM call, and must
    // not stay IN that thinking state — the next event would be judged by
    // transitions written for a different occasion. Explicit
    // self-loops still match (target is non-null, even if target === state).
    if (
      sd.kind === 'thinking' &&
      depth > 0 &&
      fromState === this.state &&
      !target
    ) {
      this._transitionTap?.({
        kind: 'no-match',
        state: fromState,
        outcomeKind: (outcome as Record<string, unknown>).kind as string,
        depth,
      });
      if (await this._escapeToInitialParked(outcome, fromState)) return;
      runtimeLog.warn(
        'AgentMachine',
        `state=${fromState} outcome.kind=${(outcome as Record<string, unknown>).kind} matched no transition; parking (depth=${depth})`,
      );
      await this._sendFallbackIfUserWaiting('Something went wrong. Please try again.');
      this._notify();
      return;
    }

    // Recursion / runaway-turn guard. Without this, a thinking state whose
    // transitions don't match the turn outcome (e.g. `delegating` not
    // catching `tool-result` from an agent_network search) re-enters the
    // same state forever — the LLM keeps re-rolling search/dummy actions
    // until something accidentally matches, burning tokens and emitting
    // duplicate side effects (ziggs ran `discoverSpecialist` six
    // times before finally invoking `delegate`). 12 is well above any
    // legitimate same-state turn chain we exercise in tests; if we trip
    // it, treat the state as wedged and park.
    if (depth >= 12) {
      runtimeLog.warn(
        'AgentMachine',
        `state=${this.state} runaway turn loop (depth=${depth}); parking`,
      );
      this._transitionTap?.({ kind: 'depth-guard', state: this.state, depth });
      await this._sendFallbackIfUserWaiting('Something went wrong. Please try again.');
      this._parkAtInitial();
      return;
    }
    // Cross-event runaway guard. The depth-guard above only bounds
    // one event chain; a supervising session that keeps waking on agent/system
    // messages re-enters at depth 0 each time and never trips it. Bound the
    // total thinking turns since the last human input instead — a runaway
    // agent↔agent loop climbs toward the cap while a human conversation resets
    // it on every user message.
    if (this._turnsSinceUserInput >= this._maxTurnsWithoutUserInput) {
      runtimeLog.warn(
        'AgentMachine',
        `state=${this.state} runaway loop: ${this._turnsSinceUserInput} turns without user input (cap ${this._maxTurnsWithoutUserInput}); parking`,
      );
      this._transitionTap?.({ kind: 'turn-budget-guard', state: this.state, turns: this._turnsSinceUserInput });
      await this._sendFallbackIfUserWaiting('I got stuck in a loop and paused. Please send another message to continue.');
      this._parkAtInitial();
      return;
    }
    runtimeLog.debug('FSM', `_step thinking state=${this.state} — run turn`);

    // Thinking: run a turn, produce an outcome, re-step.
    this._running = true;
    try {
      const { outcome: turnOutcome, toolResults, llmCalls, tokens, skippedReason } = await this.executionCore({
        stateId: this.state,
        statePrompt: sd.prompt,
        actions: sd.actions,
        incomingEvent: this._lastIncomingEvent,
        ctx: this.ctx,
        eff: this.eff,
        toolManager: this.toolManager,
        promptBuilder: this.promptBuilder,
        memory: this.memory,
        definition: this.workflow,
        writeKeys: this.writeKeys,
      });

      this.ctx.toolResults = toolResults;
      this._llmCalls += llmCalls;
      if (skippedReason) this._skippedReason = skippedReason;
      this._turnsSinceUserInput += 1;
      this._tokens.total += tokens.total;
      this._tokens.input += tokens.input;
      this._tokens.output += tokens.output;
      applyOutcomeToCtx(this.ctx, turnOutcome);
      this._running = false;
      this._notify();

      await this._step(turnOutcome, depth + 1);
    } catch (error: unknown) {
      await this._recoverFromTurnError(error, 'thinking');
    }
  }

  /**
   * A turn threw. Route the error through the state's transitions; if none
   * takes it, recover to workflow.initial so the next event is not judged by
   * transitions written for this state.
   *
   * One method for thinking and tool (mechanical) states. The recovery used to
   * live only in the thinking copy, so a tool state that threw with no error
   * route stayed put and judged the next event as itself.
   */
  async _recoverFromTurnError(
    error: unknown,
    kind: 'thinking' | 'mechanical',
  ): Promise<void> {
    runtimeLog.error(
      'AgentMachine',
      `${kind === 'mechanical' ? 'mechanical ' : ''}state=${this.state} error: ${(error as Error)?.message || error}`,
    );
    const errOutcome: Outcome = {
      kind: 'error',
      source: 'unknown',
      cause: (error as Error)?.message || String(error),
      retryable: false,
    };
    applyOutcomeToCtx(this.ctx, errOutcome);
    this._running = false;
    this._notify();
    const fallback = this._evaluateTransitions(errOutcome);
    if (fallback && fallback !== this.state) {
      this.state = fallback;
      this._notify();
    } else {
      await this._sendFallbackIfUserWaiting('Something went wrong. Please try again.');
      this._parkAtInitial();
    }
  }

  /**
   * Unmatched thinking outcome: go back to workflow.initial when that state is
   * parked. Used to require an error outcome, so a tool-result /
   * message-sent / wait with no route logged "parking" and left `this.state`
   * on the thinking state. The next event then ran a turn against prompts
   * written for the previous occasion.
   */
  async _escapeToInitialParked(outcome: Outcome, fromState: string): Promise<boolean> {
    const initial = this.workflow.initial;
    const initialSd = this.workflow.states[initial];
    if (!initialSd || initialSd.kind !== 'parked' || initial === fromState) {
      return false;
    }
    const kind = (outcome as Record<string, unknown>).kind;
    runtimeLog.warn(
      'AgentMachine',
      `state=${fromState} unmatched ${String(kind)} — escaped to parked initial "${initial}"`,
    );
    this._transitionTap?.({
      kind: kind === 'error' ? 'error-escape' : 'unmatched-escape',
      fromState,
      toState: initial,
    });
    this.state = initial;
    await this._sendFallbackIfUserWaiting('Something went wrong. Please try again.');
    this._notify();
    return true;
  }

  /** Sends a short fallback to the last known human user when the machine parks unexpectedly. Best-effort — never throws. */
  async _sendFallbackIfUserWaiting(text: string): Promise<void> {
    const userId = this._lastUserSenderId;
    if (!userId) return;
    try {
      // Content-derived wake messageId: a crash-replay that errors
      // the same way parks again and re-sends this apology — same key, backend
      // drops the dupe.
      const sessionId = this.ctx.identity.sessionId;
      await this.eff({
        kind: 'send-message',
        sessionId,
        receiverId: userId,
        text,
        messageId: this.writeKeys?.messageKey({ text, sessionId, receiverId: userId }),
      });
    } catch { /* best-effort */ }
  }

  _evaluateTransitions(outcome: Outcome): string | null {
    const sd = this.workflow.states[this.state];
    if (!sd?.transitions?.length) {
      runtimeLog.debug('FSM', `evaluate state=${this.state}: NO TRANSITIONS DEFINED`);
      return null;
    }
    for (let i = 0; i < sd.transitions.length; i++) {
      const rule = sd.transitions[i]!;
      let matched: boolean;
      let err: unknown = null;
      if (!rule.when) {
        matched = true;
      } else {
        try { matched = !!rule.when(outcome, this.ctx); }
        catch (e) { matched = false; err = e; }
      }
      runtimeLog.debug(
        'FSM',
        `evaluate state=${this.state} rule[${i}] to=${rule.to} when=${rule.when ? 'fn' : 'always'} → ${matched}${err ? ` ERR=${(err as Error).message}` : ''}`,
      );
      if (matched) return rule.to;
    }
    runtimeLog.debug('FSM', `evaluate state=${this.state}: NONE matched`);
    return null;
  }

  _notify(): void {
    const snapshot = this.getSnapshot();
    for (const fn of this._subscribers) {
      try { fn(snapshot); } catch {}
    }
  }

  // Held so PromptBuilder/runTurn can render the original wire event in <event>.
  // Set by the runtime layer when it calls send(); we don't classify it twice.
  _lastIncomingEvent: RawEvent | null = null;
}
