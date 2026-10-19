import type { WriteSource } from '@ziggs-ai/api-client';
import { AGREEMENT_TERMINAL_STATES } from '@ziggs-ai/contracts';
import type { AgreementService } from '../../agreements/AgreementService.js';
import type { TaskService } from '../../tasks/TaskService.js';
import type { DeliveryWriteKeys } from '../../../types.js';
import {
  isBroadcastTarget,
  partyActorIds,
  presentClaimResult,
  type AgreementParties,
  type ContextReadClient,
  type PlanReviewTiming,
  type CreateTaskCheckBackData,
} from '@ziggs-ai/api-client';

// the link-summary rule lives in AgreementClient, at the point the
// document is parsed. Every verb here inherits it through the client instead of
// each one restating `engagementKind === 'link' ? linkSummary(a) : a` — which is
// how counter, fulfill and subcontract came to return the raw document.

// Map legacy task-state aliases onto the canonical set.
function normalizeState(state: string): string {
  if (state === 'done') return 'completed';
  if (state === 'error') return 'failed';
  return state;
}

interface Services {
  agreementService: AgreementService;
  taskService: TaskService;
  contextReadClient: ContextReadClient;
}

interface ProtocolPayload {
  operation?: string;
  agreementId?: string;
  description?: string;
  proposedTo?: string;
  providerId?: string;
  executorId?: string;
  action?: 'approve' | 'reject';
  price?: number;
  lifecycle?: string;
  expiresAt?: string;
  maxExecutions?: number;
  agreementDescription?: string;
  parentAgreementId?: string;
  parentTaskId?: string;
  taskId?: string;
  stepId?: string;
  assigneeId?: string;
  status?: string;
  result?: unknown;
  plan?: unknown;
  planReviewTiming?: string;
  requireMidWorkPlanAck?: boolean;
  engagementKind?: 'hire' | 'service' | 'link';
  subtasks?: (string | { description?: string })[];
  [key: string]: unknown;
}

// the `plan` tool-schema is underspecified (`plan: {type:'object'}`,
// `planReviewTiming: 'string'`), so the LLM emits steps missing stepId/order and an
// out-of-enum planReviewTiming, which the backend DTO rejects. Normalize in-place
// before the write.
//
// task-spawn is the only op left that carries a plan. Propose, counter
// and subcontract used to run this too — and their plans were then dropped on the
// floor, since no agreement route has ever accepted one.
// Returns the clamped review timing rather than only writing it back, so the
// spawn call gets the narrowed type from the one place that does the clamping.
function normalizePlanInPlace(payload: ProtocolPayload): PlanReviewTiming | undefined {
  const plan = payload.plan as { steps?: unknown } | undefined;
  if (plan && Array.isArray(plan.steps)) {
    plan.steps = plan.steps.map((s, i) => {
      const step =
        s && typeof s === 'object'
          ? (s as Record<string, unknown>)
          : { description: String(s) };
      return {
        ...step,
        stepId:
          typeof step.stepId === 'string' && step.stepId ? step.stepId : `step-${i + 1}`,
        order: typeof step.order === 'number' ? step.order : i,
        description:
          typeof step.description === 'string'
            ? step.description
            : String(step.description ?? ''),
      };
    });
  }
  if (payload.planReviewTiming === undefined) return undefined;
  return payload.planReviewTiming === 'before_execution'
    ? 'before_execution'
    : 'with_proposal';
}

/** The `sources` a protocol call carried, when it carried a list. */
function sourcesOf(payload: Record<string, unknown>): { sources?: WriteSource[] } {
  return Array.isArray(payload.sources)
    ? { sources: payload.sources as WriteSource[] }
    : {};
}

