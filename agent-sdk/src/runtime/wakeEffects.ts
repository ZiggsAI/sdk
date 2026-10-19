import { agreementIdFromLane } from '@ziggs-ai/api-client';
import type { Effect } from '../types.js';
import { isListing } from './agreementContext.js';

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
  const agreementId = listing ? undefined : id(rec.agreementId) ?? id(resource.agreementId) ?? id(task.agreementId)
    ?? agreementIdFromLane(rec.chatId) ?? agreementIdFromLane(resource.chatId)
    ?? agreementIdFromLane(sessionId) ?? undefined;
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
  /** Agreements the wake's OWN room reported, from its fenced snapshot. */
  private roomAgreementIds: string[] = [];
  /** Confirmed task writes: work this wake actually performed. */
  private taskWrites: WorkScope[] = [];
  constructor(
    private readonly initialScope: WorkScope,
    private readonly sessionId?: string,
    private readonly inferScope = true,
  ) {}

  static forWake(event: unknown, sessionId: string): WakeEffects {
    const initialScope = workScopeFromWake(event, sessionId);
    const frame = record(event);
    const conflictingBatch = frame.type === 'batch' && Array.isArray(frame.events)
      && !initialScope.agreementId && !initialScope.taskId
      && frame.events.some(item => Object.keys(workScopeFromWake(item, sessionId)).length > 0);
    return new WakeEffects(initialScope, sessionId, !conflictingBatch);
  }

  /**
   * Structured wake fields first. Otherwise the room's one agreement is the
   * scope — spend follows who the agent acts for, and in a room that is the
   * room's agreement — and a confirmed task write names its task only when
   * the server tied the write to that same agreement. A plan written for
   * customer A from customer B's room stays billed to B and names no task; a
   * write whose agreement the server did not report adds nothing but the room.
   */
  get scope(): WorkScope {
    if (this.initialScope.agreementId || this.initialScope.taskId) return this.initialScope;
    if (!this.inferScope) return {};
    const room = new Set(this.roomAgreementIds);
    if (room.size > 1) return {};
    const agreementId = [...room][0];
    if (!agreementId) return uniqueWorkScope(this.taskWrites);
    const tasks = new Set(
      this.taskWrites.filter(w => w.agreementId === agreementId).map(w => w.taskId),
    );
    return { agreementId, ...(tasks.size === 1 ? { taskId: [...tasks][0] } : {}) };
  }

  observe(effect: Effect, response: unknown): void {
    const outer = record(response);
    if (effect.kind === 'send-message' && outer.ok === true) this.sentMessage = true;
    // This is the fenced snapshot of the wake's own chat, not an arbitrary
    // agreement consulted while answering. A room with multiple agreements
    // remains ambiguous, and cross-room reads cannot change the wake's scope.
    if (effect.kind === 'read-context' && effect.sessionId === this.sessionId
      && outer.chatMissing !== true && Array.isArray(outer.agreements)) {
      for (const row of outer.agreements) {
        // A stranger's room is linked to the agent's listing; the listing is
        // every stranger's and never the room's work.
        if (isListing(row)) continue;
        const agreementId = id(record(row).agreementId);
        if (agreementId) this.roomAgreementIds.push(agreementId);
      }
    }
    if (effect.kind !== 'tool-call' || outer.ok !== true) return;
    const result = record(outer.result);
    if (result.ok === false || result.success === false || result.error) return;
    const name = effect.name.replace(/^(functions|tools|function|tool)\./, '');
    if (name === 'chat_send') {
      this.sentMessage = true;
      if (id(result.chatId) && id(result.messageId)) {
        this.sentMessageKeys.add(JSON.stringify([result.chatId, result.messageId]));
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
