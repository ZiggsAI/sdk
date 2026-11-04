import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentWorkExecution, type WorkExecutionContext } from '@ziggs-ai/api-client';

/** The parts of an execution a lane is named from. */
export type LaneExecution = Pick<WorkExecutionContext, 'contextId' | 'agreementId'>
  & Partial<Pick<WorkExecutionContext, 'action' | 'taskId' | 'audienceIds'>>;

/** What one wake's lane is computed from. */
export interface LaneWake {
  /** The execution the wake runs under. Left out, the current one is used. */
  execution?: LaneExecution;
  /** The first message of the thread a message wake belongs to. */
  threadRootId?: string;
}

/**
 * The thread lane of a message wake: `thr-<digest>`, or undefined when this
 * wake does not run on one.
 *
 * Only a wake whose action is a message, and whose thread is known, gets one.
 * The digest covers the thread, the work and every reader, so a later message
 * in the same thread, under the same work, read by the same people, lands on
 * the same lane and the agent carries over what it knew. Anything else that
 * changes (a reader joins or leaves, another agreement or task) gives a new
 * lane: an agent may carry over only what everyone reading can read.
 */
export function threadLaneId(execution: LaneExecution | undefined, threadRootId: string | undefined): string | undefined {
  if (!threadRootId || execution?.action?.kind !== 'message') return undefined;
  const readers = [...new Set(execution.audienceIds ?? [])].sort();
  const digest = createHash('sha256')
    .update(JSON.stringify([threadRootId, execution.agreementId ?? null, execution.taskId ?? null, readers]))
    .digest('hex')
    .slice(0, 32);
  return `thr-${digest}`;
}

/** The lane a wake is running on right now, for calls that hold only a session id. */
const runningLane = new AsyncLocalStorage<{ agentId: string; laneKey: string }>();

/** Run `work` as the wake of `laneKey`, so a lane named inside it names this one. */
export function runInLane<T>(agentId: string, laneKey: string, work: () => T): T {
  return runningLane.run({ agentId, laneKey }, work);
}

/** The lane of the wake running now, if any. */
export function currentLaneKey(): string | undefined {
  return runningLane.getStore()?.laneKey;
}

/**
 * The lane key for one agent's one conversation.
 *
 * Stated once because three places used to spell it inline, and the wake
 * scheduler added a fourth: it has to name the lane it is arming a timer for,
 * and it only holds the agent id and the session id. A second copy of the
 * formula would be a bug the day the shape changes: a timer armed on
 * `a:b` while the queue dispatches `a::b` simply never wakes anything, with
 * nothing in the logs to say so.
 *
 * - A message wake whose thread is known runs on its thread lane (see
 *   {@link threadLaneId}).
 * - Any other wake under an execution runs on that execution's own lane.
 * - A wake under none runs on its session.
 *
 * Called without `wake` inside a running wake, it names that wake's lane, which
 * is how a timer armed from a tool finds the lane it was armed from.
 */
export function laneKeyFor(agentId: string, sessionId: string, wake?: LaneWake): string {
  if (!wake) {
    const running = runningLane.getStore();
    if (running?.agentId === agentId) return running.laneKey;
  }
  const execution = wake?.execution ?? currentWorkExecution();
  const thread = threadLaneId(execution, wake?.threadRootId);
  return `${agentId}:${thread ?? execution?.contextId ?? sessionId}`;
}
