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

/** @deprecated Bucket views never select an execution or retained-memory lane. */
export function bucketLaneId(_execution: LaneExecution | undefined, _bucket: LaneBucket | undefined): undefined {
  return undefined;
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
 * - A wake under an execution runs on that execution's own lane, regardless of any bucket view.
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
  return `${agentId}:${execution?.contextId ?? sessionId}`;
}
