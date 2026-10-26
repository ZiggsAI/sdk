import { AsyncLocalStorage } from 'node:async_hooks';
import type { Task } from '@ziggs-ai/api-client';
import type { ToolDefinition } from '../tools/defineTool.js';
import { toolName } from '../tools/defineTool.js';
import { isListing } from './agreementContext.js';

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const id = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v : undefined;

export interface ExecutionBinding { agreementId: string; taskId: string }

interface ControllerOptions {
  agentId: string;
  readTask(id: string): Promise<Task>;
  readAgreement(id: string): Promise<unknown>;
  /** Called the first time a task is verified for work in this wake. */
  onTaskBound?(taskId: string): void;
  signal?: AbortSignal;
}

// The rule: a tool that does work runs only against a task the agent holds,
// and the task's agreement is the permission. Nothing here reads the wake or
// a snapshot, and nothing here opens a task: in each wake the agent names a
// task it was given, or opens one itself with task_create, which the backend
// prices and the buyer sees. A task from an earlier wake is never a default,
// so work cannot be filed under last week's task by omission. Agreeing,
// managing, reading and talking stay open; the backend authorizes each of
// those on its own.

/** Platform tools that write work onto a task. Every other platform tool is open. */
const PLATFORM_WORK = new Set(['artifact_record', 'task_set_result', 'task_update_plan_step', 'task_replace_plan']);
/** Managing a task you hold needs ownership and a live agreement, not a runnable task: failing a paused task is allowed. */
const TASK_MANAGEMENT = new Set(['task_set_result', 'task_update_plan_step', 'task_replace_plan']);
const AUTHORITY_ARGS = ['underAgreementId', 'mandateAgreementId', 'onBehalfOfAgreementId', 'parentAgreementId'];
const CLOSED = new Set(['completed', 'failed', 'cancelled']);
const WORKABLE = new Set(['active', 'in-progress']);

export const WORK_TASK_PARAM = {
  type: 'string',
  description: 'The task this work is for: one assigned to you under an active agreement. Name it on your first work call in each wake; later calls in the same wake keep it.',
};

/**
 * A custom tool does work. It gets a `taskId` the model fills so it can name
 * the task it works under; the host reads it and the handler never sees it.
 * A tool that already takes `taskId` keeps its own, and one the author marked
 * `conversation` stays open.
 */
export function asWorkTool(tool: ToolDefinition): ToolDefinition {
  if (tool.execution === 'conversation') return tool;
  const fn = tool.schema.function;
  const parameters = row(fn.parameters);
  const properties = row(parameters.properties);
  if ('taskId' in properties) return { ...tool, execution: 'work' };
  return {
    ...tool,
    execution: 'work',
    workTaskParam: true,
    schema: { ...tool.schema, function: { ...fn, parameters: { ...parameters, properties: { ...properties, taskId: WORK_TASK_PARAM } } } },
  };
}

export class ExecutionRefusal extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}

/** Per-wake bookkeeping of which held task the agent works under. Never a replacement for backend grants. */
export class ExecutionController {
  private binding?: ExecutionBinding;
  /** A task the agent opened for itself in this wake, not yet verified for work. */
  private named: string | null = null;
  private closedTaskId?: string;

  constructor(private readonly options: ControllerOptions) {}

  /** The task this wake worked under: the last verified binding, or the task the agent opened for itself. Information for the next wake, never its default. */
  get currentTaskId(): string | null {
    if (this.binding && this.binding.taskId !== this.closedTaskId) return this.binding.taskId;
    return this.named;
  }

  get currentAgreementId(): string | null {
    return this.binding && this.binding.taskId === this.currentTaskId ? this.binding.agreementId : null;
  }

  /** The bound task this wake closed with task_set_result, if any. */
  get closedTask(): string | undefined { return this.closedTaskId; }

  private refuse(code: string, message: string): never { throw new ExecutionRefusal(code, message); }

  private assertLive(): void {
    if (this.options.signal?.aborted) this.refuse('EXECUTION_STOPPED', 'This wake has stopped. No new work can execute.');
  }

  private isWork(tool: ToolDefinition, name: string): boolean {
    if (tool.execution === 'work') return true;
    if (tool.execution === 'conversation') return false;
    return PLATFORM_WORK.has(name);
  }

