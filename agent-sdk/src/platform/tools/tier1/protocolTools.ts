import { defineTool, type ToolDefinition } from '../../../tools/defineTool.js';
import { requireProtocolOperation } from '../../../tasks/protocolRegistry.js';
import { dispatchProtocolOp } from './protocolRunner.js';
import type { AgreementService } from '../../agreements/AgreementService.js';
import type { TaskService } from '../../tasks/TaskService.js';
import type { DeliveryWriteKeys } from '../../../types.js';
import {
  AGREEMENT_PROPOSE_PROVIDER_ID_DESCRIPTION,
  AGREEMENT_TERMS_PARAMS,
  agreementClaimCapability,
  agreementSubcontractCapability,
  SOURCES_PARAM,
  type ContextReadClient,
} from '@ziggs-ai/api-client';

interface ToolContext extends Record<string, unknown> {
  taskService: TaskService;
  agreementService: AgreementService;
  contextReadClient: ContextReadClient;
  chatId?: string | null;
  agents?: unknown[];
  /** #8 — agreements from the session's cached read-context snapshot. */
  agreements?: unknown[];
  /** Acting agent (default pricing). */
  agentId?: string;
  /** This wake's replay-stable write keys — task-update derives its idempotency key here, never from the LLM. */
  writeKeys?: DeliveryWriteKeys;
}

const PLAN_REVIEW_TIMING_ENUM = ['with_proposal', 'before_execution'] as const;
const planReviewTimingParam = {
  type: 'string',
  enum: [...PLAN_REVIEW_TIMING_ENUM],
  description: 'When the buyer reviews the plan: with_proposal | before_execution',
} as const;

/**
 * The chase pair. Keep in lockstep with MCP ziggs_task_create and the
 * server's task-create body.
 *
 * These two params are also where the contract is stated, because in this
 * first version nothing on the server enforces it: the holder obeys the rule
 * because the text it reads says so. Which means the wording IS the feature —
 * vague text here is a missing budget check.
 */
const dueAtParam = {
  type: 'string',
  description:
    'Deadline, ISO 8601 (e.g. 2026-09-12T17:00:00Z). When you hold a task with this set: at the deadline, post what you have and where you are stuck in the room where the question was asked, then stop. Do not keep chasing past it. A deadline already past is refused.',
} as const;
const checkBackParam = {
  type: 'object',
  description:
    'Reminder rule: { everyMinutes, maxReminders }. Both are required together — a cadence with no budget is refused. When you hold a task with this set: wait at least everyMinutes between reminders to the same person (later is fine, sooner is not), send at most maxReminders reminders per person after your first ask, and then stop reminding and report. One reminder is one wake, so the budget is a cost limit as much as a courtesy.',
} as const;

/**
 * The handler for a protocol verb, looked up by tool name in the registry
 *. Keying off the tool name rather than restating the operation is
 * what makes half-registration impossible: a verb missing from
 * PROTOCOL_TOOL_TO_OPERATION throws here, while this module loads, instead of
 * dispatching correctly and then being unrecognised as protocol at every
 * consumer that decides whether its result reaches context.
 */
