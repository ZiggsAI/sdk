import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createZiggsOperations } from '../src/operations.js';
import type { ZiggsMcpConfig } from '../src/config.js';

function operations(session = 'codex-1', directory = false) {
  return createZiggsOperations({ operatorKey: 'test-key', agentId: 'agent', clientSessionId: session, instanceId: `cli:${session}`, app: 'Codex', workspaceIds: 'org-a' }, {
    ZIGGS_OPERATOR_KEY: 'test-key', resolvedAgentId: 'agent', directConnection: !directory, debugTools: false, coreOnly: false,
  } as ZiggsMcpConfig);
}

test('transport-free calls share schemas, preserve headers and do not release between invocations', async t => {
  t.after(() => mock.restoreAll());
  const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ chatId: 'room', reused: false }));
  });
  for (const session of ['codex-1', 'claude-2']) {
    const op = operations(session);
    const result = await op.call('ziggs_chat_open', { participantIds: ['person'], idempotencyKey: `open-${session}` }) as { isError?: boolean };
    assert.notEqual(result.isError, true, JSON.stringify(result));
    await op.close();
  }
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.url.endsWith('/chats')));
  assert.equal(requests[0].headers.get('X-Ziggs-Session'), 'codex-1');
  assert.equal(requests[1].headers.get('X-Ziggs-Session'), 'claude-2');
  assert.equal(requests[0].headers.get('X-Ziggs-Workspaces'), 'org-a');
  assert.equal(requests[0].headers.get('X-Ziggs-App'), 'Codex');
  assert.deepEqual(requests[0].body, { participantIds: ['person'], idempotencyKey: 'open-codex-1' });
});

test('discovery, strict validation and read-only refusal never contact the network', async t => {
  t.after(() => mock.restoreAll());
  const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const op = operations();
  t.after(() => op.close());
  assert.ok(op.list('task').some(row => row.name === 'ziggs_task_set_result'));
  assert.ok(op.describe('ziggs_inbox_ack').inputSchema);
  await assert.rejects(op.call('ziggs_chat_open', { participantId: 'person' }, true), /changes state/);
  await assert.rejects(op.call('ziggs_chat_open', { participantId: 'person', typo: true }), /did not run/);
  await assert.rejects(op.call('not_a_tool', {}), /unavailable/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('directory credentials keep their permitted surface and separate read from claim', async t => {
  const op = operations('directory', true);
  t.after(() => op.close());
  const names = op.list().map(r => r.name);
  assert.ok(names.includes('ziggs_inbox_claim'));
  assert.ok(!names.includes('ziggs_connection_proxy'));
  assert.equal((op.describe('ziggs_inbox').annotations as {readOnlyHint: boolean}).readOnlyHint, true);
  await assert.rejects(op.call('ziggs_connection_proxy', {}), /unavailable/);
});

test('an API refusal is returned as an error, never a success or an automatic retry', async t => {
  t.after(() => mock.restoreAll());
  const fetch = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 'TEST_REFUSAL', message: 'Refused' }), { status: 403 }));
  const op = operations();
  t.after(() => op.close());
  const result = await op.call('ziggs_chat_open', { participantId: 'person' }) as { isError?: boolean };
  assert.equal(result.isError, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test('acknowledgments preserve the opaque cursor, handled IDs and the claiming session', async t => {
  t.after(() => mock.restoreAll());
  const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }));
  });
  const op = operations('resumed-chat');
  t.after(() => op.close());
  const result = await op.call('ziggs_inbox_ack', { ack: 'opaque:cursor+with/slashes=', handledDeliveryIds: ['delivery-1'] }) as {isError?: boolean};
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/inbox/ack'));
  assert.equal(requests[0].headers.get('X-Ziggs-Session'), 'resumed-chat');
  assert.equal(requests[0].headers.get('X-Ziggs-Instance'), 'cli:resumed-chat');
  assert.deepEqual(requests[0].body, { upTo: 'opaque:cursor+with/slashes=', handledDeliveryIds: ['delivery-1'] });
});
