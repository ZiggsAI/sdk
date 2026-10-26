import { AsyncLocalStorage } from 'node:async_hooks';
import { annotationForSdkTool, type CreateTaskData, type Task } from '@ziggs-ai/api-client';
import type { ToolDefinition } from '../tools/defineTool.js';
import { toolName } from '../tools/defineTool.js';
import { isListing } from './agreementContext.js';
import { createDeliveryWriteKeys } from './deliveryWriteKeys.js';
import { workScopeFromWake, type WorkScope } from './wakeEffects.js';

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const id = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v : undefined;

export interface ExecutionBinding { agreementId: string; taskId: string }

interface ControllerOptions {
  agentId: string;
  sessionId: string;
  laneKey: string;
  event: unknown;
  readAgreement(id: string): Promise<unknown>;
  readTask(id: string): Promise<Task>;
  createTask(data: CreateTaskData): Promise<Task>;
  onTaskCreated?(task: Task): void;
  signal?: AbortSignal;
}

// These operations obtain context or negotiate/track authority. The backend
// still authorizes each operation. None of their arguments grants execution
// authority to this controller. Unknown and custom tools require work by default.
const CONTROL_TOOLS = new Set([
  'context_snapshot', 'agreement_get', 'agreement_propose', 'agreement_counter',
  'agreement_respond', 'agreement_claim', 'task_create', 'wake_at',
  'mcp_tools_list', 'connection_list_grants', 'skill_read_reference', 'access_request', 'chat_open',
]);

export class ExecutionRefusal extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}

/** Per-wake bookkeeping, never a replacement for backend grants. */
export class ExecutionController {
  private scope: WorkScope;
  private sawSnapshot = false;
  private readonly conflictingBatch: boolean;
  private creating?: Promise<Task>;
  private binding?: ExecutionBinding;
  private closed = false;

  constructor(private readonly options: ControllerOptions) {
    this.scope = workScopeFromWake(options.event, options.sessionId);
    const event = row(options.event);
    this.conflictingBatch = event.type === 'batch' && !this.scope.agreementId && !this.scope.taskId
      && Array.isArray(event.events) && event.events.some(e => Object.keys(workScopeFromWake(e, options.sessionId)).length > 0);
  }

  get activeBinding(): ExecutionBinding | undefined { return this.closed ? undefined : this.binding; }

  /** Only the first host snapshot of this wake can resolve an otherwise empty scope. */
  observeSnapshot(sessionId: string, value: unknown): void {
    if (sessionId !== this.options.sessionId || this.sawSnapshot) return;
    this.sawSnapshot = true;
    if (this.conflictingBatch) return;
    const snap = row(value);
    if (snap.unavailable || snap.chatMissing) return;
    const work = row(snap.work);
    if (Array.isArray(work.contexts)) return;
    const agreementId = id(work.agreementId);
    const taskId = id(row(work.task).taskId);
    if (agreementId && (!this.scope.agreementId || this.scope.agreementId === agreementId)
      && (!this.scope.taskId || this.scope.taskId === taskId)) {
      this.scope = { agreementId, ...(taskId ? { taskId } : {}) };
    }
  }

  private refuse(code: string, message: string): never { throw new ExecutionRefusal(code, message); }

  private assertLive(): void {
    if (this.options.signal?.aborted) this.refuse('EXECUTION_STOPPED', 'This wake has stopped. No new work can execute.');
  }

  private assertTask(task: Task, agreementId: string, planning = false): void {
    if (!task.taskId || task.agreementId !== agreementId
      || (task.executorIsYou !== true && task.assigneeId !== this.options.agentId)) {
      this.refuse('TASK_SCOPE_MISMATCH', 'The task must belong to this agreement and be assigned to this agent.');
    }
    const review = row(task.planReview);
    if (task.state !== 'active' || task.control?.action === 'pause' || task.control?.action === 'stop'
      || (!planning && (task.heldByDeps || task.heldByParentReview || task.closesBy === 'children'
        || review.executionAckStatus === 'pending' || review.midWorkAckStatus === 'pending'
        || task.runIf?.outcome === 'held' || task.runIf?.outcome === 'skipped'))) {
      this.refuse('TASK_NOT_RUNNABLE', 'This task is closed, paused, or awaiting dependencies or review. Resolve that condition before continuing.');
    }
  }

