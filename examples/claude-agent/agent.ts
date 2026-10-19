/**
 * Example: a hosted Ziggs agent whose brain is the Claude Agent SDK.
 *
 * Connects like any hosted agent: api-client inbox + operator key via
 * Agent. Ziggs tools are in-process (ToolManager), not ziggs-mcp stdio.
 *
 * Prerequisites (shell or a `.env` in the directory you run from):
 *   ANTHROPIC_API_KEY=<Claude API key>
 *   ZIGGS_OPERATOR_KEY=<operator key bound to the agent>
 *   ZIGGS_AGENT_ID=<the agent that key is bound to>
 *
 * Run from the repo root after `npm install && npm run build -w @ziggs-ai/api-client -w @ziggs-ai/agent-sdk`:
 *   npx tsx examples/claude-agent/agent.ts
 */
import 'dotenv/config';
import { createAgent, defineAgent, claudeBrain, DISCOVERY_TOOLS } from '@ziggs-ai/agent-sdk';

const operatorKey = process.env.ZIGGS_OPERATOR_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const agentId = process.env.ZIGGS_AGENT_ID;
if (!operatorKey) throw new Error('ZIGGS_OPERATOR_KEY is required');
if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is required');
if (!agentId) throw new Error('ZIGGS_AGENT_ID is required (the agent your operator key is bound to)');

const config = defineAgent({
  agentId,
  cognition: 'claude-sdk',
  operatorKey,
  description:
    'You are a general-purpose Ziggs inbox agent. Each wake hands you one event; read context when you need it, respond in chat when appropriate, and drive tasks to completion.',
  specialization:
    'Inbox triage and lightweight task handling: handle the event you were woken with, then stop.',
  tools: DISCOVERY_TOOLS,
  taskTools: 'all',
  // Cognition is the Claude SDK loop, not FSM transitions: one parked state.
  initial: 'ready',
  states: { ready: { kind: 'parked', transitions: [] } },
});

const host = createAgent({
  ...config,
  operatorKey,
  agentId,
  brain: claudeBrain({ anthropicKey }),
});

await host.connectAsync(30_000);
console.log(
  `[claude-agent-example] connected agentId=${host.options.agentId} brain=claude (api-client, tools: discovery + protocol, no ziggs-mcp)`,
);
await new Promise(() => {});
