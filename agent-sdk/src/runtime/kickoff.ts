import type { Outcome, State, ThinkingState, Transition, Workflow } from '../types.js';
import { thinkingDefaults } from './defaults.js';
import { PROBE_CTX } from './validateWorkflow.js';
import { hasDelegatedAgreement, hasOpenTaskForAgreement } from './taskBookkeeping.js';

/** Reserved state name for the injected agreement-kickoff default (proposer). */
export const KICKOFF_STATE = 'kickingOff';

/**
 * reserved state for the injected claim/provider kickoff default.
 * Store listing claimed → open buyer chat + greet (not task_create).
 */
export const CLAIM_KICKOFF_STATE = 'claimKickingOff';

// Synthetic outcome used to ask "does this state already handle a proposer-side
// approval?" — the same probe pattern validateWorkflow uses for the wait/error
// fallthrough checks.
const PROBE_APPROVE: Outcome = {
  kind: 'proposal-resolved',
  action: 'approve',
  proposal: { agreementId: '__kickoff_probe__' },
  proposedByMe: true,
};

/** Probe for claim/provider kickoff — must NOT match direct-proposal approver. */
const PROBE_CLAIM_APPROVE: Outcome = {
  kind: 'proposal-resolved',
  action: 'approve',
  proposal: { agreementId: '__claim_kickoff_probe__' },
  proposedByMe: false,
  fromClaimWake: true,
};

/**
 * A bare counterparty approve — someone approved a proposal we did not make,
 * with no store claim behind it. Used as a NEGATIVE probe: a transition that
 * matches this as well as PROBE_CLAIM_APPROVE is a generic proposal-resolved
 * route, not a deliberate claim handler, so it does not suppress injection.
 */
