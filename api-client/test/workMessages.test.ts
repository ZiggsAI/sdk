import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkMessagesClient } from '../src/http/WorkMessagesClient.js';
import { ContextReadClient } from '../src/http/ContextReadClient.js';
import { withWorkExecutionId } from '../src/http/operatorHeaders.js';

test('controls are independent of history and retain explicit execution and task', async t => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string> });
    return Response.json({ canSend: true, recipients: [] });
  });
  await withWorkExecutionId('execution', () => new WorkMessagesClient('key', 'agent', 'http://test').controls('work/a', 'task/b'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://test/messaging/work/work%2Fa/controls?taskId=task%2Fb');
  assert.equal(calls[0].headers['X-Ziggs-Execution'], 'execution');
});

test('a work snapshot needs a resource reference, never a dummy chat or lane', async t => {
  const urls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    urls.push(new URL(String(url))); return Response.json({ history: [], agreements: [], agents: [], users: [] });
  });
  const client = new ContextReadClient('key', 'agent', 'http://test');
  await client.snapshot(undefined, { agreementId: 'work' });
  await client.snapshot(undefined, { agreementId: 'work', taskId: 'task' });
  await client.snapshot(undefined, { via: 'artifact:result' });
  assert.deepEqual(urls.map(u => u.searchParams.get('via')), ['agreement:work', 'task:task', 'artifact:result']);
  assert.ok(urls.every(u => !u.toString().includes('chat')));
  await assert.rejects(client.snapshot(undefined), /explicit resource/);
});

test('an FYI preserves intent and execution headers through the public client', async t => {
  let sent: Record<string, unknown> | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    assert.equal((init.headers as Record<string, string>)['X-Ziggs-Execution'], 'execution');
    return Response.json({ message: sent, outcome: 'created' });
  });
  await withWorkExecutionId('execution', () => new WorkMessagesClient('key', 'agent', 'http://test').send('work', {
    messageId: 'fyi', text: 'Information', recipientRef: 'reader', intent: 'notify',
  }));
  assert.equal(sent?.intent, 'notify');
});
