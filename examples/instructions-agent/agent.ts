import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSkillAgent } from '@ziggs-ai/agent-sdk';

const agentId = process.env.ZIGGS_AGENT_ID;
const operatorKey = process.env.ZIGGS_OPERATOR_KEY;
if (!agentId || !operatorKey || !process.env.ANTHROPIC_API_KEY) {
  throw new Error('Set ZIGGS_AGENT_ID, its bound ZIGGS_OPERATOR_KEY, and ANTHROPIC_API_KEY');
}
const file = resolve(process.argv[2] ?? 'SKILL.md');
const agent = createSkillAgent({ agentId, operatorKey, readInstructions: () => readFile(file, 'utf8') });
await agent.connectAsync();
console.log(`Connected ${agentId}; reading instructions from ${file} on each wake`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await agent.disconnect();
  await agent.drain(5_000);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
