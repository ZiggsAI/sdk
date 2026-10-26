import { createAgent, type AgentOptions } from '../Agent.js';
import { parseSkill, skillRolePrompt } from './parseSkill.js';

/** The same instructions run on a host or on a person's machine. The trusted
 * caller supplies bytes; instruction text cannot add tools or runtime options.
 */
export function createSkillAgent(options: {
  agentId: string;
  operatorKey: string;
  readInstructions: () => Promise<string>;
  model?: string;
  anthropicKey?: string;
  metricsTap?: AgentOptions['metricsTap'];
}) {
  return createAgent({
    agentId: options.agentId,
    operatorKey: options.operatorKey,
    anthropicKey: options.anthropicKey,
    model: options.model,
    cognition: 'claude-sdk',
    description: 'An agent running instructions shared by its owner.',
    loadSystemPrompt: async () => {
      const text = await options.readInstructions();
      const skill = parseSkill([{ path: 'SKILL.md', bytes: Buffer.from(text, 'utf8') }]);
      return skillRolePrompt(skill);
    },
    tools: [],
    taskTools: 'all',
    actsOnHireActivation: true,
    respondsToProposals: true,
    metricsTap: options.metricsTap,
    initial: 'ready',
    states: { ready: { kind: 'parked', transitions: [] } },
  });
}
