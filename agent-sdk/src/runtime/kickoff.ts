import type { Outcome, State, ThinkingState, Transition, Workflow } from '../types.js';
import { thinkingDefaults } from './defaults.js';
import { PROBE_CTX } from './validateWorkflow.js';
import { hasDelegatedAgreement, hasOpenTaskForAgreement } from './taskBookkeeping.js';

/** Reserved state name for the injected agreement-kickoff default (proposer). */
export const KICKOFF_STATE = 'kickingOff';

// Synthetic outcome used to ask "does this state already handle a proposer-side
// approval?" — the same probe pattern validateWorkflow uses for the wait/error
// fallthrough checks.
const PROBE_APPROVE: Outcome = {
  kind: 'proposal-resolved',
  action: 'approve',
  proposal: { agreementId: '__kickoff_probe__' },
  proposedByMe: true,
};

const KICKOFF_TRANSITION: Transition = {
  to: KICKOFF_STATE,
  when: (o, ctx) =>
    o.kind === 'proposal-resolved' &&
    o.action === 'approve' &&
    o.proposedByMe === true &&
    // "first task" guard — both branches cover one exact scenario: a task under
    // THIS agreement already exists because a racing task_result frame was
    // applied to ctx before this approval frame.
    // (1) we already delegated under it (any engagement book):
    !hasDelegatedAgreement(ctx, o.proposal.agreementId) &&
    // (2) we already hold an assigned task bound to it:
    !hasOpenTaskForAgreement(ctx, o.proposal.agreementId),
};

// A state "handles" proposer-approval if some transition would fire for it.
// An unconditional (when-less) transition counts: it catches every outcome,
// so the kickoff transition — appended LAST — would be unreachable dead code
// there anyway. Consequence to know: a state whose only route for a
// proposal-resolved/approve is an unconditional fallthrough to an UNRELATED
// state will NOT auto-kickoff (the approval follows the fallthrough instead).
// Authors who want guaranteed kickoff in such a state must add an explicit
// `when: o => o.kind === 'proposal-resolved' && o.action === 'approve'`
// transition (which this probe then respects) — or route approval into a
// thinking state that spawns the task itself.
function stateHandlesProposerApproval(state: State): boolean {
  return state.transitions.some(t => {
    if (!t.when) return true;
    try { return !!t.when(PROBE_APPROVE, PROBE_CTX); }
    catch { return false; }
  });
}

export function buildKickoffState(initial: string): ThinkingState {
  const dflt = thinkingDefaults({ initial });
  return {
    kind: 'thinking',
    prompt: {
      role: 'The counterparty just approved an agreement you proposed. The platform never auto-starts work — as the proposer, you spawn the first task now.',
      goal: 'Spawn exactly one task under the just-approved agreement so work begins.',
      constraints:
        'The approved agreement id is in <event> and as activeAgreementId in <machine_context>; the agreement row is in <agreements>. Call task_create with that agreementId and a description of the concrete work the agreement covers. Include ALL specifics the counterparty provided in <history> (addresses, quantities, times, item names, deliverables) — the executor has no other way to get them. Plain natural language, no step numbering. Do not re-negotiate — the agreement is active. Do not send a chat message instead of spawning. If <agreements> or <history> show a task already running under this agreement, choose wait.',
    },
    actions: {
      ...dflt.actions,
      spawnFirstTask: {
        prompt: {
          when: 'Always — this state exists only to spawn the first task under the agreement whose proposal was just approved. Pick wait only if a task already exists under it.',
          instruction: 'Spawn the first task under the approved agreement so work starts.',
          format: '{"agreementId": "<the agreement whose proposal was just approved>", "description": "<concrete work + all counterparty specifics from history>"}',
        },
        tool: 'task_create',
        // Function form so a failed task_create surfaces as an error outcome
        // (→ dflt error transition + machine warn log) instead of a fake
        // task-delegated with an empty task.
        produces: (result) => {
          const r = result as { taskId?: string; task?: { taskId?: string } } | undefined;
          return r?.taskId || r?.task?.taskId ? 'task-delegated' : 'error';
        },
        terminatesLoop: true,
      },
    },
    transitions: [
      { to: initial, when: o => o.kind === 'task-delegated' },
      ...dflt.transitions, // wait / message-sent / error → initial
    ],
  };
}

/**
 * Route a store-claim wake from this state to `to`. The SDK no longer greets
 * on a claim (a claim starts no conversation; the buyer writes first in the agreement's
 * conversation), so this is only for an author who wants to act on the claim
 * itself.
 *
 * It fires on a claim wake and NOT on a bare counterparty approve, which also
 * keeps it out of the way of the proposer-side kickoff.
 *
 *   transitions: [
 *     handlesClaimWake('idle'),   // a claim does not make this agent talk
 *     { to: 'idle', when: (o) => o.kind === 'proposal-resolved' && o.action === 'approve' },
 *   ]
 */
export function handlesClaimWake(to: string): Transition {
  return {
    to,
    when: (o) =>
      o.kind === 'proposal-resolved' && o.action === 'approve' && o.fromClaimWake === true,
  };
}

/**
 * Agreement-kickoff default. For every state whose transitions do not already
 * handle a proposer-side approval, append a transition to the injected
 * `kickingOff` state, which spawns the first task. Appended LAST: the approval
 * is of a proposal THIS agent made, so a route its author wrote keeps winning.
 * Returns a NEW workflow; input states are not mutated.
 *
 * Counterparties never auto-kickoff, and neither does a store claim: a claim
 * starts no conversation, and the buyer's first message or task is what wakes the
 * provider.
 */
export function injectKickoffDefault(workflow: Workflow): Workflow {
  if (workflow.states[KICKOFF_STATE]) {
    throw new Error(
      `[defineAgent] state name "${KICKOFF_STATE}" is reserved for the injected agreement-kickoff default — rename the state`,
    );
  }
  const states: Record<string, State> = {};
  let injected = false;
  for (const [name, state] of Object.entries(workflow.states)) {
    if (stateHandlesProposerApproval(state)) {
      states[name] = state;
      continue;
    }
    states[name] = { ...state, transitions: [...state.transitions, KICKOFF_TRANSITION] } as State;
    injected = true;
  }
  if (!injected) return workflow;
  states[KICKOFF_STATE] = buildKickoffState(workflow.initial);
  return { ...workflow, states };
}
