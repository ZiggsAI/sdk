import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_TOOLS,
  openConversationTool,
} from '../src/platform/tools/tier2/chatTools.js';

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

test('CHAT_TOOLS exposes chat_open only — listing stays a context-rail read (ZIG-900)', () => {
  const names = CHAT_TOOLS.map((tool) => tool.schema.function['name']);
  assert.deepEqual(names, ['chat_open']);
});

test('chat_open requires participantId and creds', async () => {
  await assert.rejects(
    () => openConversationTool.handler({}, CTX),
    /participantId is required/,
  );
  await assert.rejects(
    () => openConversationTool.handler({ participantId: 'agent_peer' }, {}),
    /operatorKey missing/,
  );
});

test('chat_open POSTs /chats and returns the chatId with the grant note', async (t) => {
  const calls = stubFetch(t, { chatId: 'chat_42' });

  const out = (await openConversationTool.handler(
    { participantId: 'agent_peer' },
    CTX,
  )) as Record<string, unknown>;

  assert.equal(out['chatId'], 'chat_42');
  assert.match(String(out['note']), /grant_list with scopeKind \["chat"\]/);
  const call = calls[0]!;
  assert.equal(call.opts.method, 'POST');
  assert.match(call.url, /\/chats$/);
  assert.equal(call.opts.headers?.['X-Agent-Id'], 'agent_7');
  assert.deepEqual(JSON.parse(call.opts.body ?? '{}'), { participantId: 'agent_peer' });
});

test('chat_open surfaces backend failures (e.g. AGENT_NOT_PUBLISHED)', async (t) => {
  stubFetch(t, { message: 'AGENT_NOT_PUBLISHED' }, false, 403);
  await assert.rejects(
    () => openConversationTool.handler({ participantId: 'agent_peer' }, CTX),
    /AGENT_NOT_PUBLISHED|403/,
  );
});

test('hosted chat_open forwards people and an explicit room without picking a pair', async (t) => {
  const calls = stubFetch(t, { chatId: 'room', reused: true });
  await openConversationTool.handler({ chatId: 'room', participantIds: ['itay', 'paul'] }, CTX);
  assert.deepEqual(JSON.parse(calls[0].opts.body!), { chatId: 'room', participantIds: ['itay', 'paul'] });
});
