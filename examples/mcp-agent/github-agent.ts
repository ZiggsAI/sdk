/**
 * Example: wrap the GitHub MCP server as a Ziggs agent.
 *
 * Prerequisites:
 *   export ZIGGS_OPERATOR_KEY=<your operator key>
 *   export GITHUB_TOKEN=<your PAT>         # forwarded to the MCP server
 *
 * Run:
 *   npx tsx examples/mcp-agent/github-agent.ts
 */
import 'dotenv/config';
import { createMcpAgent } from '@ziggs-ai/agent-sdk';

const { agent, closeMcp, toolNames } = await createMcpAgent({
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '' },
  },
  agentId: 'github-mcp-agent',
  name: 'GitHub Agent',
  description: 'Answers questions about GitHub repos, issues, and PRs using the GitHub MCP server.',
});

console.log(`MCP tools loaded (${toolNames.length}): ${toolNames.join(', ')}`);

await agent.connectAsync();
console.log('GitHub Agent connected to Ziggs.');

process.on('SIGTERM', async () => {
  agent.disconnect();
  await agent.drain();
  await closeMcp();
  process.exit(0);
});