export async function dispatchProtocolOp(
  services: Services,
  payload: ProtocolPayload,
  chatId: string | null,
  _agents: unknown[] = [],
  actingAgentId: string | null = null,
  writeKeys: DeliveryWriteKeys | null = null,
  /** #8 — prefer the cached session snapshot over a fresh HTTP read. */
  cachedAgreements?: unknown[],
): Promise<unknown> {
  if (!payload?.operation) return null;
  const { operation } = payload;
  const { agreementService, taskService } = services;
  const actorId = actingAgentId?.trim() || null;

  switch (operation) {
    case 'agreement-propose':
      return proposeAgreement(services, payload, chatId, writeKeys);
    case 'agreement-subcontract':
      return subcontractAgreement(
        services,
        payload,
        namedSubcontractChat(payload, chatId),
        writeKeys,
      );
    case 'agreement-respond':
      if (!payload.agreementId || !payload.action) return null;
      return agreementService.respond(payload.agreementId, payload.action);
    case 'agreement-claim': {
      // the one claim verb — request, standing offer, or link invite.
      if (!payload.agreementId) throw new Error('agreement-claim requires `agreementId`');
      // The job this claim is part of, when the caller named one
      // (the runtime fills it from the task being executed). It authorizes the
      // claim; it does not re-parent the row, which stays in the publisher's
      // tree.
      const declaredMandate = payload.mandateAgreementId;
      const { agreement, kind } = await agreementService.claim(payload.agreementId, {
        ...(typeof declaredMandate === 'string' && declaredMandate
          ? { mandateAgreementId: declaredMandate }
          : {}),
      });
      return presentClaimResult(agreement, kind, {
        creds: { operatorKey: 'sdk', agentId: actorId ?? 'agent' },
        surface: 'sdk',
        webUrl: process.env.ZIGGS_WEB_URL,
      });
    }
    case 'agreement-counter-proposal':
      if (!payload.agreementId) return null;
      // The price is the one the model stated; the SDK adds none.
      return agreementService.counter(payload.agreementId, {
        price: payload.price,
        agreementDescription: payload.agreementDescription,
        expiresAt: payload.expiresAt,
        lifecycle: payload.lifecycle,
        maxExecutions: payload.maxExecutions,
        description: payload.description,
        ...sourcesOf(payload),
      });
    case 'agreement-check-proposal':
      if (!payload.agreementId) return null;
      return agreementService.getStatus(payload.agreementId);
    case 'agreement-revoke':
      if (!payload.agreementId) return null;
      return await agreementService.revoke(payload.agreementId);
    case 'agreement-fulfill':
      if (!payload.agreementId) return null;
      return await agreementService.fulfill(payload.agreementId);
    case 'task-spawn': {
      if (!payload.agreementId || !payload.description) return null;
      let spawnAgreementId = payload.agreementId;
      const ags = await agreementsInChat(services, chatId, cachedAgreements);
      // b2: if the assignee is not a party on the cited agreement,
      // redirect the spawn to the ACTIVE sub-agreement (same root) where the
      // assignee IS the provider — the orchestrator often cites the top-level
      // hire, which the backend rejects with "assignee not a party".
      // also redirect when the cited agreement is no longer active —
      // a count-bound sub fulfills after its quota (default 1), and the LLM
      // keeps citing that now-terminal sub for the next spawn even when a
      // fresh active sub for the same executor exists.
      if (payload.assigneeId) {
        const cited = ags.find((a) => a.agreementId === payload.agreementId);
        if (cited && (!agIsParty(cited, payload.assigneeId) || !agIsActiveStatus(cited))) {
          const root = cited.rootAgreementId || payload.agreementId;
          const sub = ags.find(
            (a) => agIsActiveStatus(a) && agIsProvider(a, payload.assigneeId as string) &&
              (a.rootAgreementId === root || a.parentAgreementId === payload.agreementId ||
                a.parentAgreementId === root),
          );
          if (sub?.agreementId) spawnAgreementId = sub.agreementId;
        }
      }
      // Safety guard: a spawn against an agreement that is not active,
      // or whose assignee is not a party on it, hard-400s at the backend AND makes
      // the worker invent a "connection needed" message. That happens when the
      // orchestrator spawns before its sub-agreement is subcontracted/approved.
      // Skip GRACEFULLY instead — the sub-agreement's activation event will wake
      // the orchestrator to spawn correctly on a later turn, no 400, no cascade.
      const target = ags.find((a) => a.agreementId === spawnAgreementId);
      // a TERMINAL target is not the same as a not-yet-active one — no
      // activation event will ever arrive, so the "wait for a later turn" skip
      // below would stall the run. Tell the caller the actionable next step:
      // subcontract a fresh sub for this executor, then spawn under it.
      if (target && TERMINAL_STATUS.has(String(target.status))) {
        return {
          ok: false,
          skipped: 'spawn-target-terminal',
          reason: `agreement ${spawnAgreementId} is ${target.status} (terminal — its quota or term is exhausted). Subcontract a new sub-agreement to ${payload.assigneeId ?? 'the executor'}, then spawn this task under that new agreement.`,
          agreementId: spawnAgreementId,
        };
      }
      const notReady =
        (target && !agIsActiveStatus(target)) ||
        (!!payload.assigneeId && target && !agIsParty(target, payload.assigneeId));
      if (notReady) {
        return {
          ok: false,
          skipped: 'spawn-target-not-ready',
          reason: target && !agIsActiveStatus(target)
            ? `agreement ${spawnAgreementId} is ${target?.status ?? 'unknown'} (not active yet)`
            : `assignee is not a party on ${spawnAgreementId} yet — subcontract to it first`,
          agreementId: spawnAgreementId,
        };
      }
      const planReviewTiming = normalizePlanInPlace(payload);
      return taskService.spawnUnderAgreement(spawnAgreementId, {
        description: payload.description,
        parentTaskId: payload.parentTaskId,
        plan: payload.plan,
        planReviewTiming,
        requireMidWorkPlanAck: payload.requireMidWorkPlanAck,
        assigneeId: payload.assigneeId,
        inputArtifactIds: Array.isArray(payload.inputArtifactIds)
          ? (payload.inputArtifactIds as string[])
          : undefined,
        // The chase pair, passed through as given. Shape is the
        // backend's business (it refuses a cadence with no budget and a
        // deadline already past); the runner's job is not to silently drop
        // what the caller set, which is what omitting them here would do.
        ...(typeof payload.dueAt === 'string' && payload.dueAt
          ? { dueAt: payload.dueAt }
          : {}),
        ...(payload.checkBack && typeof payload.checkBack === 'object'
          ? { checkBack: payload.checkBack as CreateTaskCheckBackData }
          : {}),
        ...sourcesOf(payload),
        // Wake-derived idempotency key (delivery law): a crash-replay re-issuing
        // this spawn resolves to the already-created task server-side instead of
        // creating a duplicate. Keyed on what is actually written (the resolved
        // agreement, not the LLM-cited one), so multiple spawns in one wake stay
        // distinct.
        idempotencyKey: writeKeys?.taskSpawnKey({
          agreementId: spawnAgreementId,
          description: payload.description,
          assigneeId: payload.assigneeId,
          parentTaskId: payload.parentTaskId,
        }),
      });
    }
    case 'task-update': {
      // `state` only — legacy `status` alias removed. Fleet prompts
      // must emit state (coffee / fruit / ledger / agent-definer).
      const terminalRaw =
        typeof payload.state === 'string' && payload.state ? payload.state : '';
      if (!payload.taskId || !terminalRaw) return null;
      const state = normalizeState(terminalRaw);
      // Wake-derived idempotency key: a crash-replay re-issuing this transition
      // no-ops server-side instead of erroring on the already-terminal task.
      return taskService.updateState(
        payload.taskId,
        state as Parameters<typeof taskService.updateState>[1],
        payload.result,
        writeKeys?.taskStateKey(payload.taskId, state),
        sourcesOf(payload).sources,
      );
    }
    case 'task-update-plan-step': {
      if (!payload.taskId) throw new Error('task-update-plan-step requires `taskId`');
      const waitingOn = payload.waitingOn as
        | { kind: 'user' | 'agent'; id: string }
        | null
        | undefined;
      // The ask that produced nothing else. A worker subtask usually has no
      // plan at all, so requiring a step to tick would have meant inventing
      // one just to say "I asked my person and I am waiting".
      if (!payload.stepId && waitingOn !== undefined) {
        return taskService.setWaitingOn(payload.taskId, waitingOn ?? null);
      }
      if (!payload.stepId) throw new Error('task-update-plan-step requires `stepId`');
      if (!payload.status) throw new Error('task-update-plan-step requires `status`');
      // a plan-step tick is cosmetic progress. Worker subtasks usually
      // have NO plan (only the orchestrator's job task does), and the LLM may tick
      // a stepId that isn't in the plan — the backend 400s on both. That must never
      // hard-fail the tool → fail the task → wake-loop. Make it best-effort.
      try {
        return await taskService.updatePlanStep(
          payload.taskId,
          payload.stepId,
          payload.status,
          payload.result,
          waitingOn,
          sourcesOf(payload).sources,
        );
      } catch {
        return { ok: false, skipped: 'plan-step-not-updatable', stepId: payload.stepId };
      }
    }
    default:
      throw new Error(`Unknown protocol operation: ${operation}`);
  }
}

