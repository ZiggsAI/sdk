/**
 * The lane key for one agent's one conversation.
 *
 * Stated once because three places used to spell it inline, and the wake
 * scheduler added a fourth: it has to name the lane it is arming a timer for,
 * and it only holds the agent id and the session id. A second copy of the
 * formula would be a bug the day the shape changes — a timer armed on
 * `a:b` while the queue dispatches `a::b` simply never wakes anything, with
 * nothing in the logs to say so.
 */
export function laneKeyFor(agentId: string, sessionId: string): string {
  return `${agentId}:${sessionId}`;
}