const PROBE_BARE_APPROVE: Outcome = {
  kind: 'proposal-resolved',
  action: 'approve',
  proposal: { agreementId: '__bare_approve_probe__' },
  proposedByMe: false,
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

const CLAIM_KICKOFF_TRANSITION: Transition = {
  to: CLAIM_KICKOFF_STATE,
  when: (o, ctx) =>
    o.kind === 'proposal-resolved' &&
    o.action === 'approve' &&
    o.proposedByMe === false &&
    o.fromClaimWake === true &&
    !hasDelegatedAgreement(ctx, o.proposal.agreementId) &&
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

function matches(t: Transition, probe: Outcome): boolean {
  if (!t.when) return false;
  try { return !!t.when(probe, PROBE_CTX); }
  catch { return false; }
}

/**
 * A state handles the claim kickoff itself only when it says so EXPLICITLY —
 * a transition that fires for a store-claim wake and does NOT also fire for a
 * bare counterparty approve. In practice that means keying on `fromClaimWake`.
 *
 * Two weaker rules read as "handled" when nothing was. A when-less fallthrough
 * counted, so a state shaped `idle → listening` never got the transition
 * injected and routed every claim into its idle loop; and a `when: o => o.kind
 * === 'proposal-resolved'` route counted too, because the claim probe is also a
 * proposal-resolved/approve. Neither author had written anything about claims.
 * Requiring the negative probe to MISS is what tells a deliberate claim handler
 * apart from a generic one, and the unconditional case is safe to inject over
 * because the claim transition goes in FIRST — see injectKickoffDefault.
 */
function stateHandlesClaimKickoff(state: State): boolean {
  return state.transitions.some(
    t => matches(t, PROBE_CLAIM_APPROVE) && !matches(t, PROBE_BARE_APPROVE),
  );
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

/** provider side after a store/listing claim. */
/**
 * Declare that THIS state answers a store-claim wake itself, so the injected
 * `claimKickingOff` greeting is not added to it.
 *
 * The opt-out has to fire on a claim wake and NOT on a bare counterparty
 * approve — `stateHandlesClaimKickoff` uses that difference to tell a
 * deliberate claim handler from a generic `proposal-resolved` route that
 * happens to match. Writing that predicate by hand is easy to get subtly wrong,
 * and getting it wrong is silent: the agent greets on every claim while its
 * author believes it opted out. That cost one lab cast 100% of its token spend
 * and three wedged workers before anyone noticed.
 *
 *   transitions: [
 *     handlesClaimWake('idle'),   // a claim does not make this agent talk
 *     { to: 'idle', when: (o) => o.kind === 'proposal-resolved' && o.action === 'approve' },
 *   ]
 *
 * Note the second route is still worth keeping when you also want to sit out
 * the PROPOSER-side kickoff: that one probes with a bare approve, which this
 * helper deliberately does not match.
 */
export function handlesClaimWake(to: string): Transition {
  return {
    to,
    when: (o) =>
      o.kind === 'proposal-resolved' && o.action === 'approve' && o.fromClaimWake === true,
  };
}

export function buildClaimKickoffState(initial: string): ThinkingState {
  const dflt = thinkingDefaults({ initial });
  return {
    kind: 'thinking',
    prompt: {
      role: "A buyer just claimed your store listing. chat_open with the buyer and the claimed agreementId returns the hire's room, which the server usually made at claim, or opens one when there is none. Then greet them and start serving the terms.",
      goal: "Open or reuse the hire's room with the buyer and greet them so the engagement begins.",
      constraints:
        "The claimed agreement id is in <event> / activeAgreementId. The buyer is the claim actor (Sender / actorId / Buyer on the event) — call chat_open with that participantId AND the claimed agreementId. That returns the hire's room the server usually made at claim, or opens one when there is none. Then chat_send a short greeting that acknowledges the hire and offers to serve the agreement terms. Do not chat_send to an agrn-* session id. Do not spawn task_create here unless the terms require it after the greeting. Do not re-negotiate — the agreement is already active.",
    },
    actions: {
      ...dflt.actions,
      openChat: {
        prompt: {
          when: "Call chat_open with the buyer and the claimed agreementId. The server usually already made the hire's room at claim; this returns it, or opens one when there is none.",
          instruction: "Open or reuse the hire's room with the buyer who claimed the listing.",
          format:
            '{"participantId": "<buyer actorId / Sender from the event>", "agreementId": "<the claimed agreement id>"}',
        },
        tool: 'chat_open',
        produces: (result) => {
          const r = result as { chatId?: string } | undefined;
          return r?.chatId ? 'tool-result' : 'error';
        },
        /**
         * Deliberately does NOT terminate the turn.
         *
         * It used to, with "stay in this state so the next turn can greet in the
         * opened chat" — but the next turn re-enters this state from scratch,
         * reads the same prompt ("there is not yet a real chat"), and opens the
         * chat again. Nothing in a re-entered state says a chat is already open:
         * `chat_open` is idempotent, so every retry succeeds, produces
         * `tool-result`, and re-enters. Measured: three lab workers called
         * `chat_open` twelve times each, sent zero messages, and tripped the
         * depth guard — the greeting never happened and the wake was spent.
         *
         * Letting the turn continue puts the chatId in front of the model as a
         * tool result, so `greetBuyer` runs in the SAME turn. `message_sent`
         * outranks `tool_result` when the outcome is picked, so the turn leaves
         * on `message-sent` → initial: one turn, one greeting, no re-entry.
         */
      },
      greetBuyer: {
        prompt: {
          when: 'A chat with the buyer is open (chat_open just returned a chatId, or one already exists).',
          instruction: 'Greet the buyer and acknowledge you will serve the claimed agreement terms.',
          format: '{"receiverId": "<buyer id>", "message": "<short greeting>", "chatId": "<chatId from chat_open when available>"}',
        },
        produces: 'message-sent',
        terminatesLoop: true,
      },
    },
    transitions: [
      // After chat_open, re-enter so greetBuyer can run in the same kickoff.
      { to: CLAIM_KICKOFF_STATE, when: o => o.kind === 'tool-result' },
      { to: initial, when: o => o.kind === 'message-sent' },
      ...dflt.transitions,
    ],
  };
}

/**
 * Agreement-kickoff defaults. For every state whose transitions do not already
 * handle the corresponding probe, add a transition to the injected kickoff
 * state. Returns a NEW workflow — input states are not mutated.
 *
 * Two kickoffs:
 *  - `kickingOff` — proposer-side approval → task_create
 *  - `claimKickingOff` — store-claim provider wake → chat_open + greet
 * Direct-proposal counterparties (lifecycle approve, !proposedByMe, no
 * fromClaimWake) still never auto-kickoff.
 *
 * **They are ordered differently on purpose** (first match wins in
 * AgentMachine._evaluateTransitions):
 *
 *  - `kickingOff` is appended LAST. It fires on an approval of a proposal THIS
 *    agent made, which the author was already expecting — whatever route they
 *    wrote for it should keep winning.
 *  - `claimKickingOff` is inserted FIRST. It fires on a wake the author never
 *    wrote a route for, and it has to beat the unconditional fallthrough an
 *    `idle` state uses to reach its listening loop — otherwise the claim is
 *    swallowed into the idle loop and the buyer is never greeted. Going first
 *    is safe because its `when` is narrow: only a `fromClaimWake` approve
 *    matches, so nothing else is shadowed. An author who wants the claim for
 *    themselves keys on `fromClaimWake`, which suppresses the injection
 *    outright (stateHandlesClaimKickoff).
 */
export function injectKickoffDefault(workflow: Workflow): Workflow {
  if (workflow.states[KICKOFF_STATE]) {
    throw new Error(
      `[defineAgent] state name "${KICKOFF_STATE}" is reserved for the injected agreement-kickoff default — rename the state`,
    );
  }
  if (workflow.states[CLAIM_KICKOFF_STATE]) {
    throw new Error(
      `[defineAgent] state name "${CLAIM_KICKOFF_STATE}" is reserved for the injected claim-kickoff default — rename the state`,
    );
  }
  const states: Record<string, State> = {};
  let injectedProposer = false;
  let injectedClaim = false;
  for (const [name, state] of Object.entries(workflow.states)) {
    const transitions = [...state.transitions];
    if (!stateHandlesProposerApproval(state)) {
      transitions.push(KICKOFF_TRANSITION);
      injectedProposer = true;
    }
    if (!stateHandlesClaimKickoff(state)) {
      transitions.unshift(CLAIM_KICKOFF_TRANSITION);
      injectedClaim = true;
    }
    states[name] =
      transitions.length === state.transitions.length
        ? state
        : ({ ...state, transitions } as State);
  }
  if (!injectedProposer && !injectedClaim) return workflow;
  if (injectedProposer) states[KICKOFF_STATE] = buildKickoffState(workflow.initial);
  if (injectedClaim) states[CLAIM_KICKOFF_STATE] = buildClaimKickoffState(workflow.initial);
  return { ...workflow, states };
}
