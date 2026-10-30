import type { WriteSource } from '../capabilities/sources.js';
import { decodeOperatorKeyClaims } from '../shared/operatorKey.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { type Creds, type Task, type TaskState, partyActorIds } from '../types.js';
import { throwApiError } from '../shared/apiError.js';
import { buildCredsHeaders, withoutExecution } from './operatorHeaders.js';

function getTaskBaseUrl(): string { return `${getBackendUrl()}/tasks`; }

// Auth, agent and the wake's lane, from the one helper — see operatorHeaders.
const buildHeaders = buildCredsHeaders;

function assertCreds(creds: Creds | undefined | null, op: string): asserts creds is Creds {
  if (!creds?.operatorKey) throw new Error(`operatorKey is required for ${op}`);
  if (!creds?.agentId && !decodeOperatorKeyClaims(creds.operatorKey)?.connectionClientId) throw new Error(`agentId is required for ${op}`);
}


function extractTask(data: unknown): Task | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d['task'] && typeof d['task'] === 'object' && (d['task'] as Record<string, unknown>)['taskId']) {
    return d['task'] as Task;
  }
  // Top-level task document (GET / create). Do not treat thin write confirms
  // (`ok: true`, no description) as a Task.
  if (typeof d['taskId'] === 'string' && d['ok'] !== true) {
    return d as unknown as Task;
  }
  return null;
}

/**
 * Thin confirmation from task write verbs. Full object stays on
 * getTask / ziggs_task_get.
 */
export interface TaskWriteConfirm {
  ok: true;
  taskId: string;
  /** The agreement the task hangs under, when the server reports it. */
  agreementId?: string;
  state: TaskState;
  updatedAt?: string;
  status?: string;
  stepCount?: number;
  structureChanged?: boolean;
  stepId?: string;
  stepStatus?: string;
  patchedCount?: number;
  resultRecorded?: boolean;
  terminalState?: string;
  [key: string]: unknown;
}

export interface TaskControl {
  requestId: string;
  action: 'pause' | 'resume' | 'stop';
  status: 'requested' | 'acknowledged' | 'unsupported';
  requestedAt: string;
  acknowledgedAt: string | null;
}

export async function requestTaskControl(taskId: string, request: {
  action: TaskControl['action']; requestId: string; previousRequestId: string | null;
}, creds: Creds): Promise<TaskWriteConfirm> {
  return writeTaskControl(taskId, 'control', 'PATCH', request, creds);
}

/** Runtime-only: call after all work for this task has quiesced, never on receipt alone. */
export async function acknowledgeTaskControl(taskId: string, requestId: string, supported: boolean, creds: Creds): Promise<TaskWriteConfirm> {
  return writeTaskControl(taskId, 'control/ack', 'POST', { requestId, supported }, creds);
}

async function writeTaskControl(taskId: string, path: string, method: string, body: unknown, creds: Creds): Promise<TaskWriteConfirm> {
  if (!taskId) throw new Error('Task control requires a taskId');
  assertCreds(creds, 'task control');
  const res = await fetch(`${getTaskBaseUrl()}/${encodeURIComponent(taskId)}/${path}`, {
    // A quiescence receipt must remain possible after the task execution has
    // been stopped. The server still checks executor identity and requestId.
    method, headers: path === 'control/ack' ? withoutExecution(buildHeaders(creds)) : buildHeaders(creds), body: JSON.stringify(body),
  });
  if (!res.ok) throwApiError(res, await res.text().catch(() => ''), `Task control failed: ${res.status}`);
  const result = extractWriteConfirm(await res.json());
  if (!result) throw new Error('Invalid task control response');
  return result;
}