  private async prepareWork(planning = false): Promise<ExecutionBinding> {
    this.assertLive();
    let { agreementId, taskId } = this.binding ?? this.scope;
    let task: Task | undefined;
    if (taskId) {
      task = await this.options.readTask(taskId);
      if (task.taskId !== taskId) this.refuse('TASK_SCOPE_MISMATCH', 'The task read did not match the requested task.');
      agreementId ??= task.agreementId;
    }
    if (!agreementId || this.conflictingBatch) {
      this.refuse('AGREEMENT_REQUIRED', 'Work needs one governing agreement selected by the wake or its server context. Propose an agreement or resume an assigned task; tool arguments cannot select authority.');
    }
    // Refresh on every work call: a previous successful call is not permission
    // to keep acting after revocation. Read failures fail closed.
    const agreement = row(await this.options.readAgreement(agreementId));
    if (agreement.agreementId !== agreementId || agreement.status !== 'active'
      || agreement.engagementKind === 'link' || isListing(agreement)
      || row(agreement.terms).interactionMode === 'conversation') {
      this.refuse('AGREEMENT_INACTIVE', 'An active work agreement is required. Conversation links and listings do not authorize service work.');
    }
    if (task) {
      this.assertTask(task, agreementId, planning);
    } else {
      // Read reach alone is not authority to appoint ourselves as the worker.
      if (row(row(agreement.parties).provider).actor !== this.options.agentId) {
        this.refuse('TASK_REQUIRED', 'Resume a task assigned to this agent. Reading an agreement does not authorize taking work under it.');
      }
      const keys = createDeliveryWriteKeys(this.options.laneKey, this.options.event);
      if (!keys.wakeKey) this.refuse('TASK_REQUIRED', 'This wake has no durable delivery identity. Create an explicit task before executing work.');
      // A single task per delivery, independent of which tool happens to run
      // first. The backend key also survives process restarts and redelivery.
      if (!this.creating) {
        const data: CreateTaskData = {
          agreementId,
          assigneeId: this.options.agentId,
          // Message text describes the task; it never determines permissions.
          description: id(row(this.options.event).text)?.slice(0, 2000) ?? 'Carry out the work requested in this delivery.',
          idempotencyKey: `${keys.wakeKey}_work`,
        };
        this.creating = this.options.createTask(data).then(created => {
          this.assertLive();
          this.assertTask(created, data.agreementId);
          this.options.onTaskCreated?.(created);
          return created;
        });
        // Keep a rejected promise for this wake: an uncertain write must not
        // be retried under a different key or become permission to execute.
      }
      task = await this.creating;
      this.assertTask(task, agreementId);
    }
    this.assertLive();
    this.binding = { agreementId, taskId: task.taskId };
    return this.binding;
  }

  async beforeTool(tool: ToolDefinition | null, args: Row): Promise<{ args: Row; binding?: ExecutionBinding }> {
    this.assertLive();
    const name = toolName(tool ?? undefined);
    if (!name) this.refuse('UNKNOWN_TOOL', 'The tool is not registered.');
    const authority = this.binding?.agreementId ?? this.scope.agreementId;
    for (const key of ['underAgreementId', 'mandateAgreementId', 'onBehalfOfAgreementId']) {
      if (args[key] != null && args[key] !== authority) {
        this.refuse('AGREEMENT_SCOPE_MISMATCH', `${key} cannot change this wake's governing agreement.`);
      }
    }
    if (name.startsWith('agreement_') && args.parentAgreementId != null && args.parentAgreementId !== authority) {
      this.refuse('AGREEMENT_SCOPE_MISMATCH', 'parentAgreementId cannot borrow authority from another agreement.');
    }
    const reply = name === 'chat_send' && (!id(args.chatId) || args.chatId === this.options.sessionId)
      && (!id(args.to) || args.to === row(this.options.event).senderId);
    const conversation = tool?.execution === 'conversation'
      || (tool?.execution !== 'work' && (reply || CONTROL_TOOLS.has(name) || annotationForSdkTool(name) === 'read-only'));
    if (conversation) return { args };
    if (args.taskId != null && args.taskId !== (this.binding?.taskId ?? this.scope.taskId)) {
      this.refuse('TASK_SCOPE_MISMATCH', 'A tool argument cannot switch execution to a different task.');
    }
    // A plan can be prepared while execution awaits acknowledgement. This
    // exception never releases the hold for the actual work tools.
    const binding = await this.prepareWork(name === 'task_replace_plan' || name === 'task_update_plan_step');
    const properties = row(row(tool?.schema.function.parameters).properties);
    return { binding, args: { ...args, ...('taskId' in properties ? { taskId: binding.taskId } : {}) } };
  }

  observeTool(name: string, value: unknown): void {
    const result = row(value);
    if (result.ok === false || result.success === false || result.error) return;
    if (name === 'task_create' && !this.binding && result.agreementId === this.scope.agreementId
      && (result.assigneeId === this.options.agentId || result.executorIsYou === true) && id(result.taskId)) {
      // Re-read and validate before execution. Never trust creation arguments.
      this.scope = { agreementId: this.scope.agreementId, taskId: String(result.taskId) };
    }
    if (name === 'task_set_result' && this.binding) {
      const task = row(result.task ?? result);
      if (task.taskId === this.binding.taskId && ['completed', 'failed', 'cancelled'].includes(String(task.state))) this.closed = true;
    }
  }
}

// Covers nested tool calls as well as the brain's direct calls, while keeping
// concurrent wakes and agents isolated. No controller is mounted for external
// API/MCP clients; their authorization remains the backend's responsibility.
export const executionControllers = new AsyncLocalStorage<ExecutionController>();