function handlerFor(toolName: string) {
  const operation = requireProtocolOperation(toolName);
  return async (args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<unknown> => {
    const c = ctx as ToolContext;
    if (!c.taskService) throw new Error('taskService missing from tool context (expected when running under Agent)');
    if (!c.agreementService) throw new Error('agreementService missing from tool context (expected when running under Agent)');
    if (!c.contextReadClient) throw new Error('contextReadClient missing from tool context (expected when running under Agent)');
    const result = await dispatchProtocolOp(
      {
        taskService: c.taskService,
        agreementService: c.agreementService,
        contextReadClient: c.contextReadClient,
      },
      { operation, ...args },
      c.chatId ?? null,
      c.agents ?? [],
      typeof c.agentId === 'string' ? c.agentId : null,
      c.writeKeys ?? null,
      Array.isArray(c.agreements) ? c.agreements : undefined,
    );
    if (result == null) throw new Error(`Operation ${operation} returned no result`);
    return result;
  };
}

export const agreementProposeTool: ToolDefinition = defineTool(
  'agreement_propose',
  {
    ...AGREEMENT_TERMS_PARAMS,
    proposedTo: { type: 'string', required: true },
    engagementKind: {
      type: 'string',
      enum: ['hire', 'service'],
      description:
        'Contract type. Defaults to service. For a bilateral trust link, use link_propose.',
    },
    parentAgreementId: 'string',
    providerId: { type: 'string', description: AGREEMENT_PROPOSE_PROVIDER_ID_DESCRIPTION },
    agreementDescription: 'string',
  },
  handlerFor('agreement_propose'),
  { description: 'Propose an agreement — direct, broadcast, or link; there are no separate publish tools. Engagement precedence (posted-first): 1) REUSE an active agreement on matching terms, 2) CLAIM the counterparty\'s listing (marketplace_view → agreement_claim; never counter a listing), 3) POST a request broadcast here when nothing listed fits, 4) direct-propose ONLY for bespoke terms, renegotiation, or commissioning a named counterparty with no listing — most published agents are claim-only and refuse direct proposals with a pointer at their listing. Direction is stated, never guessed: providerId = your own id ("I work, you pay") or providerId = proposedTo ("you work, I pay") on direct proposals. Broadcast with proposedTo="everyone" (fully public) or "org" (your org only) and no providerId posts a REQUEST any agent may claim. A person or the deploy publishes a standing listing; this agent does not. For a bilateral trust link, use link_propose: it takes an email or an agent id, or neither for a share link. engagementKind defaults to service. Agreements are STANDING by default (no expiry, unlimited tasks under one agreement); set expiresAt or maxExecutions only when the engagement should end on its own.', isAgreementCreation: true },
);

export const agreementSubcontractTool: ToolDefinition = defineTool(
  'agreement_subcontract',
  agreementSubcontractCapability.params,
  handlerFor('agreement_subcontract'),
  { description: agreementSubcontractCapability.descriptions.sdk, isAgreementCreation: true },
);

export const agreementRespondTool: ToolDefinition = defineTool(
  'agreement_respond',
  { agreementId: { type: 'string', required: true }, action: { type: 'string', required: true, enum: ['approve', 'reject'] } },
  handlerFor('agreement_respond'),
  { description: 'Approve or reject a pending DIRECT agreement proposal addressed to you. Open broadcasts (requests, standing offers, link invites) have no personal approval slot — claim those with agreement_claim instead, or ignore them to pass. ONE exception: a hand-off that pins YOU as provider carries your pending approval even as an open broadcast — approving consents to serving whoever claims it (the row stays open for claims); rejecting cancels the hand-off. Ignoring it leaves the hand-off unclaimable, so always respond.' },
);

export const agreementClaimTool: ToolDefinition = defineTool(
  'agreement_claim',
  agreementClaimCapability.params,
  handlerFor('agreement_claim'),
  { description: agreementClaimCapability.descriptions.sdk },
);

export const taskSetResultTool: ToolDefinition = defineTool(
  'task_set_result',
  {
    taskId: { type: 'string', required: true },
    // same param name as MCP ziggs_task_set_result / PATCH /tasks/:id/state.
    state: { type: 'string', required: true, enum: ['completed', 'failed'] },
    // Same object contract as MCP ({ summary, status, links, … }).
    result: {
      type: 'object',
      description: 'Outcome payload (summary, status, links, …). This is what the next agent reads when it picks the work up from its own inbox.',
    },
    sources: SOURCES_PARAM,
  },
  handlerFor('task_set_result'),
  { description: 'Transition a task to its terminal state, completed or failed, and record the result. To cancel a task use task_cancel. Set the result here as an object ({ summary, status, links }): a task the parties opted into is closed by this call, whatever else you also sent them. Pass state (not status). This closes the task and not the engagement: a standing hire stays active for the next task, ending one is agreement_fulfill. The reply reports what actually happened — what was stored, who the completion was queued for (queued, not read), what per-task metering did — so report those and no more; a completed task is not by itself a paid one.' },
);

export const agreementCounterTool: ToolDefinition = defineTool(
  'agreement_counter',
  {
    agreementId: { type: 'string', required: true },
    price: AGREEMENT_TERMS_PARAMS.price,
    agreementDescription: 'string',
    expiresAt: AGREEMENT_TERMS_PARAMS.expiresAt,
    lifecycle: AGREEMENT_TERMS_PARAMS.lifecycle,
    maxExecutions: AGREEMENT_TERMS_PARAMS.maxExecutions,
    interactionMode: AGREEMENT_TERMS_PARAMS.interactionMode,
    conversationAllowance: AGREEMENT_TERMS_PARAMS.conversationAllowance,
    description: 'string',
    sources: AGREEMENT_TERMS_PARAMS.sources,
  },
  handlerFor('agreement_counter'),
  { description: 'Counter a pending proposal with revised terms instead of approving or rejecting. Check status first with agreement_get.' },
);

export const agreementGetTool: ToolDefinition = defineTool(
  'agreement_get',
  { agreementId: { type: 'string', required: true } },
  handlerFor('agreement_get'),
  { description: 'Read the current proposal status for an agreement (pending, approved, rejected, countered, expired).' },
);

export const agreementRevokeTool: ToolDefinition = defineTool(
  'agreement_revoke',
  { agreementId: { type: 'string', required: true } },
  handlerFor('agreement_revoke'),
  { description: 'Revoke a pending proposal you created so it can no longer be approved. Use when the user has clearly moved on to a different request before responding to the previous proposal card.' },
);

export const agreementFulfillTool: ToolDefinition = defineTool(
  'agreement_fulfill',
  { agreementId: { type: 'string', required: true } },
  handlerFor('agreement_fulfill'),
  { description: 'END an agreement you provide — permanently. Fulfilling terminates the whole relationship, not one deliverable: every grant it conferred is revoked and it cannot be reopened. Linked chats remain independent rooms governed by their own grants. Finished WORK is reported via task_set_result (the task closes; the agreement stays standing for the next task). Only fulfill when the engagement\'s full scope is delivered and nothing more is expected — never a standing hire that just finished a task.' },
);

// `status` names its four values here because nothing else does: the backend is
// the only place the vocabulary was written down, and it now rejects anything
// outside it. Every reader (the chat step badge, the SDK's own plan formatter)
// already treats an unrecognised status as unknown, so a guessed one was never
// going to render — this makes the model's choice a closed set instead.
export const taskUpdatePlanStepTool: ToolDefinition = defineTool(
  'task_update_plan_step',
  {
    taskId: { type: 'string', required: true },
    stepId: { type: 'string', description: 'The step that changed. Omit only when this call is nothing but a waitingOn.' },
    status: {
      type: 'string',
      enum: ['pending', 'in_progress', 'completed', 'skipped'],
      description: 'Step progress. Required with stepId.',
    },
    result: 'string',
    sources: SOURCES_PARAM,
    // Both fields are required, but the required list cannot be declared here:
    // defineTool reads a sibling `required` as the flag that makes waitingOn
    // itself mandatory. The backend enforces the pair; the description says so.
    waitingOn: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['user', 'agent'],
          description: 'Whether the answer has to come from a person or an agent.',
        },
        id: { type: 'string', description: 'Who you asked.' },
      },
      description:
        "Who this task now waits on, because you just asked them: { kind: 'user' | 'agent', id } — both fields required. Send it when you ask — with the step you are ticking, or on its own when the ask is all that happened. Your person then sees the task as waiting on them rather than as running, which is the difference between a job that looks stalled and one that is waiting for an answer. It clears itself: any later progress that does not restate it, and any terminal state, drops it.",
    },
  },
  handlerFor('task_update_plan_step'),
  { description: "Update the status of a single step within a task's plan, and say who you are waiting on when you have just asked somebody. A task with no plan can still carry the waiting-on on its own." },
);

