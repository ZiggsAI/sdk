import type { AgentOptions } from '../../Agent.js';
import { PollRegistry } from './PollKind.js';
import { PollRunner, type WakeTarget } from './PollRunner.js';

/**
 * Build the runner that executes this agent's declared wakes.
 *
 * A malformed `polls` value is a programming error and still throws. A
 * binding that names an unknown kind or has no chatId is not: PollRunner
 * warns and skips it, so one agent's invalid poll cannot refuse the host.
 */
export function createDeclaredPollRunner(options: AgentOptions, target: WakeTarget): PollRunner | null {
  const registry = new PollRegistry();
  for (const kind of options.pollKinds ?? []) registry.register(kind);
  if (options.polls === undefined) return null;
  if (!Array.isArray(options.polls)) throw new Error('Agent: polls must be an array');
  if (!options.polls.length) return null;
  return new PollRunner({
    pool: target,
    registry,
    agents: [{ agentId: options.agentId, polls: options.polls }],
    operatorKey: options.operatorKey,
    label: `${options.name || options.agentId}-polls`,
  });
}
