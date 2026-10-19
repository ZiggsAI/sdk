import type { WriteSource } from '@ziggs-ai/api-client';
import {
  createTask, getTask, getActiveTasksForAgent, getActiveTasksForChat, getSubtasks,
  updateTaskState, updateTaskPlanStep, updateTaskPlanSteps, cancelTask,
  reportTask, setTaskSatisfaction, countTasks, acknowledgeTaskControl,
  presentTaskOutcome,
  type Creds, type Task, type TaskState,
} from '@ziggs-ai/api-client';
import type { CountTasksFilters, CreateTaskData } from '@ziggs-ai/api-client';
import { runtimeLog } from '../../shared/runtimeLog.js';

function safeJsonStringify(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    }, 2);
  } catch {
    return String(value);
  }
}

export class TaskService {
  private creds: Creds;

  constructor(operatorKey: string, agentId: string) {
    if (!operatorKey) throw new Error('TaskService: operatorKey is required');
    if (!agentId) throw new Error('TaskService: agentId is required (operator-token impersonation)');
    this.creds = { operatorKey, agentId };
  }

  async acknowledgeControl(taskId: string, requestId: string, supported = true) {
    return acknowledgeTaskControl(taskId, requestId, supported, this.creds);
  }

  async getTask(taskId: string): Promise<Task> {
    return getTask(taskId, this.creds);
  }

  async getActiveTasksForAgent(agentId: string): Promise<Task[]> {
    return getActiveTasksForAgent(agentId, this.creds);
  }

  async getActiveTasksForChat(chatId: string): Promise<Task[]> {
    return getActiveTasksForChat(chatId, this.creds);
  }

  async getSubtasks(parentTaskId: string): Promise<Task[]> {
    return getSubtasks(parentTaskId, this.creds);
  }

  async spawnUnderAgreement(agreementId: string, taskData: Omit<CreateTaskData, 'agreementId'>): Promise<Task> {
    if (!agreementId) throw new Error('TaskService.spawnUnderAgreement: agreementId is required');
    try {
      const result = await createTask({ ...taskData, agreementId }, this.creds);
      runtimeLog.info('TaskService', `Task spawned under agreement ${agreementId}: ${result?.taskId || 'unknown'}`);
      return result;
    } catch (error) {
      const e = error as { message?: string; status?: number; body?: string };
      runtimeLog.error('TaskService', `Task spawn failed (agreement ${agreementId}, assignee ${taskData.assigneeId ?? '-'}): status=${e.status ?? '?'} ${e.message}${e.body ? ` | body=${e.body}` : ''}`);
      throw error;
    }
  }

  async updateState(
    taskId: string,
    state: TaskState,
    result?: unknown,
    idempotencyKey?: string,
    sources?: WriteSource[],
  ) {
    try {
      const data = {
        ...(result !== undefined ? { result: safeJsonStringify(result) } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(sources ? { sources } : {}),
      };
      const updated = await updateTaskState(taskId, state, data, this.creds);
      runtimeLog.info('TaskService', `Task state: ${taskId} → ${state}`);
      // The same four facts the MCP surface reports, from the same
      // presenter: what was stored, who was woken, what metering did, what the
      // agreement is now. Both surfaces say it once, and say it the same way.
      return {
        ...updated,
        ...presentTaskOutcome(updated, { creds: this.creds, surface: 'sdk' }),
      };
    } catch (error) {
      runtimeLog.error('TaskService', `Task state update failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Say who this task is waiting on, with no other progress to post.
   *
   * The ask that produces nothing else — the agent asked its person and is
   * stopping — had no way to be recorded: the only progress rail wanted a plan
   * step, and a worker subtask usually has no plan at all.
   */
  async setWaitingOn(
    taskId: string,
    waitingOn: { kind: 'user' | 'agent'; id: string } | null,
  ) {
    try {
      return await updateTaskPlanSteps(taskId, [], this.creds, waitingOn);
    } catch (error) {
      runtimeLog.error('TaskService', `Task waiting-on update failed: ${(error as Error).message}`);
      throw error;
    }
  }

  async updatePlanStep(
    taskId: string,
    stepId: string,
    status: string,
    result?: unknown,
    waitingOn?: { kind: 'user' | 'agent'; id: string } | null,
    sources?: WriteSource[],
  ) {
    try {
      const updated = await updateTaskPlanStep(taskId, stepId, status, result, this.creds, waitingOn, sources);
      runtimeLog.info('TaskService', `Task plan step: ${taskId}/${stepId} → ${status}`);
      return updated;
    } catch (error) {
      runtimeLog.error('TaskService', `Task plan step update failed: ${(error as Error).message}`);
      throw error;
    }
  }

  async cancel(taskId: string) {
    try {
      const updated = await cancelTask(taskId, this.creds);
      runtimeLog.info('TaskService', `Task cancelled: ${taskId}`);
      return updated;
    } catch (error) {
      runtimeLog.error('TaskService', `Task cancel failed: ${(error as Error).message}`);
      throw error;
    }
  }

  async report(taskId: string, message = '') {
    return reportTask(taskId, message, this.creds);
  }

  async setSatisfaction(taskId: string, satisfaction: 'positive' | 'negative') {
    return setTaskSatisfaction(taskId, satisfaction, this.creds);
  }

  async count(filters: CountTasksFilters = {}): Promise<number> {
    return countTasks(filters, this.creds);
  }
}
