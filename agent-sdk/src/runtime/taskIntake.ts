import type { Outcome, State, ThinkingState, Transition, Workflow } from '../types.js';
import { thinkingDefaults } from './defaults.js';
import { CLAIM_KICKOFF_STATE, KICKOFF_STATE } from './kickoff.js';
import { PROBE_CTX } from './validateWorkflow.js';

/** Reserved state name for the injected assigned-task-intake default. */
export const TASK_INTAKE_STATE = 'workingAssignedTask';

// Synthetic outcome used to ask "does this state already route an assigned
// task?" — same probe pattern as kickoff.ts / validateWorkflow.
const PROBE_TASK_ASSIGNED: Outcome = {
  kind: 'task-assigned',
  task: { taskId: '__task_intake_probe__' },
};

const TASK_INTAKE_TRANSITION: Transition = {
  to: TASK_INTAKE_STATE,
  when: o => o.kind === 'task-assigned',
};

// A state "handles" task-assigned if some transition would fire for it. An
// unconditional (when-less) transition counts — it catches every outcome, so
// the intake transition appended LAST would be unreachable there anyway.
function stateHandlesTaskAssigned(state: State): boolean {
  return state.transitions.some(t => {
    if (!t.when) return true;
    try { return !!t.when(PROBE_TASK_ASSIGNED, PROBE_CTX); }
    catch { return false; }
  });
}

export function buildTaskIntakeState(initial: string): ThinkingState {
  const dflt = thinkingDefaults({ initial });
  return {
    kind: 'thinking',
    prompt: {
      role: 'A task was just assigned to you under one of your active agreements, and your workflow has no explicit route for it. This injected default exists so an assigned task is NEVER silently dropped — under a standing hire, new tasks keep arriving for the lifetime of the agreement.',
      goal: 'Resolve the assigned task this turn: deliver the result if you can produce it, otherwise fail it with a reason.',
      constraints:
        'The task is in <event> (and as activeTaskId / activeAgreementId in <machine_context>). If the deliverable can be produced in this turn (an answer, summary, plan, draft — most representation work), call task_set_result with state "completed" and the deliverable as result — the result is what the counterparty consumes, so make it the actual deliverable, not a status note. If the task genuinely needs abilities or tools you do not have, call task_set_result with state "failed" and a one-line reason — a visible failure the counterparty can re-route beats a silent drop. Never leave the task dangling or answer with a chat message alone.',
    },
    actions: {
      ...dflt.actions,
      completeTask: {
        prompt: {
          when: 'You can produce the deliverable for the assigned task in this turn.',
          instruction: 'Complete the assigned task, with the deliverable itself as the result.',
          format: '{"taskId": "<assigned task id from <event>>", "state": "completed", "result": "<the full deliverable>"}',
        },
        tool: 'task_set_result',
        // Function form so a failed task_set_result surfaces as an error outcome
        // (→ dflt error transition) instead of a phantom task-closed.
        produces: (result) => {
          // `state` only cut `status` from the wire.
          const r = result as
            | { task?: { state?: string }; state?: string }
            | undefined;
          const state = r?.task?.state ?? r?.state;
          return state === 'completed' || state === 'failed' ? 'task-closed' : 'error';
        },
        terminatesLoop: true,
      },
      failTask: {
        prompt: {
          when: 'The task needs abilities, tools, or information you cannot obtain this turn.',
          instruction: 'Fail the assigned task with a one-line reason so the counterparty can re-route it.',
          format: '{"taskId": "<assigned task id from <event>>", "state": "failed", "result": "<one-line reason>"}',
        },
        tool: 'task_set_result',
        produces: (result) => {
          // `state` only cut `status` from the wire.
          const r = result as
            | { task?: { state?: string }; state?: string }
            | undefined;
          const state = r?.task?.state ?? r?.state;
          return state === 'completed' || state === 'failed' ? 'task-closed' : 'error';
        },
        terminatesLoop: true,
      },
    },
    transitions: [
      { to: initial, when: o => o.kind === 'task-closed' },
      ...dflt.transitions, // wait / message-sent / error → initial
    ],
  };
}

/**
 * Assigned-task-intake default — the task-side twin of the agreement-kickoff
 * default (kickoff.ts). For every state whose transitions do not already match
 * a task-assigned outcome, append a transition to the injected
 * `workingAssignedTask` state. Appended LAST so any user transition on the
 * same outcome always wins (first match wins in
 * AgentMachine._evaluateTransitions). Returns a NEW workflow — input states
 * are not mutated.
 *
 * Why: a standing hire receives task #2, #3, … months after approval. Without
 * this default a parked state with no task-assigned route (e.g. a hire parked
 * in `engaged`) swallowed the wake and the task sat active forever.
 */
export function injectTaskIntakeDefault(workflow: Workflow): Workflow {
  if (workflow.states[TASK_INTAKE_STATE]) {
    throw new Error(
      `[defineAgent] state name "${TASK_INTAKE_STATE}" is reserved for the injected assigned-task-intake default — rename the state`,
    );
  }
  const states: Record<string, State> = {};
  let injected = false;
  for (const [name, state] of Object.entries(workflow.states)) {
    // Injected defaults never feed each other: the kickoff state's own lack of
    // a task-assigned route must not force the intake state into a workflow
    // whose author states all handle assignment.
    if (
      name === KICKOFF_STATE ||
      name === CLAIM_KICKOFF_STATE ||
      stateHandlesTaskAssigned(state)
    ) {
      states[name] = state;
      continue;
    }
    states[name] = { ...state, transitions: [...state.transitions, TASK_INTAKE_TRANSITION] } as State;
    injected = true;
  }
  if (!injected) return workflow; // every state routes task-assigned — nothing to add
  states[TASK_INTAKE_STATE] = buildTaskIntakeState(workflow.initial);
  return { ...workflow, states };
}