  async beforeTool(tool: ToolDefinition | null, args: Row): Promise<{ args: Row; binding?: ExecutionBinding }> {
    this.assertLive();
    const name = toolName(tool ?? undefined);
    if (!tool || !name) this.refuse('UNKNOWN_TOOL', 'The tool is not registered.');
    if (!this.isWork(tool, name)) return { args };
    const taskId = id(args.taskId) ?? this.binding?.taskId ?? this.named ?? undefined;
    if (!taskId) {
      this.refuse('TASK_REQUIRED', 'Work runs under a task you hold. Name a task assigned to you as taskId, or open one with task_create under your agreement with them and name it.');
    }
    const binding = await this.verify(taskId, TASK_MANAGEMENT.has(name));
    for (const key of AUTHORITY_ARGS) {
      if (args[key] != null && args[key] !== binding.agreementId) {
        this.refuse('AGREEMENT_SCOPE_MISMATCH', `${key} must be the task's own agreement (${binding.agreementId}).`);
      }
    }
    const handlerArgs: Row = { ...args };
    if (tool.workTaskParam) delete handlerArgs.taskId;
    else if ('taskId' in row(row(tool.schema.function.parameters).properties)) handlerArgs.taskId = binding.taskId;
    return { args: handlerArgs, binding };
  }

  /**
   * Read on every call: a previous successful call is not permission to keep
   * acting after a pause, a stop or a revocation. Read failures fail closed.
   */
  private async verify(taskId: string, managing: boolean): Promise<ExecutionBinding> {
    const task = await this.options.readTask(taskId);
    if (task.taskId !== taskId || (task.executorIsYou !== true && task.assigneeId !== this.options.agentId)) {
      this.refuse('TASK_NOT_HELD', `Task ${taskId} is not assigned to you. Work only under a task you hold.`);
    }
    const agreementId = id(task.agreementId);
    const agreement = agreementId ? row(await this.options.readAgreement(agreementId)) : {};
    if (!agreementId || agreement.agreementId !== agreementId || agreement.status !== 'active'
      || agreement.engagementKind === 'link' || isListing(agreement)) {
      this.refuse('AGREEMENT_INACTIVE', 'The task\'s agreement is not an active work agreement. Conversation links and listings do not authorize work.');
    }
    const state = String(task.state);
    if (CLOSED.has(state) || task.control?.action === 'stop') {
      this.refuse('TASK_NOT_RUNNABLE', `Task ${taskId} is closed or stopped. Take or open another task before working.`);
    }
    const review = row(task.planReview);
    if (!managing && (!WORKABLE.has(state) || task.control?.action === 'pause' || task.heldByDeps || task.heldByParentReview
      || task.closesBy === 'children' || review.executionAckStatus === 'pending' || review.midWorkAckStatus === 'pending'
      || task.runIf?.outcome === 'held' || task.runIf?.outcome === 'skipped')) {
      this.refuse('TASK_NOT_RUNNABLE', `Task ${taskId} is paused or awaiting dependencies or review. Resolve that before working on it; you can still update its plan or set its result.`);
    }
    this.assertLive();
    const first = this.binding?.taskId !== taskId;
    this.binding = { agreementId, taskId };
    if (first) this.options.onTaskBound?.(taskId);
    return this.binding;
  }

  observeTool(name: string, value: unknown): void {
    const result = row(value);
    if (result.ok === false || result.success === false || result.error) return;
    const task = row(result.task ?? result);
    const taskId = id(task.taskId);
    if (!taskId) return;
    // The agent opened a task for itself: that is the task it means to work
    // under next. It is verified like any other before a tool runs.
    if (name === 'task_create' && (task.assigneeId === this.options.agentId || task.executorIsYou === true)) this.named = taskId;
    if (name === 'task_set_result' && CLOSED.has(String(task.state))) {
      if (this.binding?.taskId === taskId) this.closedTaskId = taskId;
      if (this.named === taskId) this.named = null;
    }
  }
}

// Covers nested tool calls as well as the brain's direct calls, while keeping
// concurrent wakes and agents isolated. No controller is mounted for external
// API/MCP clients; their authorization remains the backend's responsibility.
export const executionControllers = new AsyncLocalStorage<ExecutionController>();