function extractWriteConfirm(data: unknown): TaskWriteConfirm | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  // New thin shape (no nested task / no description dump).
  if (
    typeof d['taskId'] === 'string' &&
    typeof d['state'] === 'string' &&
    d['task'] === undefined &&
    d['description'] === undefined
  ) {
    return {
      ok: true,
      ...(d['control'] ? { control: d['control'] } : {}),
      taskId: d['taskId'] as string,
      ...(typeof d['agreementId'] === 'string' ? { agreementId: d['agreementId'] } : {}),
      state: d['state'] as TaskState,
      ...(typeof d['updatedAt'] === 'string' || d['updatedAt'] instanceof Date
        ? { updatedAt: String(d['updatedAt']) }
        : {}),
      ...(typeof d['status'] === 'string' ? { status: d['status'] } : {}),
      ...(typeof d['stepCount'] === 'number' ? { stepCount: d['stepCount'] } : {}),
      ...(typeof d['structureChanged'] === 'boolean'
        ? { structureChanged: d['structureChanged'] }
        : {}),
      ...(typeof d['stepId'] === 'string' ? { stepId: d['stepId'] } : {}),
      ...(typeof d['stepStatus'] === 'string' ? { stepStatus: d['stepStatus'] } : {}),
      ...(typeof d['patchedCount'] === 'number' ? { patchedCount: d['patchedCount'] } : {}),
      ...(d['resultRecorded'] === true ? { resultRecorded: true } : {}),
      ...(typeof d['terminalState'] === 'string'
        ? { terminalState: d['terminalState'] }
        : {}),
    };
  }
  // Legacy fat echo — compress to the thin fields so callers stay forward-compat.
  const task = extractTask(data);
  if (!task?.taskId || !task.state) return null;
  return {
    ok: true,
    taskId: task.taskId,
    state: task.state,
    ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
    ...(typeof d['status'] === 'string' ? { status: d['status'] as string } : {}),
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * When the buyer reviews a task's plan. Task-rail only — an agreement has no
 * plan to review, which is why cut this from the propose/counter/
 * subcontract inputs rather than teaching those routes to keep one.
 */
export type PlanReviewTiming = 'with_proposal' | 'before_execution';

/**
 * One child created with its parent, all or none. `name` only lets siblings
 * name each other in `waitsOn`; it is not stored, and the create answers with
 * the task id each name became.
 */
export interface CreateTaskChildData {
  name: string;
  agreementId: string;
  description: string;
  title?: string;
  assigneeId?: string;
  /** Names of sibling children in the same create that must finish first. */
  waitsOn?: string[];
  joinKind?: 'all' | 'any';
  /** A yes/no question over the children this one waits on; it runs only on yes. */
  runIf?: string;
  inputArtifactIds?: string[];
}

/** What a create with children answers for each one. */
export interface CreatedTaskChild {
  name: string;
  taskId: string;
}

export interface CreateTaskData {
  description: string;
  /**
   * Short label for list rows, around 60 characters, 80 max.
   * Optional: a task without one lists under a trimmed description, which is a
   * wall of prose at a glance. Set it whenever the task is one row among many.
   */
  title?: string;
  agreementId: string;
  parentTaskId?: string;
  plan?: unknown;
  planReviewTiming?: PlanReviewTiming;
  requireMidWorkPlanAck?: boolean;
  idempotencyKey?: string;
  /**
   * Explicit delegation target — must hold a grant on the agreement, so work
   * can only be handed to someone that contract already reaches; validated
   * server-side.
   */
  assigneeId?: string;
  /** Required artifact handles; declaring them grants no access. */
  inputArtifactIds?: string[];
  /**
   * Tasks this one waits for. The task is created immediately, but its assignee
   * is not woken and cannot start it until every task named here is terminal.
   * Declaring an edge needs read reach on the task you name.
   *
   * Declared rather than enacted: state the join up front and the platform
   * wakes the joiner once, instead of a live agent polling for it and holding
   * the shape in its own control flow where nothing else can see it.
   */
  waitsOn?: string[];
  /**
   * How the task closes, fixed at create. `children` (the default when
   * `children` is given) makes it a job that closes when its children close:
   * completed when every child no sibling waits on completed or was skipped.
   * `result` (the default otherwise) closes by its own result.
   */
  closesBy?: 'result' | 'children';
  /**
   * Children created with this task in one call, all or none. The job's
   * `inputArtifactIds` go to the children that wait on nothing, and
   * `planReviewTiming: before_execution` holds every child until this task's
   * plan is acknowledged.
   */
  children?: CreateTaskChildData[];
  /**
   * When the answer stops being useful, ISO 8601. At the deadline
   * the holder posts what it has and where it is stuck, and stops. A deadline
   * already past is refused server-side.
   */
  dueAt?: string;
  /**
   * Reminder cadence and budget for work somebody has to be chased about
   * Both halves are required together: a cadence with no budget is
   * an open-ended wake loop, and one reminder is one wake, so the server
   * refuses a half-filled rule rather than defaulting the missing half. Omit
   * the whole object for a task nobody needs reminding about.
   */
  checkBack?: CreateTaskCheckBackData;
  /** What the title and description drew on. See {@link WriteSource}. */
  sources?: WriteSource[];
}

/** See {@link CreateTaskData.checkBack}. */
export interface CreateTaskCheckBackData {
  /** Minimum minutes between two reminders to the same person. */
  everyMinutes: number;
  /** Total reminders allowed per person asked, after the first ask. */
  maxReminders: number;
}

export async function createTask(
  taskData: CreateTaskData,
  creds: Creds,
): Promise<Task & { children?: CreatedTaskChild[] }> {
  if (!taskData) throw new Error('Task data is required for task creation');
  assertCreds(creds, 'task creation');

  const { idempotencyKey, ...bodyData } = taskData;
  const headers = buildHeaders(creds);
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(getTaskBaseUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyData),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Task creation failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as unknown;
  const task = extractTask(data);
  if (!task) throw new Error('Invalid response: task data not found');
  const children = (data as { children?: unknown } | null)?.children;
  return Array.isArray(children)
    ? { ...task, children: children as CreatedTaskChild[] }
    : task;
}

export async function getTask(taskId: string, creds: Creds): Promise<Task> {
  if (!taskId) throw new Error('getTask: taskId is required');
  assertCreds(creds, 'task retrieval');

  const res = await fetch(`${getTaskBaseUrl()}/${taskId}`, {
    method: 'GET',
    headers: buildHeaders(creds),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Task get failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as unknown;
  const task = extractTask(data);
  if (!task) throw new Error('Invalid response: task data not found');
  return task;
}

export interface UpdateTaskStateData {
  result?: unknown;
  errorMessage?: string;
  /**
   * Optional idempotency key. A redelivered transition carrying the same key
   * no-ops server-side (returns the current task) instead of erroring on an
   * already-terminal task. Sent in the body — the backend reads
   * `UpdateTaskStateDto.idempotencyKey`. Derive it deterministically so a
   * stateless crash-replay reproduces it.
   */
  idempotencyKey?: string;
  /** What the result drew on. Recorded only when a result is written. */
  sources?: WriteSource[];
}

export async function updateTaskState(
  taskId: string,
  state: TaskState,
  data: UpdateTaskStateData = {},
  creds: Creds,
): Promise<TaskWriteConfirm> {
  if (!taskId) throw new Error('updateTaskState: taskId is required');
  if (!state) throw new Error('updateTaskState: state is required');
  assertCreds(creds, 'task state update');

  const res = await fetch(`${getTaskBaseUrl()}/${taskId}/state`, {
    method: 'PATCH',
    headers: buildHeaders(creds),
    body: JSON.stringify({ state, ...data }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Task state update failed: ${res.status} ${res.statusText}`);
  }

  const result = await res.json().catch(() => null) as unknown;
  const confirm = extractWriteConfirm(result);
  if (!confirm) throw new Error('Invalid response: task write confirm not found');
  return confirm;
}

export async function getActiveTasksForAgent(
  agentId: string,
  creds: Creds,
): Promise<Task[]> {
  if (!agentId) throw new Error('getActiveTasksForAgent: agentId is required');
  assertCreds(creds, 'getting active tasks for agent');

  const url = new URL(`${getBackendUrl()}/agents/${encodeURIComponent(agentId)}/tasks`);
  url.searchParams.set('state', 'active');

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: buildHeaders(creds),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Get active tasks for agent failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  const fromAgent = Array.isArray(data?.['tasks']) ? (data['tasks'] as Task[]) : [];
  if (fromAgent.length > 0) return workable(fromAgent);

  // Fallback when /agents/:id/tasks is empty but party-agreement tasks exist.
  return getActiveTasksForAgentViaPartyAgreements(agentId, creds);
}

/**
 * Drop the tasks the platform created but deliberately did not deliver.
 *
 * `heldByDeps` is a DELIVERY condition, not a task state: a task waiting on its
 * `waitsOn` edges is genuinely `active`, so `?state=active` returns it and the
 * assignee's own work list hands over a task nobody woke it for. Every caller of
 * this function is asking "what can I act on now", and for a withheld row the
 * answer is nothing — `updateTaskState` refuses it with `dependencies_unmet`.
 * Two of Agent's three callers do worse than waste a wake: the needs gate
 * and the unmet-access sweep both FAIL the tasks they find, so a withheld node
 * was one missing grant away from being failed before its turn came.
 *
 * Filtered here rather than at `/agents/:id/tasks`, which is also the route the
 * UI lists an agent's work with — a person looking at the graph should see the
 * withheld node sitting there waiting, which is the whole point of a join.
 */
function workable(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.heldByDeps !== true);
}

async function getActiveTasksForAgentViaPartyAgreements(
  agentId: string,
  creds: Creds,
): Promise<Task[]> {
  const { listAgreements } = await import('./AgreementClient.js');
  const agreements = await listAgreements({ status: 'active' }, creds);
  const partyIds = agreements
    .filter((a) => partyActorIds(a.parties).includes(agentId))
    .map((a) => a.agreementId)
    .filter(Boolean) as string[];
  if (partyIds.length === 0) return [];

  const lists = await Promise.all(
    partyIds.map(async (aid) => {
      const url = new URL(`${getBackendUrl()}/agreements/${encodeURIComponent(aid)}/tasks`);
      url.searchParams.set('state', 'active');
      const res = await fetch(url.toString(), { method: 'GET', headers: buildHeaders(creds) });
      if (!res.ok) return [] as Task[];
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      return Array.isArray(data?.['tasks']) ? (data['tasks'] as Task[]) : [];
    }),
  );
  const merged = lists.flat();
  return workable(merged.filter((t) => !t.assigneeId || t.assigneeId === agentId));
}

// Backend deliberately has no `/chats/:id/tasks` route — it's composable
// from links → per-agreement tasks. We do the composition here so callers
// don't have to.
export async function getActiveTasksForChat(
  chatId: string,
  creds: Creds,
): Promise<Task[]> {
  if (!chatId) throw new Error('getActiveTasksForChat: chatId is required');
  assertCreds(creds, 'getting active tasks for chat');

  const linksRes = await fetch(
    `${getBackendUrl()}/agreements/by-chat/${encodeURIComponent(chatId)}`,
    { method: 'GET', headers: buildHeaders(creds) },
  );
  if (!linksRes.ok) {
    const body = await linksRes.text().catch(() => '');
    throwApiError(linksRes, body, `Get agreements for chat failed: ${linksRes.status} ${linksRes.statusText}`);
  }
  const linksData = await linksRes.json().catch(() => null) as Record<string, unknown> | null;
  const rawLinks = linksData?.['links'] ?? linksData?.['agreements'];
  const agreements = Array.isArray(rawLinks) ? (rawLinks as Array<Record<string, unknown>>) : [];
  const agreementIds = Array.from(new Set(agreements.map((a) => a['agreementId'] as string).filter(Boolean)));
  if (agreementIds.length === 0) return [];

  const lists = await Promise.all(
    agreementIds.map(async (aid) => {
      const url = new URL(`${getBackendUrl()}/agreements/${encodeURIComponent(aid)}/tasks`);
      url.searchParams.set('state', 'active');
      const res = await fetch(url.toString(), { method: 'GET', headers: buildHeaders(creds) });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throwApiError(res, body, `Get tasks for agreement ${aid} failed: ${res.status}`);
      }
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      return Array.isArray(data?.['tasks']) ? (data['tasks'] as Task[]) : [];
    }),
  );
  return lists.flat();
}

export async function cancelTask(taskId: string, creds: Creds): Promise<TaskWriteConfirm> {
  if (!taskId) throw new Error('cancelTask: taskId is required');
  assertCreds(creds, 'task cancellation');

  const res = await fetch(`${getTaskBaseUrl()}/${taskId}/cancel`, {
    method: 'PATCH',
    headers: buildHeaders(creds),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Task cancel failed: ${res.status} ${res.statusText}`);
  }

  const result = await res.json().catch(() => null) as unknown;
  const confirm = extractWriteConfirm(result);
  if (!confirm) throw new Error('Invalid response: task write confirm not found');
  return confirm;
}

export async function getSubtasks(parentTaskId: string, creds: Creds): Promise<Task[]> {
  if (!parentTaskId) throw new Error('getSubtasks: parentTaskId is required');
  assertCreds(creds, 'getting subtasks');

  const url = new URL(`${getTaskBaseUrl()}/${encodeURIComponent(parentTaskId)}/subtasks`);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: buildHeaders(creds),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Get subtasks failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return Array.isArray(data?.['tasks']) ? (data['tasks'] as Task[]) : [];
}

export interface PlanReplaceStep {
  /** Omit to let the server mint `step-<n>`. */
  stepId?: string;
  description: string;
  /** Omit to use the array index. */
  order?: number;
  /**
   * Step progress. Omit for `pending`. Send `completed` /
   * `in_progress` when replacing the plan so a later task completion does not
   * rewrite finished steps as skipped.
   */
  status?: 'pending' | 'in_progress' | 'completed' | 'skipped';
  /** Optional step output stored with this replace. */
  result?: unknown;
  /** What this text drew on. See {@link WriteSource}. */
  sources?: WriteSource[];
}

export async function replaceTaskPlan(
  taskId: string,
  steps: PlanReplaceStep[],
  creds: Creds,
): Promise<TaskWriteConfirm> {
  if (!taskId) throw new Error('replaceTaskPlan: taskId is required');
  if (!steps || !Array.isArray(steps)) throw new Error('replaceTaskPlan: steps must be an array');
  assertCreds(creds, 'plan replace');

  const res = await fetch(`${getTaskBaseUrl()}/${taskId}/plan`, {
    method: 'PATCH',
    headers: buildHeaders(creds),
    body: JSON.stringify({ steps }),
  });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => '');
    throwApiError(res, responseBody, `Plan replace failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as unknown;
  const confirm = extractWriteConfirm(data);
  if (!confirm) throw new Error('Invalid response: task write confirm not found');
  return confirm;
}

/** Named-step progress — only the listed steps change. */
export type PlanStepPatch = {
  stepId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  result?: unknown;
  /** What this step drew on. See {@link WriteSource}. */
  sources?: WriteSource[];
};

/**
 * Who the holder is waiting on, because its last act was asking them.
 *
 * Rides the progress write because that is when it is known and that is what
 * makes it false again: the server clears it on the next progress write that
 * does not restate it, and on any terminal transition. A holder that did
 * something else after asking is no longer waiting.
 */
export type TaskWaitingOn = { kind: 'user' | 'agent'; id: string };

export async function updateTaskPlanSteps(
  taskId: string,
  patches: PlanStepPatch[],
  creds: Creds,
  waitingOn?: TaskWaitingOn | null,
): Promise<TaskWriteConfirm> {
  if (!taskId) throw new Error('updateTaskPlanSteps: taskId is required');
  const named = Array.isArray(patches) ? patches : [];
  // A bare waiting-on write is the ask that produced no other progress, and
  // the route takes it on its own. Without this the only way to say "I asked
  // Dana" was to invent a plan step to tick.
  if (named.length === 0 && !waitingOn) {
    throw new Error('updateTaskPlanSteps: patches must name at least one step');
  }
  for (const patch of named) {
    if (!patch?.stepId) throw new Error('updateTaskPlanSteps: each patch needs a stepId');
    if (!patch?.status) throw new Error('updateTaskPlanSteps: each patch needs a status');
  }
  assertCreds(creds, 'plan step patch');

  const res = await fetch(`${getTaskBaseUrl()}/${taskId}/plan`, {
    method: 'PATCH',
    headers: buildHeaders(creds),
    body: JSON.stringify({
      ...(named.length > 0 ? { patches: named } : {}),
      ...(waitingOn !== undefined ? { waitingOn } : {}),
    }),
  });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => '');
    throwApiError(res, responseBody, `Plan step patch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as unknown;
  const confirm = extractWriteConfirm(data);
  if (!confirm) throw new Error('Invalid response: task write confirm not found');
  return confirm;
}

export async function updateTaskPlanStep(
  taskId: string,
  stepId: string,
  status: string,
  result: unknown,
  creds: Creds,
  waitingOn?: TaskWaitingOn | null,
  sources?: WriteSource[],
): Promise<TaskWriteConfirm> {
  if (!taskId) throw new Error('updateTaskPlanStep: taskId is required');
  if (!stepId) throw new Error('updateTaskPlanStep: stepId is required');
  if (!status) throw new Error('updateTaskPlanStep: status is required');
  assertCreds(creds, 'plan step update');

  const res = await fetch(`${getTaskBaseUrl()}/${taskId}/plan`, {
    method: 'PATCH',
    headers: buildHeaders(creds),
    // One write, not two: the server clears `waitingOn` on a progress write
    // that does not restate it, so posting the tick and the ask separately
    // would set it and then immediately drop it.
    body: JSON.stringify({
      stepId,
      status,
      ...(result !== undefined && { result }),
      ...(waitingOn !== undefined ? { waitingOn } : {}),
      ...(sources ? { sources } : {}),
    }),
  });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => '');
    throwApiError(res, responseBody, `Plan step update failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as unknown;
  const confirm = extractWriteConfirm(data);
  if (!confirm) throw new Error('Invalid response: task write confirm not found');
  return confirm;
}

// ---------------------------------------------------------------------------
// Reporting & satisfaction
// ---------------------------------------------------------------------------

export async function reportTask(taskId: string, message = '', creds: Creds): Promise<TaskWriteConfirm> {
  if (!taskId) throw new Error('reportTask: taskId is required');
  assertCreds(creds, 'task report');

  const res = await fetch(`${getTaskBaseUrl()}/${taskId}/report`, {
    method: 'POST',
    headers: buildHeaders(creds),
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Task report failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as unknown;
  const confirm = extractWriteConfirm(data);
  if (!confirm) throw new Error('Invalid response: task write confirm not found');
  return confirm;
}

export async function setTaskSatisfaction(
  taskId: string,
  satisfaction: 'positive' | 'negative',
  creds: Creds,
): Promise<TaskWriteConfirm> {
  if (!taskId) throw new Error('setTaskSatisfaction: taskId is required');
  if (!satisfaction) throw new Error('setTaskSatisfaction: satisfaction is required');
  assertCreds(creds, 'task satisfaction');

  const res = await fetch(`${getTaskBaseUrl()}/${taskId}/satisfaction`, {
    method: 'PATCH',
    headers: buildHeaders(creds),
    body: JSON.stringify({ satisfaction }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Task satisfaction failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as unknown;
  const confirm = extractWriteConfirm(data);
  if (!confirm) throw new Error('Invalid response: task write confirm not found');
  return confirm;
}

export interface ListTasksOptions {
  state?: string;
  cursor?: string;
  limit?: number;
  /** Filter to tasks assigned to this id. */
  assignedTo?: string;
  /**
   * Filter to tasks CREATED by this id — what the caller handed out, as
   * opposed to what was handed to it.
   */
  createdBy?: string;
}

export interface ListTasksResult {
  tasks: Task[];
  hasMore: boolean;
  nextCursor?: string | null;
}

export async function listTasks(options: ListTasksOptions = {}, creds: Creds): Promise<ListTasksResult> {
  assertCreds(creds, 'list tasks');

  const url = new URL(getTaskBaseUrl());
  if (options.state) url.searchParams.set('state', options.state);
  if (options.cursor) url.searchParams.set('cursor', options.cursor);
  if (options.limit != null) url.searchParams.set('limit', String(options.limit));
  if (options.assignedTo) url.searchParams.set('assignedTo', options.assignedTo);
  if (options.createdBy) url.searchParams.set('createdBy', options.createdBy);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: buildHeaders(creds),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `List tasks failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  const tasks = Array.isArray(data?.['tasks']) ? (data['tasks'] as Task[]) : [];
  return {
    tasks,
    hasMore: Boolean(data?.['hasMore']),
    nextCursor: (data?.['nextCursor'] as string | null | undefined) ?? null,
  };
}

export interface CountTasksFilters {
  chatId?: string;
  state?: string;
  userId?: string;
  agentId?: string;
}

export async function countTasks(filters: CountTasksFilters = {}, creds: Creds): Promise<number> {
  assertCreds(creds, 'count tasks');

  // Canonical REST: GET /tasks/count.
  const url = new URL(`${getTaskBaseUrl()}/count`);
  if (filters.chatId) url.searchParams.set('chatId', filters.chatId);
  if (filters.state) url.searchParams.set('state', filters.state);
  if (filters.userId) url.searchParams.set('userId', filters.userId);
  if (filters.agentId) url.searchParams.set('agentId', filters.agentId);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: buildHeaders(creds),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throwApiError(res, body, `Count tasks failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return typeof data?.['count'] === 'number' ? data['count'] : 0;
}

// ---------------------------------------------------------------------------
// TaskClient class — bind creds once
// ---------------------------------------------------------------------------

export class TaskClient {
  private creds: Creds;

  /**
   * @param operatorKey Agent-scoped or fleet operator key.
   * @param agentId Required for fleet keys (sent as X-Agent-Id). Omit for agent-scoped keys.
   */
  constructor(operatorKey: string, agentId?: string) {
    if (!operatorKey) throw new Error('TaskClient: operatorKey is required');
    // agentId may be absent for agent-scoped keys; the Creds-based
    // standalone functions still assert it per call.
    this.creds = { operatorKey, agentId } as Creds;
  }

  requestControl(taskId: string, request: Parameters<typeof requestTaskControl>[1]) { return requestTaskControl(taskId, request, this.creds); }
  acknowledgeControl(taskId: string, requestId: string, supported = true) { return acknowledgeTaskControl(taskId, requestId, supported, this.creds); }
  createTask(data: CreateTaskData)                                          { return createTask(data, this.creds); }
  getTask(taskId: string)                                                   { return getTask(taskId, this.creds); }
  updateTaskState(taskId: string, state: TaskState, data?: UpdateTaskStateData) { return updateTaskState(taskId, state, data ?? {}, this.creds); }
  getActiveTasksForAgent(agentId: string)                                   { return getActiveTasksForAgent(agentId, this.creds); }
  getActiveTasksForChat(chatId: string)                                     { return getActiveTasksForChat(chatId, this.creds); }
  cancelTask(taskId: string)                                                { return cancelTask(taskId, this.creds); }
  getSubtasks(parentTaskId: string)                                         { return getSubtasks(parentTaskId, this.creds); }
  replaceTaskPlan(taskId: string, steps: PlanReplaceStep[])                 { return replaceTaskPlan(taskId, steps, this.creds); }
  updateTaskPlanStep(taskId: string, stepId: string, status: string, result?: unknown) { return updateTaskPlanStep(taskId, stepId, status, result, this.creds); }
  updateTaskPlanSteps(taskId: string, patches: PlanStepPatch[])             { return updateTaskPlanSteps(taskId, patches, this.creds); }
  reportTask(taskId: string, message?: string)                              { return reportTask(taskId, message, this.creds); }
  setTaskSatisfaction(taskId: string, satisfaction: 'positive' | 'negative') { return setTaskSatisfaction(taskId, satisfaction, this.creds); }
  listTasks(options?: ListTasksOptions)                                      { return listTasks(options ?? {}, this.creds); }
  countTasks(filters?: CountTasksFilters)                                   { return countTasks(filters, this.creds); }
}

/** Controlled work transfer; the source execution header is preserved. */
export async function delegateTask(taskId: string, body: {
  agreementId: string; assigneeId: string; instructionArtifactId: string;
  inputArtifactIds?: string[]; idempotencyKey?: string;
}, creds: Creds): Promise<{ taskId: string; agreementId: string; parentTaskId: string }> {
  const { idempotencyKey, ...payload } = body;
  return taskTransfer(taskId, 'delegations', payload, creds, idempotencyKey);
}

export async function returnTaskResult(taskId: string, artifactId: string, creds: Creds): Promise<{ taskId: string; parentTaskId: string; artifactId: string; outcome: 'created' | 'existing' }> {
  return taskTransfer(taskId, 'return', { artifactId }, creds);
}

export async function refreshTaskReadiness(taskId: string, creds: Creds): Promise<{ taskId: string; ready: boolean; state: string }> {
  return taskTransfer(taskId, 'readiness', {}, creds);
}

async function taskTransfer<T>(taskId: string, path: string, body: unknown, creds: Creds, key?: string): Promise<T> {
  assertCreds(creds, 'task transfer');
  if (!taskId) throw new Error('taskId is required');
  const headers = buildHeaders(creds);
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(`${getTaskBaseUrl()}/${encodeURIComponent(taskId)}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throwApiError(res, await res.text().catch(() => ''), `Task transfer failed: ${res.status}`);
  return res.json() as Promise<T>;
}
