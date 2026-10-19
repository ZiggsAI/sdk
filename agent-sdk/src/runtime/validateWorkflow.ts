import type { Ctx, OutcomeKind, Workflow, ThinkingState, ParkedState, MechanicalState } from '../types.js';
import { bootstrapCtx } from './bootstrapCtx.js';

/** Static probe ctx for evaluating transition `when` guards during validation. */
export const PROBE_CTX: Ctx = bootstrapCtx({ agentId: '', sessionId: '', laneKey: '' });

// 'state-timeout' and 'wake-at' are intentionally absent: both are
// runtime-generated — the first from a parked state's liveness bound, the
// second from the wake_at tool — and never something an action's
// `produces` may declare.
const KNOWN_OUTCOME_KINDS = new Set<OutcomeKind>([
  'enter',
  'wait',
  'message-sent',
  'message-received',
  'task-assigned',
  'task-delegated',
  'task-closed',
  'subtask-finished',
  'proposal-made',
  'proposal-resolved',
  'tool-result',
  'error',
  'extension',
]);

export class WorkflowValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Workflow validation failed:\n  - ${issues.join('\n  - ')}`);
    this.name = 'WorkflowValidationError';
    this.issues = issues;
  }
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Synchronous structural validation. Errors throw; warnings are returned for
 * the caller to log. defineAgent runs this on construction, so misconfigured
 * workflows fail loudly at load instead of mysteriously misbehaving at runtime.
 */
export function validateWorkflow(workflow: Workflow): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!workflow || typeof workflow !== 'object') {
    throw new WorkflowValidationError(['workflow must be an object']);
  }
  if (!workflow.id) errors.push('workflow.id is required');
  if (!workflow.initial) errors.push('workflow.initial is required');
  if (!workflow.states || typeof workflow.states !== 'object') {
    errors.push('workflow.states is required');
  }

  if (errors.length) throw new WorkflowValidationError(errors);

  const stateNames = new Set(Object.keys(workflow.states));
  if (!stateNames.has(workflow.initial)) {
    errors.push(`workflow.initial "${workflow.initial}" is not a defined state`);
  }

  for (const [name, state] of Object.entries(workflow.states)) {
    if (!state || typeof state !== 'object') {
      errors.push(`state "${name}" is not an object`);
      continue;
    }
    if (state.kind !== 'parked' && state.kind !== 'thinking' && state.kind !== 'mechanical') {
      errors.push(`state "${name}" must declare kind: 'parked' | 'thinking' | 'mechanical'`);
      continue;
    }

    // Shape rejects mixing
    if (state.kind === 'parked') {
      if ((state as unknown as ThinkingState).prompt) {
        errors.push(`state "${name}" is parked but has a prompt — parked states are event-driven only`);
      }
      if ((state as unknown as ThinkingState).actions) {
        errors.push(`state "${name}" is parked but has actions — parked states are event-driven only`);
      }
      const tm = (state as ParkedState).timeoutMs;
      if (tm !== undefined && (typeof tm !== 'number' || !Number.isFinite(tm) || tm <= 0)) {
        errors.push(`state "${name}" timeoutMs must be a finite number > 0 (got ${String(tm)})`);
      }
      if (typeof tm === 'number' && Number.isFinite(tm) && tm > 0) {
        const handled = state.transitions.some(t => {
          if (!t.when) return true;
          try { return t.when({ kind: 'state-timeout', state: name, waitedMs: tm }, PROBE_CTX); }
          catch { return false; }
        });
        if (!handled) {
          warnings.push(`parked state "${name}" declares timeoutMs=${tm} but no transition matches { kind: 'state-timeout' } — the timeout will park loudly (runtimeLog.error) instead of routing to a recovery state.`);
        }
      }
    }
    if (state.kind === 'thinking') {
      if (!state.prompt) errors.push(`thinking state "${name}" requires a prompt`);
      if (!state.actions || Object.keys(state.actions).length === 0) {
        errors.push(`thinking state "${name}" requires at least one action`);
      }
      if ((state as unknown as ParkedState).timeoutMs !== undefined) {
        errors.push(`state "${name}" is thinking but declares timeoutMs — liveness timers apply to parked states only (thinking turns are bounded by Agent tickTimeoutMs)`);
      }
    }
    if (state.kind === 'mechanical') {
      const mech = state as MechanicalState;
      if (!mech.tool || typeof mech.tool !== 'string') {
        errors.push(`mechanical state "${name}" requires a tool name`);
      }
      if (mech.buildArgs !== undefined && typeof mech.buildArgs !== 'function') {
        errors.push(`mechanical state "${name}" buildArgs must be a function`);
      }
      if ((mech as unknown as ThinkingState).prompt) {
        errors.push(`state "${name}" is mechanical but has a prompt — use kind: 'thinking' instead`);
      }
      if ((mech as unknown as ThinkingState).actions) {
        errors.push(`state "${name}" is mechanical but has actions — use kind: 'thinking' instead`);
      }
      const p = mech.produces;
      if (p === 'state-timeout' || p === 'wake-at') {
        errors.push(`mechanical state "${name}" produces "${p}" — reserved for runtime timers (wake-at is armed by the wake_at tool, never produced by a state)`);
      } else if (typeof p === 'string') {
        if (!KNOWN_OUTCOME_KINDS.has(p as OutcomeKind)) {
          errors.push(
            `mechanical state "${name}" produces unknown outcome kind "${p}" — use one of: ${[...KNOWN_OUTCOME_KINDS].join(', ')}`,
          );
        }
      } else if (typeof p !== 'function') {
        errors.push(`mechanical state "${name}" requires produces (OutcomeKind or fn)`);
      }
      // The same soft check thinking states get. A tool that throws
      // with no error route sends the agent back to its initial state.
      if (!hasErrorTransition(mech.transitions ?? [])) {
        warnings.push(
          `mechanical state "${name}" has no transition for { kind: 'error' } — a failed tool call sends the agent back to "${workflow.initial}". Add an error transition if it should go elsewhere.`,
        );
      }
    }

    if (!Array.isArray(state.transitions)) {
      errors.push(`state "${name}" requires a transitions array`);
      continue;
    }

    for (let i = 0; i < state.transitions.length; i++) {
      const t = state.transitions[i];
      if (!t || typeof t !== 'object') {
        errors.push(`state "${name}" transition[${i}] is not an object`);
        continue;
      }
      if (typeof t.to !== 'string') {
        errors.push(`state "${name}" transition[${i}] is missing string "to"`);
        continue;
      }
      if (!stateNames.has(t.to)) {
        errors.push(`state "${name}" transition[${i}] points to unknown state "${t.to}"`);
      }
      if (t.when !== undefined && typeof t.when !== 'function') {
        errors.push(`state "${name}" transition[${i}].when must be a function or omitted`);
      }
    }

    if (state.kind === 'thinking') {
      for (const [actionName, action] of Object.entries(state.actions)) {
        if (!action || typeof action !== 'object') {
          errors.push(`state "${name}" action "${actionName}" is not an object`);
          continue;
        }
        if (!action.prompt || !action.prompt.instruction) {
          errors.push(`state "${name}" action "${actionName}" requires prompt.instruction`);
        }
        const p = action.produces;
        if (p === 'state-timeout' || p === 'wake-at') {
          errors.push(`state "${name}" action "${actionName}" produces "${p}" — reserved for runtime timers; actions cannot produce it`);
        } else if (typeof p === 'string') {
          if (!KNOWN_OUTCOME_KINDS.has(p as OutcomeKind)) {
            errors.push(
              `state "${name}" action "${actionName}" produces unknown outcome kind "${p}" — use one of: ${[...KNOWN_OUTCOME_KINDS].join(', ')}`,
            );
          }
        } else if (typeof p !== 'function') {
          errors.push(`state "${name}" action "${actionName}" requires produces (OutcomeKind or fn)`);
        }
      }

      // Soft check: thinking state should have a wait action and a fallthrough.
      // Authors can opt out via allowNoWait when intentionally building a
      // looping or always-progressing state.
      if (!state.allowNoWait) {
        if (!state.actions?.wait) {
          warnings.push(
            `thinking state "${name}" has no "wait" action — did you forget to spread thinkingDefaults({ initial: '${workflow.initial}' })? Set allowNoWait: true to silence.`,
          );
        }
        const hasWaitFallthrough = state.transitions.some(t => {
          if (!t.when) return true;
          try { return t.when({ kind: 'wait' }, PROBE_CTX); }
          catch { return false; }
        });
        if (!hasWaitFallthrough) {
          warnings.push(
            `thinking state "${name}" has no fallthrough for { kind: 'wait' } — agent may stall when LLM picks wait. Spread thinkingDefaults().transitions or add explicitly.`,
          );
        }
        if (!hasErrorTransition(state.transitions)) {
          warnings.push(
            `thinking state "${name}" has no fallthrough for { kind: 'error' } — empty/failed turns may silently recurse until the depth guard. Add an error transition or spread thinkingDefaults().transitions.`,
          );
        }
      }
    }
  }

  if (errors.length) throw new WorkflowValidationError(errors);
  return { errors, warnings };
}

/** Does some transition take an error outcome? A guard that throws counts as no. */
function hasErrorTransition(
  transitions: ReadonlyArray<{ when?: (o: never, c: never) => boolean }>,
): boolean {
  return transitions.some((t) => {
    if (!t.when) return true;
    try {
      return (t.when as (o: unknown, c: unknown) => boolean)(
        { kind: 'error', source: 'unknown', cause: 'probe', retryable: false },
        PROBE_CTX,
      );
    } catch {
      return false;
    }
  });
}
