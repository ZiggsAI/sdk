import { createAgent, type AgentOptions } from '../Agent.js';
import { ARTIFACT_TOOLS } from '../platform/tools/tier2/artifactTools.js';
import { toolName } from '../tools/defineTool.js';
import { parseSkill, skillRolePrompt } from './parseSkill.js';

/** The artifact tools that finish inside one call, so instructions can keep
 * their work as artifacts. The rest hand back a storage URL to upload to or
 * fetch from, and this agent has no web tool to do that with.
 */
const SKILL_ARTIFACT_TOOL_NAMES = new Set([
  'artifact_record',
  'artifact_list',
  'artifact_find',
  'artifact_share',
  'artifact_attach',
]);

const SKILL_ARTIFACT_TOOLS = ARTIFACT_TOOLS.filter((tool) =>
  SKILL_ARTIFACT_TOOL_NAMES.has(toolName(tool) ?? ''),
);

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
    tools: [...SKILL_ARTIFACT_TOOLS],
    taskTools: 'all',
    actsOnHireActivation: true,
    respondsToProposals: true,
    metricsTap: options.metricsTap,
    initial: 'ready',
    states: { ready: { kind: 'parked', transitions: [] } },
  });
}
