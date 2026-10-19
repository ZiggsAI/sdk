import type { Action, Ctx, MechanicalState, Outcome, Produces, Transition, ThinkingState } from '../types.js';

/**
 * Defaults that workflow authors spread into thinking states explicitly.
 * No auto-injection — what you read in the file is what runs.
 *
 *   const dflt = thinkingDefaults({ initial: 'idle' });
 *
 *   listening: {
 *     kind: 'thinking',
 *     ...dflt,
 *     prompt: { .. },
 *     actions: { ...dflt.actions, greetUser: { .. } },
 *     transitions: [
 *       { to: 'executing', when: o => o.kind === 'task-assigned' },
 *       ...dflt.transitions,
 *     ],
 *   }
 */
export interface ThinkingDefaults {
  actions: Record<string, Action>;
  transitions: Transition[];
}

export const DEFAULT_WAIT_PROMPT = Object.freeze({
  instruction: 'Do nothing - wait for the next event.',
  when: 'No action is needed, you are waiting for external input, or you should pause without repeating yourself.',
  format: '{"thought": "...", "action": "wait"}',
});

export function thinkingDefaults(opts: { initial: string }): ThinkingDefaults {
  const { initial } = opts;
  return {
    actions: {
      wait: {
        prompt: { ...DEFAULT_WAIT_PROMPT },
        produces: 'wait',
      },
    },
    transitions: [
      { to: initial, when: o => o.kind === 'wait' },
      { to: initial, when: o => o.kind === 'message-sent' },
      // Errors (empty/failed turns) fall back to the initial state instead of
      // silently re-entering and recursing until the depth guard.
      { to: initial, when: o => o.kind === 'error' },
    ],
  };
}

/**
 * Convenience builder for a `thinking` state that always carries the defaults.
 * Equivalent to spreading manually but the spread points are in one place.
 *
 *   defineThinkingState({ initial: 'idle' }, {
 *     prompt: { .. },
 *     actions: { greetUser: { .. } },
 *     transitions: [ { to: 'executing', when: o => o.kind === 'task-assigned' } ],
 *   })
 */
export function defineThinkingState(
  opts: { initial: string },
  state: Omit<ThinkingState, 'kind' | 'actions' | 'transitions'> & {
    actions: Record<string, Action>;
    transitions: Transition[];
  }
): ThinkingState {
  const dflt = thinkingDefaults(opts);
  return {
    kind: 'thinking',
    prompt: state.prompt,
    allowNoWait: state.allowNoWait,
    actions: { ...dflt.actions, ...state.actions },
    transitions: [...state.transitions, ...dflt.transitions],
  };
}

/** mechanical state — one tool call, zero LLM turns. */
export function defineMechanicalState(state: {
  tool: string;
  args?: Record<string, unknown>;
  buildArgs?: (ctx: Ctx, outcome: Outcome) => Record<string, unknown>;
  produces: Produces;
  transitions: Transition[];
}): MechanicalState {
  return { kind: 'mechanical', ...state };
}
