import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationsClient } from '../src/http/ConversationsClient.js';
import { withWorkExecutionId } from '../src/http/operatorHeaders.js';

afterEach(() => mock.restoreAll());
it('uses the selected execution for roomless reads and replies without rewriting explicit scope', async () => {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => { calls.push({url: String(url), init}); return Response.json({}); });
  const client = new ConversationsClient('key', 'agent', 'http://test');
  await withWorkExecutionId('selected', async () => {
    await client.read('work/a', {taskId: 'task', before: 'cursor', limit: 12});
    await client.get('work/a', 'message/b');
    await client.send('work/a', {messageId: 'stable', text: 'Answer', replyToMessageId: 'message/b'});
  });
  assert.equal(calls[0].url, 'http://test/conversations/work%2Fa/messages?taskId=task&before=cursor&limit=12');
  assert.equal(calls[1].url, 'http://test/conversations/work%2Fa/messages/message%2Fb');
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), {messageId: 'stable', text: 'Answer', replyToMessageId: 'message/b'});
  assert.ok(calls.every(c => (c.init?.headers as Record<string,string>)['X-Ziggs-Execution'] === 'selected'));
  assert.ok(calls.every(c => !c.url.includes('/conversations/shared')));
});
it('preserves a scoped refusal instead of returning empty history', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({message: 'Work audience changed'}, {status: 403}));
  await assert.rejects(new ConversationsClient('key', 'agent', 'http://test').read('work'), (error: unknown) => (error as {status:number}).status === 403);
});
it('reads an exact shared message with the selected execution and no scope substitution', async () => {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => { calls.push({url: String(url), init}); return Response.json({messageId: 'm/a'}); });
  await withWorkExecutionId('shared-execution', () => new ConversationsClient('key', 'agent', 'http://test').readShared('space/a', {messageId: 'm/a'}));
  assert.equal(calls[0].url, 'http://test/conversations/shared/space%2Fa/messages/m%2Fa');
  assert.equal((calls[0].init?.headers as Record<string,string>)['X-Ziggs-Execution'], 'shared-execution');
});