async function proposeAgreement(
  services: Services,
  payload: ProtocolPayload,
  chatId: string | null,
  writeKeys: DeliveryWriteKeys | null = null,
): Promise<unknown> {
  if (!payload.description) throw new Error('agreement-propose requires `description`');
  if (!payload.proposedTo) throw new Error('agreement-propose requires `proposedTo` (userId or agentId). To create a task under an existing agreement, use `task_create` instead.');

  // a link proposal is an agreement with engagementKind 'link' —
  // no chat, no money; the target owner approves. Folds the old request_link.
  // The shared propose grammar no longer has a link arm (link_propose owns it).
  if (payload.engagementKind === 'link') {
    if (isBroadcastTarget(payload.proposedTo)) {
      throw new Error(
        'A broadcast link is an invite — use link_propose with no target instead; it returns a share link.',
      );
    }
    return services.agreementService.requestLink(payload.proposedTo, payload.description);
  }

  // The agent sets the price, never the SDK: a proposal carries a price only
  // when the model stated one, and the server falls back to the provider's
  // listing price, then to free.
  // Wake-derived idempotency key (delivery law): a crash-replay re-issuing this
  // propose resolves to the already-created agreement server-side instead of
  // minting a duplicate proposal. Keyed on what the proposal writes, so
  // multiple proposals in one wake stay distinct.
  // A standing listing is published by a person or the deploy.
  // A broadcast with a provider is that listing. A request omits providerId.
  // A named counterparty is a direct proposal and stays.
  if (isBroadcastTarget(payload.proposedTo) && payload.providerId) {
    throw new Error(
      'A standing listing is published by a person or the deploy. Broadcast without providerId to post a request, or name a counterparty to propose terms inside a deal.',
    );
  }

  const idempotencyKey = writeKeys?.agreementProposeKey({
    proposedTo: payload.proposedTo,
    providerId: payload.providerId,
    description: payload.description,
    parentAgreementId: payload.parentAgreementId,
  });
  const engagementKind =
    payload.engagementKind === 'hire' || payload.engagementKind === 'service'
      ? payload.engagementKind
      : undefined;
  const billing =
    payload['billing'] === 'per_task' || payload['billing'] === 'total'
      ? payload['billing']
      : undefined;
  const { agreement, shape } = await services.agreementService.proposeUnified({
    proposedTo: payload.proposedTo,
    chatId: chatId ?? undefined,
    description: String(payload.description),
    providerId: payload.providerId,
    price: typeof payload.price === 'number' ? payload.price : undefined,
    lifecycle: typeof payload.lifecycle === 'string' ? payload.lifecycle : undefined,
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : undefined,
    maxExecutions:
      typeof payload.maxExecutions === 'number' ? payload.maxExecutions : undefined,
    billing,
    ...(payload.conversationAllowance !== undefined ? { conversationAllowance: payload.conversationAllowance as number | null } : {}),
    agreementDescription: payload.agreementDescription,
    ...sourcesOf(payload),
    parentAgreementId: payload.parentAgreementId,
    engagementKind,
    idempotencyKey,
  });
  // Keep the agreement fields at the top level (the shape agents already
  // read) and add the discriminant the shared flow returns.
  return { ...agreement, shape };
}

