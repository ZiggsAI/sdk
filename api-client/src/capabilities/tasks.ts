import { cancelTask, listTasks, type TaskWriteConfirm } from '../http/TaskClient.js';
import {
  type CapabilityDefinition,
  type CapabilityEnv,
  fullCreds,
  rethrowWithContext,
} from './types.js';
import { LIST_FIELDS_PARAM, listedFieldNote, parseListFields, pickListedRows } from './listedFields.js';
import {
  nextCall,
  workContextFromEnv,
  type NextCall,
  type NextCallOutcome,
  type WorkContext,
} from './nextCall.js';

/**
 * One list-tasks verb. MCP and the hosted SDK both used to re-declare the
 * same GET /tasks filters; assignedToMe vs assignedTo precedence then
 * drifted independently. The handler is the single place that resolves
 * those shorthands onto the HTTP query.
 */
export const listTasksCapability: CapabilityDefinition = {
  key: 'task_list',
  names: { sdk: 'task_list', mcp: 'ziggs_task_list' },
  title: 'List tasks',
  descriptions: {
    sdk: 'List tasks reachable by this agent (GET /tasks). Scope follows the operator key — same reach as chats and agreements. Optional state / assignee filters and cursor pagination. Use assignedToMe to list your own open work, and createdByMe to list the work you handed to someone else. Pass fields to keep only those keys on each row.',
  },
  annotation: 'read-only',
  params: {
    state: {
      type: 'string',
      description: 'Filter by state: active, completed, failed, cancelled',
    },
    cursor: {
      type: 'string',
      description: 'Opaque cursor from a prior nextCursor',
    },
    limit: {
      type: 'number',
      description: 'Max rows (server default when omitted)',
    },
    assignedTo: {
      type: 'string',
      description: 'Filter to tasks assigned to this agent/user id',
    },
    createdByMe: {
      type: 'boolean',
      description:
        'Tasks YOU created — the work you handed out to others. This is the check before delegating: assignedToMe lists only what was handed TO you, so a job you already assigned does not appear there and you would assign it twice.',
    },
    assignedToMe: {
      type: 'boolean',
      description:
        "Shorthand for assignedTo=<this agent's id>. Takes precedence over assignedTo when both are set.",
    },
    fields: LIST_FIELDS_PARAM,
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const assignedTo = args['assignedToMe']
      ? 'self'
      : (args['assignedTo'] as string | undefined);
    const createdBy = args['createdByMe'] ? 'self' : undefined;
    const listed = await listTasks(
      {
        state: args['state'] as string | undefined,
        cursor: args['cursor'] as string | undefined,
        limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
        assignedTo,
        ...(createdBy ? { createdBy } : {}),
      },
      creds,
    );
    const fields = parseListFields(args['fields']);
    return fields
      ? {
          ...listed,
          tasks: pickListedRows(listed.tasks, fields),
          ...listedFieldNote(listed.tasks, fields),
        }
      : listed;
  },
};

/**
 * Withdraw a task — including a held graph, which is one cancel on the root.
 * Catalog, not native: this is the pointer AX-07 names, not a new protocol verb.
 */
