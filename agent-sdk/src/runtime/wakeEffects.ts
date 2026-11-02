import type { Effect } from '../types.js';

export interface WorkScope { agreementId?: string; taskId?: string }
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

/** Never combine a task from one event with an agreement from another. */
export function uniqueWorkScope(scopes: WorkScope[]): WorkScope {
  const agreements = new Set(scopes.map(s => s.agreementId).filter(Boolean));
  const tasks = new Set(scopes.map(s => s.taskId).filter(Boolean));
  if (agreements.size > 1 || tasks.size > 1) return {};
  if (agreements.size && tasks.size && scopes.some(s => s.taskId && !s.agreementId)) return {};
  return {
    ...(agreements.size ? { agreementId: [...agreements][0] } : {}),
    ...(tasks.size ? { taskId: [...tasks][0] } : {}),
  };
}

/** Only structured host/backend fields are authority; message text and timer reasons are not. */
export function workScopeFromWake(event: unknown, sessionId?: string): WorkScope {
  const rec = record(event);
  if (rec.type === 'batch' && Array.isArray(rec.events)) {
    return uniqueWorkScope(rec.events.map(e => workScopeFromWake(e, sessionId)));
  }
  const resource = record(rec.resource);
  const task = rec.type === 'task_result' || rec.type === 'notification' ? record(rec.result) : {};
  // A listing is never work, so it is never what a wake's sends and
  // tools are filed under.
  const listing = record(rec.agreementContext).listing === true;
  const agreementId = listing ? undefined : id(rec.agreementId) ?? id(resource.agreementId) ?? id(task.agreementId);
  const taskId = id(rec.taskId) ?? id(resource.taskId) ?? id(task.taskId) ?? (resource.kind === 'task' ? id(resource.resourceId) : undefined);
  return { ...(agreementId ? { agreementId } : {}), ...(taskId ? { taskId } : {}) };
}

/** One packet per distinct work item in a batch; never union their authority. */
export function contextScopesFromWake(event: unknown, sessionId: string): Array<WorkScope & { messageId?: string; artifactId?: string }> {
  const frame = record(event);
  if (frame.type === 'batch' && Array.isArray(frame.events)) {
    return [...new Map(frame.events.flatMap(e => contextScopesFromWake(e, sessionId)).map(scope => [JSON.stringify(scope), scope])).values()];
  }
  const scope = workScopeFromWake(event, sessionId);
  const messageId = frame.type === 'message' ? id(frame.messageId) : undefined;
  const resource = record(frame.resource);
  const artifactId = resource.kind === 'artifact' ? id(resource.resourceId) : undefined;
  return scope.agreementId || scope.taskId || messageId || artifactId
    ? [{ ...scope, ...(messageId ? { messageId } : {}), ...(artifactId ? { artifactId } : {}) }] : [];
}

const TASK_WRITES = new Set(['task_create', 'task_set_result', 'task_update_plan_step', 'task_replace_plan']);

/** Per-wake observation, including effects nested inside tools and cross-room sends. */
export class WakeEffects {
  sentMessage = false;
  taskWrite = false;
  readonly planVersions = new Set<string>();
  readonly sentMessageKeys = new Set<string>();
  /** Confirmed task writes: work this wake actually performed. */
  private taskWrites: WorkScope[] = [];
  constructor(
    private readonly initialScope: WorkScope,
    private readonly inferScope = true,
  ) {}

  static forWake(event: unknown, sessionId: string): WakeEffects {
    const initialScope = workScopeFromWake(event, sessionId);
    const frame = record(event);
    const conflictingBatch = frame.type === 'batch' && Array.isArray(frame.events)
      && !initialScope.agreementId && !initialScope.taskId
      && frame.events.some(item => Object.keys(workScopeFromWake(item, sessionId)).length > 0);
    return new WakeEffects(initialScope, !conflictingBatch);
  }

  /** Structured work wins. A confirmed task write may identify work performed;
   * reading a context snapshot never selects billing or execution authority. */
  get scope(): WorkScope {
    if (this.initialScope.agreementId || this.initialScope.taskId) return this.initialScope;
    return this.inferScope ? uniqueWorkScope(this.taskWrites) : {};
  }

  observe(effect: Effect, response: unknown): void {
    const outer = record(response);
    if (effect.kind === 'send-message' && outer.ok === true
      && (outer.outcome === 'created' || outer.outcome === 'existing')) {
      const messageId = id(record(outer.message).messageId);
      if (messageId) { this.sentMessage = true; this.sentMessageKeys.add(messageId); }
    }
    if (effect.kind !== 'tool-call' || outer.ok !== true) return;
    const result = record(outer.result);
    if (result.ok === false || result.success === false || result.error) return;
    const name = effect.name.replace(/^(functions|tools|function|tool)\./, '');
    if (name === 'message_send') {
      const messageId = id(record(result.message).messageId);
      if ((result.outcome === 'created' || result.outcome === 'existing') && messageId) {
        this.sentMessage = true;
        this.sentMessageKeys.add(messageId);
      }
    }
    if (TASK_WRITES.has(name)) this.taskWrite = true;
    if ((name === 'task_replace_plan' || name === 'task_update_plan_step') && id(result.taskId)
      && result.taskId === record(effect.args).taskId && id(result.updatedAt)) {
      this.planVersions.add(JSON.stringify([result.taskId, result.updatedAt]));
    }
    // A confirmed task write identifies work actually performed. A broad
    // task_list, arbitrary agreement_get or ids in message prose do not.
    const agreementId = id(result.agreementId);
    const taskId = id(result.taskId);
    if (TASK_WRITES.has(name) && taskId) {
      this.taskWrites.push({ taskId, ...(agreementId ? { agreementId } : {}) });
    }
  }
}
