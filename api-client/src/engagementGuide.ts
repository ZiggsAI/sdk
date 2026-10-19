/**
 * What to do with a piece of engagement, from records the caller already has.
 *
 * This is a receipt and a next-call pointer. It does not invent a worker
 * protocol, a wake store, or a blocked task state. Waiting-on-person is a
 * field on the receipt so a later human view can show waiting instead of
 * active. A held graph is not work until deps release; failed or cancelled
 * deps are not inputs. Withdraw is cancel on the root. A live hire does not
 * take a second hire or an in-place amend.
 */

import type { InboxDeliveryRef, InboxEnvelope, InboxTaskRef, Task } from './types.js';
import {
  agreementBidCapability,
  agreementBuyCapability,
  agreementRequestCapability,
  agreementSubcontractCapability,
} from './capabilities/agreementVerbs.js';
import { nextCall, type NextCall } from './capabilities/nextCall.js';
import type { CapabilityEnv } from './capabilities/types.js';
import type { SessionContinuation } from './sessionOrientation.js';

export type EngagementGuideKind =
  | 'work_order'
  | 'duplicate'
  | 'held'
  | 'waiting'
  | 'contact'
  | 'stranger_brief'
  | 'hire_terms'
  | 'reminder'
  | 'reuse'
  | 'claim'
  | 'request'
  | 'direct'
  | 'subcontract';

export type EngagementOutcome = 'ok' | 'pending' | 'noop' | 'unavailable';

export type WaitingOn = { kind: 'user' | 'agent'; id: string };

export interface GraphHonesty {
  ready: boolean;
  heldByDeps: boolean;
  failedDepsAreNotInputs: true;
  failedDepCount: number;
}

export interface HireTermsHonesty {
  secondHire: 'refused';
  amendLive: 'unavailable';
}

export interface EngagementGuide {
  kind: EngagementGuideKind;
  outcome: EngagementOutcome;
  summary: string;
  /** Room the brief arrived in — never a substitute for agreementId. */
  chatId?: string | null;
  agreementId?: string | null;
  taskId?: string | null;
  waitingOn?: WaitingOn | null;
  graph?: GraphHonesty;
  hireTerms?: HireTermsHonesty;
  next?: NextCall;
}

export interface EngagementTaskHint {
  taskId: string;
  agreementId?: string | null;
  rootTaskId?: string | null;
  heldByDeps?: boolean;
  waitsOn?: string[];
  /** Known terminal states for named deps, when the caller has them. */
  depStates?: Record<string, string>;
  dueAt?: string | null;
  checkBack?: { everyMinutes: number; maxReminders: number } | null;
  lastAct?: 'question';
  waitingOn?: WaitingOn | null;
}

export interface ContactPathInput {
  partyKind: 'person' | 'agent';
  partyId: string;
  /** Active Ziggs link (or same-org membership) to that person. */
  linked: boolean;
  /** The agent has a take-it-or-leave-it listing. */
  listed?: boolean;
  sameOrg?: boolean;
}

/**
 * How to form (or refuse to form) an engagement from facts the caller
 * already has. The ladder is reuse → claim → request → direct. A parent
 * subcontract is its own rail. A listing is never countered.
 */
export interface FormationInput {
  /** Active agreement that already covers this work on matching terms. */
  matchingActive?: { agreementId: string } | null;
  /** Live hire with this counterparty, whether or not terms still match. */
  liveHire?: { agreementId: string } | null;
  /** Caller wants different terms than the live hire. */
  wantsChangedTerms?: boolean;
  /**
   * A posted listing to claim. `true` means listings exist and the caller
   * still has to pick the id. An object with an id is that listing.
   */
  listing?: { agreementId?: string } | true | null;
  /** Active parent under which this slice would be a subcontract. */
  parentAgreementId?: string | null;
  /** Named counterparty for a direct proposal. */
  counterparty?: string | null;
  /** `doors.acceptsProposals` — most published agents are claim-only. */
  acceptsProposals?: boolean;
  /** They work (buy) vs you work (bid). */
  direction?: 'buy' | 'bid';
}

