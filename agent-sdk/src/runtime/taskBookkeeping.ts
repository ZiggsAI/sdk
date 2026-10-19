import type { Ctx, TaskBookkeeping } from '../types.js';

/**
 * Reserved key for coordinator-side pending/collected state when the lane has
 * an active agreement but no assigned parent task yet (kickoff → spawn).
 * Never deleted by task-closed of a real taskId.
 */
export const LANE_BOOK_KEY = '__lane__';

export function emptyTaskBook(agreementId: string | null = null): TaskBookkeeping {
  return {
    agreementId,
    pendingSubtasks: {},
    collectedResults: [],
    delegatedAgreementIds: [],
  };
}

export function ensureTaskBook(
  ctx: Ctx,
  taskId: string,
  agreementId?: string | null,
): TaskBookkeeping {
  if (!ctx.tasks) ctx.tasks = {};
  let book = ctx.tasks[taskId];
  if (!book) {
    book = emptyTaskBook(agreementId ?? null);
    ctx.tasks[taskId] = book;
  } else if (agreementId && !book.agreementId) {
    book.agreementId = agreementId;
  }
  return book;
}

/**
 * Book that receives task-delegated / subtask-finished when we know the parent
 * engagement: focus task if assigned, else the coordinator lane bucket.
 */
export function bookForDelegation(ctx: Ctx): TaskBookkeeping {
  if (ctx.activeTaskId) {
    return ensureTaskBook(ctx, ctx.activeTaskId, ctx.activeAgreementId);
  }
  const book = ensureTaskBook(ctx, LANE_BOOK_KEY, ctx.activeAgreementId);
  if (ctx.activeAgreementId && !book.agreementId) book.agreementId = ctx.activeAgreementId;
  return book;
}

/** Find which engagement is awaiting this child taskId. */
export function findBookHoldingPending(
  ctx: Ctx,
  childTaskId: string,
): TaskBookkeeping | null {
  if (!ctx.tasks) return null;
  for (const book of Object.values(ctx.tasks)) {
    if (childTaskId in book.pendingSubtasks) return book;
  }
  return null;
}

export function allCollectedResults(ctx: Ctx): TaskBookkeeping['collectedResults'] {
  if (!ctx.tasks) return [];
  const out: TaskBookkeeping['collectedResults'] = [];
  for (const book of Object.values(ctx.tasks)) {
    out.push(...book.collectedResults);
  }
  return out;
}

export function allPendingSubtasks(ctx: Ctx): Record<string, TaskBookkeeping['pendingSubtasks'][string]> {
  if (!ctx.tasks) return {};
  const out: Record<string, TaskBookkeeping['pendingSubtasks'][string]> = {};
  for (const book of Object.values(ctx.tasks)) {
    Object.assign(out, book.pendingSubtasks);
  }
  return out;
}

export function allDelegatedAgreementIds(ctx: Ctx): string[] {
  if (!ctx.tasks) return [];
  const ids: string[] = [];
  for (const book of Object.values(ctx.tasks)) {
    for (const id of book.delegatedAgreementIds) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export function hasOpenTaskForAgreement(ctx: Ctx, agreementId: string): boolean {
  if (!agreementId || !ctx.tasks) return false;
  return Object.entries(ctx.tasks).some(
    ([key, book]) => key !== LANE_BOOK_KEY && book.agreementId === agreementId,
  );
}

export function hasDelegatedAgreement(ctx: Ctx, agreementId: string): boolean {
  return allDelegatedAgreementIds(ctx).includes(agreementId);
}

/**
 * Remove one task's bookkeeping and retarget focus if we just closed the
 * focused task. Leaves sibling entries (and the coordinator lane bucket) alone.
 */
export function removeTaskBook(ctx: Ctx, taskId: string): void {
  if (!taskId || !ctx.tasks) return;
  delete ctx.tasks[taskId];
  if (ctx.activeTaskId === taskId) {
    const nextId =
      Object.keys(ctx.tasks).find((id) => id !== LANE_BOOK_KEY) ?? null;
    ctx.activeTaskId = nextId;
    ctx.activeAgreementId = nextId ? (ctx.tasks[nextId]?.agreementId ?? null) : null;
  }
}

/**
 * Migrate a pre- persisted ctx (lane-level pendingSubtasks /
 * collectedResults / delegatedAgreementIds) into the tasks map.
 * the deprecated lane aggregates are no longer auto-synced —
 * readers use allPendingSubtasks / allCollectedResults / allDelegatedAgreementIds.
 * This migrator stays so a session persisted before the tasks map still boots.
 */
export function migrateLegacyTaskFields(existing: Record<string, unknown>): Record<string, TaskBookkeeping> {
  if (existing.tasks && typeof existing.tasks === 'object') {
    return existing.tasks as Record<string, TaskBookkeeping>;
  }
  const tasks: Record<string, TaskBookkeeping> = {};
  const activeTaskId = (existing.activeTaskId as string | null | undefined) ?? null;
  const activeAgreementId = (existing.activeAgreementId as string | null | undefined) ?? null;
  const pendingSubtasks =
    (existing.pendingSubtasks as TaskBookkeeping['pendingSubtasks'] | undefined) ?? {};
  const collectedResults =
    (existing.collectedResults as TaskBookkeeping['collectedResults'] | undefined) ?? [];
  const delegatedAgreementIds =
    (existing.delegatedAgreementIds as string[] | undefined) ?? [];
  const hasLegacy =
    Object.keys(pendingSubtasks).length > 0 ||
    collectedResults.length > 0 ||
    delegatedAgreementIds.length > 0;

  if (activeTaskId) {
    tasks[activeTaskId] = {
      agreementId: activeAgreementId,
      pendingSubtasks,
      collectedResults,
      delegatedAgreementIds: [...delegatedAgreementIds],
    };
  } else if (hasLegacy) {
    tasks[LANE_BOOK_KEY] = {
      agreementId: activeAgreementId,
      pendingSubtasks,
      collectedResults,
      delegatedAgreementIds: [...delegatedAgreementIds],
    };
  }
  return tasks;
}
