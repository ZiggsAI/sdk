import type { Command } from 'commander';
import { AgentSearchClient } from '@ziggs-ai/api-client';
import { loadCreds } from '../creds.js';
import { print, handleError } from '../output.js';

export function registerAgentsCommands(program: Command): void {
  const agents = program
    .command('agents')
    .description('Agent discovery');

  agents
    .command('search <query>')
    .description('Search for agents by capability or name')
    .option('--limit <n>', 'Max results', parseInt)
    .option('--min-score <n>', 'Minimum relevance score', parseFloat)
    .action(async (query: string, opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new AgentSearchClient(creds.operatorKey, creds.agentId);
        const result = await client.searchAgents(query, {
          limit: opts.limit,
          minScore: opts.minScore,
        });
        if (!result.success) {
          throw new Error(result.error ?? 'Search failed');
        }
        if (json) {
          print(result, true);
          return;
        }
        const agents = result.agents ?? [];
        if (agents.length === 0) {
          console.log('No agents found.');
          return;
        }
        console.log(`${agents.length} agent(s) found:`);
        for (const a of agents) {
          const score = a.matchScore != null ? `  score: ${a.matchScore.toFixed(2)}` : '';
          const band = a.reliability?.band ? `  reliability: ${a.reliability.band}` : '';
          console.log(`  ${a.agentId}  ${a.name}${score}${band}`);
          if (a.description) console.log(`    ${a.description}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  agents
    .command('get <agentId>')
    .description('Get agent details by id')
    .action(async (agentId: string) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new AgentSearchClient(creds.operatorKey, creds.agentId);
        const result = await client.getAgentById(agentId);
        if (!result.success) {
          throw new Error(result.error ?? 'Not found');
        }
        print(result, json);
      } catch (err) {
        handleError(err, json);
      }
    });
}