export interface InboxEngagementInput {
  env: CapabilityEnv;
  agentId: string;
  inbox: Pick<InboxEnvelope, 'deliveries' | 'tasksAwaitingMe'>;
  tasks?: EngagementTaskHint[];
  continuation?: Pick<SessionContinuation, 'canScheduleWake' | 'kind'>;
}

const TERMINAL_TASK = new Set(['completed', 'failed', 'cancelled']);

function openTasksForAgreement(
  tasks: readonly InboxTaskRef[] | undefined,
  agreementId: string,
): InboxTaskRef[] {
  return (tasks ?? []).filter(
    (t) => t.agreementId === agreementId && !TERMINAL_TASK.has(t.state),
  );
}

function assignedToMe(
  delivery: InboxDeliveryRef,
  agentId: string,
): boolean {
  return Boolean(agentId) && delivery.assigneeId === agentId;
}

/** Same event twice, or a hire-room brief that already has an open task. */
export function isEchoOrDuplicate(
  inbox: Pick<InboxEnvelope, 'deliveries' | 'tasksAwaitingMe'>,
  agentId: string,
): boolean {
  const mine = inbox.deliveries.filter((d) => assignedToMe(d, agentId));
  const eventIds = mine.map((d) => d.eventId).filter(Boolean);
  if (new Set(eventIds).size < eventIds.length) return true;

  for (const d of mine) {
    if (d.kind === 'task-state' && d.taskId) {
      const already = (inbox.tasksAwaitingMe ?? []).some(
        (t) => t.taskId === d.taskId,
      );
      if (already) return true;
    }
    if (d.kind === 'message' && d.agreementId) {
      if (openTasksForAgreement(inbox.tasksAwaitingMe, d.agreementId).length > 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Assigned message under a live hire. Missing chat is not a skip — a fresh
 * hire without a room still runs after access to that agreement is proven.
 * An agrn- notification lane is not treated as a chat row.
 */
export function isHireWorkOrder(
  delivery: InboxDeliveryRef,
  agentId: string,
  tasksAwaitingMe?: readonly InboxTaskRef[],
): boolean {
  if (!assignedToMe(delivery, agentId)) return false;
  if (delivery.kind !== 'message') return false;
  if (!delivery.agreementId) return false;
  if (delivery.taskId) return false;
  if (openTasksForAgreement(tasksAwaitingMe, delivery.agreementId).length > 0) {
    return false;
  }
  return true;
}

export function waitingOnFromTask(task: EngagementTaskHint): WaitingOn | null {
  if (task.waitingOn?.id) return task.waitingOn;
  if (task.lastAct === 'question' && task.waitingOn?.id) return task.waitingOn;
  return task.waitingOn ?? null;
}

export function graphReleaseHonesty(task: EngagementTaskHint): GraphHonesty {
  const failedDepCount = (task.waitsOn ?? []).filter((id) => {
    const state = task.depStates?.[id];
    return state === 'failed' || state === 'cancelled';
  }).length;
  return {
    ready: !task.heldByDeps,
    heldByDeps: Boolean(task.heldByDeps),
    failedDepsAreNotInputs: true,
    failedDepCount,
  };
}

export function liveHireChangedTerms(env: CapabilityEnv): EngagementGuide {
  return {
    kind: 'hire_terms',
    outcome: 'unavailable',
    summary:
      'A live hire does not take a second hire or an in-place amend. Reuse the active agreement; changing terms is not on this surface.',
    hireTerms: { secondHire: 'refused', amendLive: 'unavailable' },
    next: nextCall(
      env,
      'agreement_claim',
      undefined,
      'a second hire on live terms is refused — reuse the active agreement',
      { outcome: 'unavailable' },
    ),
  };
}

/** Map a hire-formation 409 onto the refuse-second-hire receipt. */
export function liveHireConflictFromStatus(
  env: CapabilityEnv,
  status: number,
): EngagementGuide | null {
  if (status === 409) return liveHireChangedTerms(env);
  return null;
}

export function withdrawHeldGraph(
  env: CapabilityEnv,
  rootTaskId: string,
): EngagementGuide {
  return {
    kind: 'held',
    outcome: 'pending',
    taskId: rootTaskId,
    summary:
      'This graph is held. Withdraw is one act: cancel the root. Do not invent a blocked state.',
    graph: {
      ready: false,
      heldByDeps: true,
      failedDepsAreNotInputs: true,
      failedDepCount: 0,
    },
    next: nextCall(
      env,
      'task_cancel',
      { taskId: rootTaskId },
      'withdraw the held graph by cancelling the root',
    ),
  };
}

export function reminderHonesty(
  task: EngagementTaskHint,
  continuation?: Pick<SessionContinuation, 'canScheduleWake' | 'kind'>,
): EngagementGuide {
  const limits = task.checkBack
    ? `Remind at most ${task.checkBack.maxReminders} times, no sooner than every ${task.checkBack.everyMinutes} minutes.`
    : 'This task has no reminder budget.';
  const deadline = task.dueAt
    ? ` At ${task.dueAt} post what you have and stop.`
    : '';
  if (continuation && !continuation.canScheduleWake) {
    return {
      kind: 'reminder',
      outcome: 'unavailable',
      taskId: task.taskId,
      summary: `${limits}${deadline} This session cannot arm a wake — continue only by reading the inbox again. Do not infer a scheduler from the transport.`,
    };
  }
  return {
    kind: 'reminder',
    outcome: 'ok',
    taskId: task.taskId,
    summary: `${limits}${deadline} Wake capability is whatever this host already reported — not the profile or the transport.`,
  };
}

/**
 * Formation receipt. Reuse a matching active agreement. Claim a listing
 * and never counter it. Request when nothing listed fits. Direct only when
 * they accept proposals. Subcontract under a parent you already hold.
 * A second formation on a live hire is refused.
 */
export function formationGuide(
  env: CapabilityEnv,
  input: FormationInput,
): EngagementGuide {
  const matchingId = input.matchingActive?.agreementId;
  if (matchingId) {
    return {
      kind: 'reuse',
      outcome: 'noop',
      agreementId: matchingId,
      summary:
        'An active agreement already covers this work on matching terms. Reuse it. Do not form another, and do not counter a listing to replace it.',
      next: nextCall(
        env,
        'agreement_get',
        { agreementId: matchingId },
        'open the agreement you already hold',
      ),
    };
  }

  if (input.liveHire?.agreementId && input.wantsChangedTerms) {
    return {
      ...liveHireChangedTerms(env),
      agreementId: input.liveHire.agreementId,
    };
  }

  if (input.liveHire?.agreementId) {
    return {
      kind: 'reuse',
      outcome: 'noop',
      agreementId: input.liveHire.agreementId,
      summary:
        'You already hold a live hire with this party. Reuse it. Do not open a second formation.',
      next: nextCall(
        env,
        'agreement_get',
        { agreementId: input.liveHire.agreementId },
        'open the live hire you already hold',
      ),
    };
  }

  if (input.parentAgreementId) {
    return {
      kind: 'subcontract',
      outcome: 'ok',
      agreementId: input.parentAgreementId,
      summary:
        'Subcontracting under an active parent is its own rail. Name the worker and the slice. Do not open a second top-level hire.',
      next: nextCall(
        env,
        'agreement_subcontract',
        { parentAgreementId: input.parentAgreementId },
        'delegate this slice under the parent you hold',
        { definition: agreementSubcontractCapability },
      ),
    };
  }

  if (input.listing) {
    const agreementId =
      input.listing === true ? undefined : input.listing.agreementId;
    return {
      kind: 'claim',
      outcome: 'ok',
      ...(agreementId ? { agreementId } : {}),
      summary:
        'Claim the posted listing. Listings are take-it-or-leave-it — never counter one. Do not buy past a listing that already fits.',
      next: nextCall(
        env,
        'agreement_claim',
        agreementId ? { agreementId } : undefined,
        'claim this listing by agreementId — never counter it',
      ),
    };
  }

  if (input.counterparty && input.acceptsProposals === false) {
    return {
      kind: 'claim',
      outcome: 'unavailable',
      summary:
        'This agent is claim-only and refuses a direct proposal. Find their listing and claim it. Do not buy, bid, or counter.',
      next: nextCall(
        env,
        'marketplace_view',
        undefined,
        'find the listing this agent already posted',
      ),
    };
  }

  if (input.counterparty && input.acceptsProposals) {
    const key = input.direction === 'bid' ? 'agreement_bid' : 'agreement_buy';
    return {
      kind: 'direct',
      outcome: 'ok',
      summary:
        'No listing and they accept proposals. Go direct for these terms. Most published agents are claim-only — this path is the exception.',
      next: nextCall(
        env,
        key,
        { counterparty: input.counterparty },
        'propose these terms to the named counterparty',
        { definition: key === 'agreement_bid' ? agreementBidCapability : agreementBuyCapability },
      ),
    };
  }

  return {
    kind: 'request',
    outcome: 'ok',
    summary:
      'Nothing listed fits. Post a request and let a claimer take it. Do not invent a duplicate formation or counter a listing that was not a fit.',
    next: nextCall(
      env,
      'agreement_request',
      undefined,
      'post a request when nothing listed fits',
      { definition: agreementRequestCapability },
    ),
  };
}

/** Browse result: claim when rows exist, request when the board is empty. */
export function marketplaceFormation(
  env: CapabilityEnv,
  input: { listingAgreementIds: readonly string[] },
): EngagementGuide {
  const ids = input.listingAgreementIds.filter(Boolean);
  if (ids.length === 1) {
    return formationGuide(env, { listing: { agreementId: ids[0] } });
  }
  if (ids.length > 1) {
    return formationGuide(env, { listing: true });
  }
  return formationGuide(env, {});
}

/**
 * Contact path. Same-org people are reachable under the scoped identity.
 * An outside person needs an active link. A link is not a roster. An agent
 * with a listing is claimed, not chatted into a hire.
 */
export function contactPath(
  env: CapabilityEnv,
  input: ContactPathInput,
): EngagementGuide {
  const { partyKind, partyId, linked, listed, sameOrg } = input;

  if (partyKind === 'person' && (linked || sameOrg)) {
    return {
      kind: 'contact',
      outcome: 'ok',
      summary: sameOrg && !linked
        ? 'Same-org person: reach them under this scoped identity.'
        : 'Linked person: open or continue the working room. A link does not reveal their org roster.',
      next: nextCall(
        env,
        'chat_open',
        { participantId: partyId },
        'reach this person in a working room',
      ),
    };
  }

  if (partyKind === 'person' && !linked) {
    return {
      kind: 'contact',
      outcome: 'pending',
      summary:
        'Unlinked outside person: request a link or introduction. Do not invent an agreement or listing to manufacture reach.',
      next: nextCall(
        env,
        'link_propose',
        { to: partyId },
        'ask for a reach-only link to this person',
      ),
    };
  }

  if (partyKind === 'agent' && listed) {
    return {
      kind: 'contact',
      outcome: 'ok',
      summary:
        'This agent is listed. Claim the listing — do not open a hire by chatting.',
      next: nextCall(
        env,
        'marketplace_view',
        undefined,
        'find the listing to claim',
      ),
    };
  }

  return {
    kind: 'contact',
    outcome: 'pending',
    summary:
      'This agent is not listed for a claim. Follow the engagement ladder (reuse, request, or a permitted direct proposal). Do not treat chat as a hire.',
    next: nextCall(
      env,
      'agreement_request',
      undefined,
      'post a request when nothing listed fits',
      { definition: agreementRequestCapability },
    ),
  };
}

export function hireWorkOrderGuide(
  env: CapabilityEnv,
  delivery: InboxDeliveryRef,
): EngagementGuide {
  const agreementId = delivery.agreementId as string;
  return {
    kind: 'work_order',
    outcome: 'ok',
    chatId: delivery.chatId,
    agreementId,
    summary:
      'A brief from the principal in this hire is a work order. Create a task on yourself under that agreement. Fill the description from the brief after you read it. When you need helpers, declare a graph — do not invent worker_next.',
    next: nextCall(
      env,
      'task_create',
      {
        agreementId,
        assigneeId: env.creds.agentId,
      },
      'create the work order on yourself under this hire',
    ),
  };
}

export function strangerBriefGuide(env: CapabilityEnv, chatId: string | null): EngagementGuide {
  return {
    kind: 'stranger_brief',
    outcome: 'pending',
    chatId,
    summary:
      "A stranger's brief is not a work order. They hire you through your store listing, or through an agreement you draft when you have none; do not create a task under a hire you do not have.",
    next: nextCall(
      env,
      'agreement_request',
      undefined,
      'draft the agreement this brief would ride',
      { definition: agreementRequestCapability },
    ),
  };
}

export function duplicateGuide(): EngagementGuide {
  return {
    kind: 'duplicate',
    outcome: 'noop',
    summary:
      'This is a duplicate or echo of work you already have. Do not create another request, task, or committed effect.',
  };
}

function hintFromTask(task: Task): EngagementTaskHint {
  return {
    taskId: task.taskId,
    agreementId: task.agreementId ?? null,
    rootTaskId: task.rootTaskId ?? null,
    heldByDeps: task.heldByDeps,
    waitsOn: task.waitsOn,
    dueAt: task.dueAt ?? null,
    checkBack: task.checkBack ?? null,
  };
}

/**
 * First engagement that matters on this envelope. Empty mail with no held
 * tasks returns null so an empty inbox result stays a pass-through.
 */
export function inboxEngagement(
  input: InboxEngagementInput,
): EngagementGuide | null {
  const { env, agentId, inbox, continuation } = input;
  const tasks = input.tasks ?? [];

  if (isEchoOrDuplicate(inbox, agentId)) {
    return duplicateGuide();
  }

  const mine = inbox.deliveries.filter((d) => assignedToMe(d, agentId));
  const workOrder = mine.find((d) =>
    isHireWorkOrder(d, agentId, inbox.tasksAwaitingMe),
  );
  if (workOrder) {
    return hireWorkOrderGuide(env, workOrder);
  }

  const stranger = mine.find((d) => d.kind === 'message' && !d.agreementId);
  if (stranger) {
    return strangerBriefGuide(env, stranger.chatId);
  }

  const held = tasks.find((t) => t.heldByDeps);
  if (held) {
    const graph = graphReleaseHonesty(held);
    const rootId = held.rootTaskId || held.taskId;
    return {
      kind: 'held',
      outcome: 'pending',
      taskId: held.taskId,
      agreementId: held.agreementId ?? null,
      summary:
        'This node is held until dependencies are terminal. Failed or cancelled dependencies are not inputs. Withdraw by cancelling the root.',
      graph,
      next: nextCall(
        env,
        'task_cancel',
        { taskId: rootId },
        'withdraw the held graph by cancelling the root',
      ),
    };
  }

  const waiting = tasks.find((t) => waitingOnFromTask(t));
  if (waiting) {
    const who = waitingOnFromTask(waiting);
    return {
      kind: 'waiting',
      outcome: 'pending',
      taskId: waiting.taskId,
      waitingOn: who,
      summary:
        'The last act was a question. This task is waiting on that person — a receipt, not a new blocked state.',
    };
  }

  const chase = tasks.find((t) => t.dueAt || t.checkBack);
  if (chase) {
    return reminderHonesty(chase, continuation);
  }

  return null;
}

export function hintsFromTasks(tasks: Task[] | undefined): EngagementTaskHint[] {
  return (tasks ?? []).map(hintFromTask);
}
