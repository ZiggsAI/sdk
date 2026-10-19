import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONNECTION_TOOLS,
  requestConnectionTool,
} from '../src/platform/tools/tier2/connectionTools.js';

type FetchCall = {
  url: string;
  opts: { method?: string; headers?: Record<string, string>; body?: string };
};

function stubFetch(
  t: { after: (fn: () => void) => void },
  body: unknown,
  ok = true,
  status = 200,
): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (url: unknown, opts: unknown) => {
    calls.push({ url: String(url), opts: (opts || {}) as FetchCall['opts'] });
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

const CTX = { operatorKey: 'op_test', agentId: 'agent_7' };

test('CONNECTION_TOOLS includes connection_request (ZIG-897)', () => {
  const names = CONNECTION_TOOLS.map((tool) => tool.schema.function['name']);
  assert.deepEqual(names, ['connection_proxy', 'connection_list_grants', 'connection_request']);
});

test('connection_request validates its inputs before any request', async () => {
  await assert.rejects(
    () => requestConnectionTool.handler({ serverUrl: 'https://x', tools: ['a'] }, CTX),
    /chatId is required/,
  );
  await assert.rejects(
    () => requestConnectionTool.handler({ chatId: 'c1', tools: ['a'] }, CTX),
    /serverUrl is required/,
  );
  await assert.rejects(
    () =>
      requestConnectionTool.handler(
        { chatId: 'c1', serverUrl: 'https://x', tools: [] },
        CTX,
      ),
    /non-empty array/,
  );
  // ZIG-2011 — nobody is asked by default.
  await assert.rejects(
    () =>
      requestConnectionTool.handler(
        { chatId: 'c1', serverUrl: 'https://x', tools: ['a'] },
        CTX,
      ),
    /recipientId is required/,
  );
});

test('connection_request opens the consent request in the working chat', async (t) => {
  const calls = stubFetch(t, {
    status: 'pending',
    agreementId: 'agr_consent_1',
    sentTo: { id: 'psn_ido', name: 'Ido', role: 'customer' },
    approveIn: { kind: 'chat', chatId: 'chat_1' },
    message: 'Sent to Ido. Ido approves it in this room.',
  });

  const out = (await requestConnectionTool.handler(
    {
      chatId: 'chat_1',
      serverUrl: 'https://mcp.example.com',
      tools: ['search', 'fetch'],
      reason: 'need web search',
      recipientId: 'psn_ido',
    },
    CTX,
  )) as Record<string, unknown>;

  assert.equal(out['ok'], true);
  assert.equal(out['agreementId'], 'agr_consent_1');
  // ZIG-2011 — the note says who got the card, as the server answered.
  assert.match(String(out['note']), /^Sent to Ido\. Ido approves it in this room\./);
  assert.doesNotMatch(String(out['note']), /your principal/);
  assert.match(String(out['note']), /grant_list/);

  const call = calls[0]!;
  assert.equal(call.opts.method, 'POST');
  assert.match(call.url, /\/connections\/mcp\/requests$/);
  assert.equal(call.opts.headers?.['X-Agent-Id'], 'agent_7');
  assert.equal('X-On-Behalf-Of-User' in (call.opts.headers ?? {}), false);
  assert.deepEqual(JSON.parse(call.opts.body ?? '{}'), {
    serverUrl: 'https://mcp.example.com',
    tools: ['search', 'fetch'],
    reason: 'need web search',
    chatId: 'chat_1',
    recipientId: 'psn_ido',
  });
});

test('connection_request surfaces backend failures with context', async (t) => {
  stubFetch(t, { message: 'nope' }, false, 403);
  await assert.rejects(
    () =>
      requestConnectionTool.handler(
        { chatId: 'c1', serverUrl: 'https://x', tools: ['a'], recipientId: 'psn_x' },
        CTX,
      ),
    (err: Error & { status?: number }) => {
      assert.match(err.message, /Connection request failed/);
      assert.match(err.message, /nope/);
      assert.equal(err.status, 403);
      return true;
    },
  );
});
