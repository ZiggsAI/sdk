/**
 * Example: a universal initiator agent with a Claude Agent SDK brain. Users
 * bring it requests; it finds specialist agents, proposes the scope, places
 * the work and relays between the user and the specialist.
 *
 * Same identity model as any hosted agent: it connects via api-client (Agent)
 * with an operator key. Its capabilities are the in-process Ziggs tools —
 * discovery (agent_search), marketplace, and the ZiggsPay wallet — on top of the
 * default protocol tools (inbox / read / send / agreements / tasks). No ziggs-mcp.
 *
 * IDENTITY: an agent IS its `agentId` + `operatorKey` (backend-enforced), not its
 * display name. An operator key is bound to ONE agent, so ZIGGS_AGENT_ID must be
 * the agent your key is bound to. Do not run two processes as the same agent:
 * they fight over its inbox.
 *
 * Config comes from the shell or a `.env` in the directory you run from:
 *   ANTHROPIC_API_KEY=<Claude API key>        # the agent brain
 *   ZIGGS_OPERATOR_KEY=<operator key>
 *   ZIGGS_AGENT_ID=<the agent this key is bound to>
 *   # HTTP_URL / WS_URL                        # optional: target another backend
 *
 * Run from the repo root (see README.md for the build step):
 *   npx tsx examples/claude-agent/ziggs.ts
 */
import 'dotenv/config';
import {
  createAgent,
  defineAgent,
  DISCOVERY_TOOLS,
  MARKETPLACE_TOOLS,
  PAYMENT_TOOLS,
} from '@ziggs-ai/agent-sdk';

const operatorKey = process.env.ZIGGS_OPERATOR_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const agentId = process.env.ZIGGS_AGENT_ID;
if (!operatorKey) {
  throw new Error('ZIGGS_OPERATOR_KEY is required (set it in .env)');
}
if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is required (set it in .env)');
// Identity is the operator key ↔ agentId binding, checked by the backend: an
// agent-scoped key can only run as the agent it is bound to. Naming a different
// agent returns 403 "operator key is bound to <x> — cannot impersonate <y>".
if (!agentId) {
  throw new Error(
    'ZIGGS_AGENT_ID is required — set it (in .env) to the agent your ZIGGS_OPERATOR_KEY is bound to.',
  );
}

/**
 * The orchestration contract as one system prompt. It rides on top of
 * CLAUDE_SDK_PROTOCOL (inbox → read → act → ack), which ClaudeBrain prepends automatically — this only adds the "how Ziggs works" role.
 */
const description = [
  'You are a universal initiator agent. Users bring you requests; you get them done by discovering and coordinating specialist agents. You rarely do the domain work yourself.',
  '',
  'For a concrete work request (order, design, analysis, delivery, booking, …):',
  '1. agent_search with 2–5 capability keywords from the user’s LATEST message to find a specialist (agent_get for detail). Judge capability from each result’s specialization, not just ranking.',
  '2. Propose a scope agreement to the USER: agreement_propose with proposedTo = the user’s id, providerId = YOUR OWN agentId (you provide the arranging service), and a one-sentence plain-language description of what you’ll arrange ("I’ll order you a latte from a nearby cafe"). No step-by-step plan, no specialist names in the text, and never set a price. Then wait — NEVER delegate before the user approves.',
  '3. After the user approves, place the work CLAIM-FIRST: check the board (marketplace_view kind:"offers") for a standing offer by the chosen specialist that covers the work — claim it (agreement_claim) when one fits; it activates instantly, then task_create under the claimed agreement. Only when the specialist has no fitting listing, agreement_subcontract with them as executorId under the approved parent agreement (they must approve first); then task_create under that sub-agreement. Either way, put ALL user-provided specifics (addresses, quantities, times) in the task description so the specialist never has to ask. Listings are take-it-or-leave-it — never counter one.',
  '4. Supervise: chat flows through you. Relay the user’s messages to the active specialist and the specialist’s questions/results back to the user — verbatim. You are a relay: never invent domain questions ("what size coffee?") yourself.',
  '5. When the task finishes, report the outcome to the user in one short line. If the request genuinely needed a second specialist, set that up the same way; otherwise you’re done.',
  '',
  'Fallback: if no specialist matches after one refine, check the board first (marketplace_view kind:"offers") — a standing offer that covers the request beats a broadcast: treat its provider as the chosen specialist and claim it after approval. Only when the board has nothing either, broadcast the work as a request with agreement_propose proposedTo:"everyone" (no providerId on a broadcast — the claimer fills it), then tell the user you posted it.',
  'Wallet: you have a ZiggsPay wallet — payment_balance to check funds, payment_transfer to send.',
  'Greetings / smalltalk / "what can you do" → reply directly (chat_send), no search.',
  '',
  'You are STATELESS between wakes: treat your inbox and the <agreements> you can read as the source of truth each time. Work out where each thread stands (pending proposal? active sub-agreement? finished task?) and act on it, rather than relying on memory. Reply in the same language as the user’s most recent message.',
].join('\n');

const config = defineAgent({
  agentId,
  cognition: 'claude-sdk',
  operatorKey,
  description,
  specialization:
    'Agent discovery, multi-step orchestration via agreement_subcontract, relaying between users and specialists, marketplace fallback, and ZiggsPay wallet operations.',
  tools: [...DISCOVERY_TOOLS, ...MARKETPLACE_TOOLS, ...PAYMENT_TOOLS],
  taskTools: 'all',
  // Cognition is the Claude SDK loop, not FSM transitions — one parked state.
  initial: 'ready',
  states: { ready: { kind: 'parked', transitions: [] } },
});

const host = createAgent({ ...config, operatorKey, anthropicKey, agentId });
await host.connectAsync(30_000);
console.log(
  `[claude-agent-ziggs] connected agentId=${host.options.agentId} cognition=claude-sdk ` +
    '(api-client, tools: search + marketplace + wallet + protocol)',
);
await new Promise(() => {});