export const cancelTaskCapability: CapabilityDefinition = {
  key: 'task_cancel',
  names: { sdk: 'task_cancel', mcp: 'ziggs_task_cancel' },
  title: 'Cancel a task',
  descriptions: {
    sdk: 'Cancel one task (PATCH /tasks/:id/cancel). Cancelling a job cancels its live children — that is one act, not a blocked state. Cancel ends this task; it does not amend a live hire.',
  },
  annotation: 'destructive',
  params: {
    taskId: {
      type: 'string',
      required: true,
      description: 'The task to cancel. To withdraw a whole job, pass the job.',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    try {
      return await cancelTask(args['taskId'] as string, fullCreds(env));
    } catch (e) {
      rethrowWithContext(e, 'task_cancel');
    }
  },
};

/**
 * What a terminal transition actually did, as the server reported it.
 *
 * Mirrors the backend's `effects` block on the task write confirmation. Every
 * field is optional because an older server does not send it, and a fact that
 * did not arrive must not be narrated: silence beats a guess about money.
 */
export interface TaskOutcomeEffects {
  resultRecorded?: boolean;
  /** The transition was a de-duplicated replay; no effect ran a second time. */
  replayed?: boolean;
  /** Who a completion wake was QUEUED for — never who read it. */
  notified?: string[];
  settlement?: {
    metered: boolean;
    settled: boolean;
    reason?: string;
    amount?: number;
    transactionId?: string;
  };
  agreement?: {
    agreementId: string;
    billing?: string | null;
    status?: string | null;
    fulfilledNow: boolean;
  };
}

export interface TaskOutcomePresentation {
  ok: true;
  taskId: string;
  state: string;
  outcome: NextCallOutcome;
  /** Where the outcome now lives, and who can read it. */
  recorded: string;
  /** What was queued for whom — stated as queued, never as received. */
  handoff?: string;
  /** Delivery to the person, which a task result is not. */
  delivery?: string;
  /** What metering did on this completion. Absent when the server said nothing. */
  metering?: string;
  /** What the agreement is now. Absent when the server said nothing. */
  agreement?: string;
  next: NextCall[];
  workContext?: WorkContext;
}

/** Why a metered settlement moved nothing, in words rather than a code. */
const SETTLEMENT_REASONS: Readonly<Record<string, string>> = {
  not_metered: 'this agreement does not bill per completed task',
  unpriced: 'the agreement carries no price',
  parties_unresolved: 'the paying or providing side is not a resolvable party',
  self_hire: 'payer and provider are the same side — paying yourself is a no-op',
  same_wallet: 'both sides resolve to one wallet',
  wallet_missing: 'a wallet is missing',
  transfer_failed: 'the transfer failed and is left for reconciliation',
  agreement_missing: 'the agreement could not be read',
};

/**
 * Present a terminal transition as the four separate facts it produces.
 *
 * `{ ok: true, state: 'completed' }` was the whole answer, and four
 * different claims were read out of it: the work is delivered, the next agent
 * has it, the money moved, the engagement is done. Only the first is in the
 * word. The rest are effects the server ran (or declined to run) beside it, and
 * each one gets its own clause here — including the ones that say nothing
 * happened, because "no settlement ran" is exactly the fact an agent otherwise
 * fills in with an assumption.
 *
 * The lookup route is named rather than described: a completion whose response
 * was lost is recovered by reading the task back, not by completing it twice.
 */
export function presentTaskOutcome(
  confirm: TaskWriteConfirm,
  env: CapabilityEnv,
): TaskOutcomePresentation {
  const effects = (confirm as { effects?: TaskOutcomeEffects }).effects;
  const workContext = workContextFromEnv(env);
  const taskId = confirm.taskId;
  const state = String(confirm.state);
  const completed = state === 'completed';
  const stored = effects?.resultRecorded ?? confirm.resultRecorded ?? false;
  // MCP delegates read one task by id; the hosted surface lists its own work.
  const lookupKey = env.surface === 'mcp' ? 'task_get' : 'task_list';
  const lookup = nextCall(
    env,
    lookupKey,
    lookupKey === 'task_get' ? { taskId } : { assignedToMe: true },
    'read the recorded outcome back — the route for a completion whose response you never saw, and the one that never completes the task twice',
  );

  const recorded = effects?.replayed
    ? `Task ${taskId} was already ${state}: this call matched a transition already applied, so nothing was recorded, queued, metered or fulfilled a second time.`
    : stored
      ? `Task ${taskId} is ${state} and its result is stored on the task. That is where the next agent reads it — it stays readable whether or not any notification lands.`
      : `Task ${taskId} is ${state} with no result payload stored. Nothing is waiting there for the next reader.`;

  const notified = effects?.notified;
  const handoff =
    notified === undefined
      ? undefined
      : notified.length > 0
        ? `Completion queued for ${notified.join(', ')}. Queued is not read: the wake says it was sent, never that anyone has it.`
        : 'No completion wake was queued — nobody on this agreement was addressable, so the result waits to be read rather than delivered.';

  const delivery = completed
    ? 'A task result is how the next AGENT collects the work. If a person set this goal, send it to them as well, in the conversation the work rides on — that delivery is a chat message, not a second record.'
    : undefined;

  const settlement = effects?.settlement;
  const metering = !settlement
    ? undefined
    : settlement.settled
      ? `Metered per completed task: this completion settled ${settlement.amount ?? 'the agreed rate'}${settlement.transactionId ? ` (tx ${settlement.transactionId})` : ''}. One execution, once — a retry of this same transition does not charge again.`
      : `No payment moved on this completion — ${SETTLEMENT_REASONS[settlement.reason ?? ''] ?? settlement.reason ?? 'settlement did not run'}. Do not report this task as paid.`;

  const agreementFacts = effects?.agreement;
  const agreement = !agreementFacts
    ? undefined
    : agreementFacts.fulfilledNow
      ? `Agreement ${agreementFacts.agreementId} reached its execution quota and is now fulfilled — the engagement is over, and its grants went with it.`
      : `Agreement ${agreementFacts.agreementId} is still ${agreementFacts.status ?? 'in force'}${agreementFacts.billing === 'per_task' ? ', charging per completed task' : agreementFacts.billing === 'total' ? ', priced as one total for the engagement' : ''}. Finishing a task does not end a hire; ending one is its own deliberate call.`;

  return {
    ok: true,
    taskId,
    state,
    outcome: 'ok',
    recorded,
    ...(handoff ? { handoff } : {}),
    ...(delivery ? { delivery } : {}),
    ...(metering ? { metering } : {}),
    ...(agreement ? { agreement } : {}),
    next: [lookup],
    ...(workContext ? { workContext } : {}),
  };
}

export const TASK_CAPABILITIES: CapabilityDefinition[] = [
  listTasksCapability,
  cancelTaskCapability,
];