export const taskCreateTool: ToolDefinition = defineTool(
  'task_create',
  { agreementId: { type: 'string', required: true }, description: { type: 'string', required: true }, parentTaskId: 'string', assigneeId: { type: 'string', description: 'Explicitly hand this task to one specific agent (e.g. a worker your orchestrator selected via agent search) instead of leaving it unassigned. Must be a party on the agreement (payer, provider, creator, or creator agent).' }, inputArtifactIds: { type: 'array', items: { type: 'string' }, description: 'Prior-step output artifact handles, for structured input links.' }, plan: { type: 'object' }, planReviewTiming: planReviewTimingParam, requireMidWorkPlanAck: 'boolean', dueAt: dueAtParam, checkBack: checkBackParam, sources: SOURCES_PARAM },
  handlerFor('task_create'),
  { description: 'Create a new task under an existing approved agreement. Use when the contract is already in place. Pass assigneeId to delegate the task to a specific agent rather than leaving it open. For work that means chasing an answer out of somebody, set dueAt and checkBack so the holder knows when to stop and how often it may remind.' },
);

export const PROTOCOL_TOOLS: ToolDefinition[] = [
  agreementProposeTool, agreementSubcontractTool,
  agreementRespondTool, agreementClaimTool, agreementCounterTool, agreementGetTool, agreementRevokeTool,
  agreementFulfillTool,
  taskCreateTool, taskSetResultTool, taskUpdatePlanStepTool,
];
