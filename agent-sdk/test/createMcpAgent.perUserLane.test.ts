/**
 * ZIG-1774 — the per-user relay door states the wake's lane.
 *
 * `resolvePerUserGatewayTarget` has taken a fifth `laneId` argument since
 * ZIG-1720; the one caller omitted it, so the relay sent no lane and the
 * gateway resolved every wake to the agent's own operator. A connection grant
 * the CUSTOMER gave was then refused with "given by org_acme, acting for
 * org_fleet" — on the door built for exactly that case.
 *
 * Sessions are also keyed by lane here: the headers are fixed when the
 * transport is built, so a client cached under one lane would carry that
 * lane's fence into the next customer's wake.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpAgent } from '../src/mcp/createMcpAgent.js';
import { WAKE_LANE_HEADER } from '@ziggs-ai/api-client';

const BASE = 'https://api.example.test';

type Seen = { url: string; headers: Record<string, string> };
let seen: Seen[] = [];
let realFetch: typeof fetch;

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => (out[k] = v));
  else if (Array.isArray(h)) for (const [k, v] of h) out[k] = v;
  else for (const [k, v] of Object.entries(h)) out[k] = String(v);
  return out;
}

function lane(entry: Seen): string | undefined {
  const wanted = WAKE_LANE_HEADER.toLowerCase();
  for (const [k, v] of Object.entries(entry.headers)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

beforeEach(() => {
  seen = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: typeof input === 'string' ? input : input.toString(),
      headers: headersOf(init),
    });
    // The handshake fails; the request it made is the subject here.
    return new Response('no', { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function callThroughPerUserDoor(context: Record<string, unknown>) {
  const { agent } = await createMcpAgent({
    transport: {
      type: 'ziggs-per-user',
      baseUrl: BASE,
      agentId: 'meeting-scheduler',
      operatorKey: 'op_k',
    },
    agentId: 'meeting-scheduler',
    operatorKey: 'op_k',
    name: 'Scheduler',
    description: 'books rooms',
    anthropicKey: 'sk-ant-test',
    toolSchema: [{ name: 'list_events', description: 'list', inputSchema: { type: 'object' } }],
  });
  const tool = (agent.options.tools ?? []).find(
    (t) => t.schema.function.name === 'list_events',
  );
  assert.ok(tool, 'the MCP tool was mapped onto the agent');
  await tool.handler({}, context).catch(() => {});
  return seen.filter((s) => s.url.includes('/connections/mcp/relay'));
}

test('the relay states the lane the wake ran in', async () => {
  const calls = await callThroughPerUserDoor({
    senderId: 'user_acme',
    chatId: 'chat_acme',
  });
  assert.ok(calls.length > 0, 'the relay door was called');
  assert.equal(lane(calls[0]), 'chat_acme');
  assert.equal(calls[0].headers['x-on-behalf-of-user'], 'user_acme');
});

test('an agreement lane rides in as sessionId', async () => {
  const calls = await callThroughPerUserDoor({
    senderId: 'user_acme',
    sessionId: 'agrn-agr_acme',
  });
  assert.ok(calls.length > 0);
  assert.equal(lane(calls[0]), 'agrn-agr_acme');
});

test('a wake with no lane sends no lane header', async () => {
  const calls = await callThroughPerUserDoor({ senderId: 'user_acme' });
  assert.ok(calls.length > 0);
  assert.equal(lane(calls[0]), undefined);
});
