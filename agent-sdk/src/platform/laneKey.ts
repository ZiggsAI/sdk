import { AsyncLocalStorage } from 'node:async_hooks';
import { currentWorkExecution, type WorkExecutionContext } from '@ziggs-ai/api-client';

/** The parts of an execution a lane is named from. */
export type LaneExecution = Pick<WorkExecutionContext, 'contextId' | 'agreementId'>
  & Partial<Pick<WorkExecutionContext, 'action' | 'taskId' | 'audienceIds'>>;

/** The bucket a message was sent in, as the wake found it. */
export interface LaneBucket {
  bucketId: string;
  /** Goes up when the bucket's audience changes or an item leaves it. */
  revision: number;
}

/** What one wake's lane is computed from. */
export interface LaneWake {
  /** The execution the wake runs under. Left out, the current one is used. */
  execution?: LaneExecution;
  /** The bucket the message or task a wake runs on was put in. */
  bucket?: LaneBucket;
}

/**
 * The bucket lane of a wake: `bkt-<bucketId>-r<revision>`, or undefined when
 * this wake does not run on one.
 *
 * A wake whose action is a message or a task in a bucket the agent is in gets
 * one; a task wake is a message wake with a bucket. Wakes in one bucket run
 * on its lane one at a time, in order, and the agent's notes for the bucket
 * carry over between them, and over a join or a leave. The revision goes up
 * when the bucket's audience changes or an item leaves, which starts a new
 * lane. The notes are cleared only when an item they were written under is
 * no longer readable in the bucket.
 */
export function bucketLaneId(execution: LaneExecution | undefined, bucket: LaneBucket | undefined): string | undefined {
  const kind = execution?.action?.kind;
  if (!bucket || (kind !== 'message' && kind !== 'task')) return undefined;
  return `bkt-${bucket.bucketId}-r${bucket.revision}`;
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
 * - A message or task wake in a bucket runs on its bucket lane (see
 *   {@link bucketLaneId}).
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
  const bucket = bucketLaneId(execution, wake?.bucket);
  return `${agentId}:${bucket ?? execution?.contextId ?? sessionId}`;
}