// ── deterministic sub-agreement resolution ─────────────────────────
// The orchestrator delegates one task per worker, but the LLM inconsistently
// (a) re-subcontracts the same worker (duplicate sub-agreements) and (b)
// task_spawns a worker under the TOP-LEVEL hire — where the worker is not a
// party — instead of under that worker's sub-agreement, which the backend
// rejects with 400 "assignee is not a party". Both are made deterministic here
// using the chat's existing agreements.
const TERMINAL_STATUS = new Set<string>(AGREEMENT_TERMINAL_STATES);
type AgLike = Record<string, unknown> & {
  agreementId?: string; status?: string; rootAgreementId?: string;
  parentAgreementId?: string; parties?: AgreementParties;
};
async function agreementsInChat(
  services: Services,
  chatId: string | null,
  cachedAgreements?: unknown[],
): Promise<AgLike[]> {
  if (!chatId) return [];
  // #8 — createZiggsEffectHandler already cached the session snapshot;
  // prefer that over another GET /context/snapshot just for the agreements array.
  // Empty array is a real answer ("none in this chat") — do not re-fetch.
  if (cachedAgreements !== undefined) {
    return Array.isArray(cachedAgreements) ? (cachedAgreements as AgLike[]) : [];
  }
  try {
    // The room is the lane, as for every read made on a wake.
    const reader = services.contextReadClient.withLane?.(chatId) ?? services.contextReadClient;
    const snap = await reader.snapshot(chatId, { maxMessages: 1 });
    const ags = snap.agreements;
    return Array.isArray(ags) ? (ags as AgLike[]) : [];
  } catch {
    return [];
  }
}
function agIsProvider(a: AgLike, agentId: string): boolean {
  return a.parties?.provider?.actor === agentId || a['providerId'] === agentId;
}
function agIsParty(a: AgLike, agentId: string): boolean {
  return partyActorIds(a.parties).includes(agentId);
}
// Spawnable = actually ACTIVE. A freshly-subcontracted sub is `draft` until its
// counterparty auto-approves; spawning under a draft (or citing an agreement the
// assignee isn't a party on) 400s and cascades into a bogus worker "connection
// needed" message. We treat only 'active' as spawnable.
function agIsActiveStatus(a: AgLike): boolean {
  return String(a.status ?? '') === 'active';
}

