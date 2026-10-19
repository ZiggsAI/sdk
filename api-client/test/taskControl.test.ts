import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeTaskControl, requestTaskControl } from '../src/http/TaskClient.js';
const creds = { operatorKey: 'test-key', agentId: 'worker' };
test('task control preserves acknowledgement status and sends the requested revision', async t => {
  const body = { action: 'pause' as const, requestId: 'r1', previousRequestId: null };
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    assert.match(String(url), /\/tasks\/task%2F1\/control$/);
    assert.equal(init?.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    return new Response(JSON.stringify({ ok: true, taskId: 'task/1', state: 'active', control: { ...body, status: 'requested' } }));
  });
  const result = await requestTaskControl('task/1', body, creds);
  assert.equal((result.control as { status: string }).status, 'requested');
});
test('runtime acknowledgement uses its own endpoint and preserves superseded errors', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    assert.match(String(url), /\/tasks\/t1\/control\/ack$/);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { requestId: 'r1', supported: false });
    return new Response(JSON.stringify({ message: 'Control request was superseded' }), { status: 409 });
  });
  await assert.rejects(acknowledgeTaskControl('t1', 'r1', false, creds), (err: unknown) => (err as { status?: number }).status === 409);
});
