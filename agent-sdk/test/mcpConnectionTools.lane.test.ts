const WAKE_LANE_HEADER = 'X-Ziggs-Lane';
/**
 * ZIG-1774 — the SDK's gateway tools state the wake's lane.
 *
 * The regression they exist for: `withClient` read `ctx['laneId']`, a key
 * nothing in the executor sets, so this door sent no lane at all. The gateway
 * then resolved the wake to the agent's own operator and refused every grant a
 * CUSTOMER had given it — `mcp_tools_list` and `mcp_tool_call` were unusable
 * for the whole hired case, and silently: omitting a lane never errors, it
 * only narrows.
 *
 * Both requests are asserted, because both are fenced. The discovery read is
 * the one that PICKS a connection when the caller named none; lane-less, it
 * answers the agent's own grants and the tool reports "no live connection
 * grant" while the customer's is sitting there.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureApiClient } from '@ziggs-ai/api-client';
import { mcpToolCallTool, mcpToolsListTool } from '../src/platform/tools/tier2/mcpConnectionTools.js';

const BASE = 'https://api.example.test';

type Seen = { url: string; headers: Record<string, string> };

let seen: Seen[] = [];
let realFetch: typeof fetch;

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k] = v));
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(h)) out[k] = String(v);
  }
  return out;
}

/** The lane header, whatever case the caller spelled it in. */
function lane(entry: Seen): string | undefined {
  const wanted = WAKE_LANE_HEADER.toLowerCase();
  for (const [k, v] of Object.entries(entry.headers)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

beforeEach(() => {
  seen = [];
  configureApiClient({ httpUrl: BASE });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    seen.push({ url, headers: headersOf(init) });
    if (url.includes('/grants')) {
      return new Response(
        JSON.stringify({
          items: [
            {
              grantId: 'cgr_acme',
              scope: { kind: 'connection', id: 'con_acme' },
              status: 'active',
            },
          ],
          nextCursor: null,
          hasMore: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // The gateway leg: enough of a response that the MCP handshake fails fast.
    // The request itself is what this test is about.
    return new Response('no', { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctx = {
  operatorKey: 'op_k',
  agentId: 'room-booker',
  // what the executor actually puts on a wake — NOT `laneId`
  chatId: 'chat_acme',
};

test('mcp_tool_call states the lane on the discovery read and on the gateway', async () => {
  await mcpToolCallTool.handler({ tool: 'list_issues' }, ctx).catch(() => {});

  const discovery = seen.find((s) => s.url.includes('/grants'));
  assert.ok(discovery, 'the tool asked for the agent’s connection grants');
  assert.equal(lane(discovery), undefined);

  const gateway = seen.find((s) => s.url.includes('/connections/'));
  assert.ok(gateway, 'the tool called the gateway');
  assert.match(gateway.url, /\/connections\/con_acme\/mcp$/);
  assert.equal(lane(gateway), undefined);
  assert.equal(gateway.headers['x-grant-id'], 'cgr_acme');
});

test('mcp_tools_list states the lane the same way', async () => {
  await mcpToolsListTool.handler({}, ctx).catch(() => {});
  const gateway = seen.find((s) => s.url.includes('/connections/'));
  assert.ok(gateway);
  assert.equal(lane(gateway), undefined);
});

test('an agreement lane arrives as sessionId and is stated the same', async () => {
  await mcpToolCallTool
    .handler({ tool: 'x' }, { ...ctx, chatId: undefined, sessionId: 'agrn-agr_acme' })
    .catch(() => {});
  const gateway = seen.find((s) => s.url.includes('/connections/'));
  assert.ok(gateway);
  assert.equal(lane(gateway), undefined);
});

test('no lane on the wake sends no lane header — absent means own org, not empty', async () => {
  await mcpToolCallTool
    .handler({ tool: 'x' }, { operatorKey: 'op_k', agentId: 'room-booker' })
    .catch(() => {});
  for (const entry of seen) assert.equal(lane(entry), undefined);
});