/** A named room on the call wins; otherwise the wake's chat. Empty is omit. */
function namedSubcontractChat(
  payload: ProtocolPayload,
  wakeChatId: string | null,
): string | null {
  const named = payload.chatId;
  if (typeof named === 'string' && named.trim()) return named.trim();
  return wakeChatId;
}

/**
 * A sub-agreement under the agreement this wake works for, with exactly the
 * terms the model stated. When it states neither an end date nor a task count
 * the server writes a standing sub-agreement, the same as over MCP — the
 * shared tool description says so.
 *
 * This used to rewrite such terms to one count-bound task, and to reuse any
 * open sub-agreement for the same worker. Both served a backend rule that
 * closed a parent once every child had finished; that rule is gone (a parent
 * now closes only by its own quota, expiry or an explicit close), so the
 * rewrite only made a hosted agent's sub-deal end after one task where the same
 * request over MCP stays open. A crash replay is still covered by the
 * wake-derived idempotency key.
 */
async function subcontractAgreement(
  services: Services,
  payload: ProtocolPayload,
  chatId: string | null,
  writeKeys: DeliveryWriteKeys | null = null,
): Promise<unknown> {
  if (!payload.description || !payload.executorId) return null;
  // The price the model stated, or none; the server falls back to the
  // executor's listing price, then to free.
  const { operation: _op, ...fields } = payload;
  const idempotencyKey = writeKeys?.agreementSubcontractKey({
    executorId: payload.executorId,
    description: payload.description,
    parentAgreementId: payload.parentAgreementId ?? '',
  });
  return services.agreementService.delegate({ ...fields, chatId, idempotencyKey } as Parameters<typeof services.agreementService.delegate>[0]);
}

