import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { WorkMessagesClient } from '../src/http/WorkMessagesClient.js';
import { SharedMessagesClient } from '../src/http/SharedMessagesClient.js';
import { withWorkExecutionId } from '../src/http/operatorHeaders.js';
import { readConversationCapability, sendConversationCapability } from '../src/capabilities/conversations.js';

afterEach(() => mock.restoreAll());
it('uses the selected execution for roomless reads and replies without rewriting explicit scope', async () => {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => { calls.push({url: String(url), init}); return Response.json({}); });
  const client = new WorkMessagesClient('key', 'agent', 'http://test');
  await withWorkExecutionId('selected', async () => {
    await client.read('work/a', {taskId: 'task', before: 'cursor', limit: 12});
    await client.get('work/a', 'message/b');
    await client.send('work/a', {messageId: 'stable', text: 'Answer', replyToMessageId: 'message/b'});
  });
  assert.equal(calls[0].url, 'http://test/messaging/work/work%2Fa/messages?taskId=task&before=cursor&limit=12');
  assert.equal(calls[1].url, 'http://test/messaging/work/work%2Fa/messages/message%2Fb');
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), {messageId: 'stable', text: 'Answer', replyToMessageId: 'message/b'});
  assert.ok(calls.every(c => (c.init?.headers as Record<string,string>)['X-Ziggs-Execution'] === 'selected'));
  assert.ok(calls.every(c => !c.url.includes('/conversations/shared')));
});
it('preserves a scoped refusal instead of returning empty history', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({message: 'Work audience changed'}, {status: 403}));
  await assert.rejects(new WorkMessagesClient('key', 'agent', 'http://test').read('work'), (error: unknown) => (error as {status:number}).status === 403);
});
it('reads an exact shared message with the selected execution and no scope substitution', async () => {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => { calls.push({url: String(url), init}); return Response.json({messageId: 'm/a'}); });
  await withWorkExecutionId('shared-execution', () => new SharedMessagesClient('key', 'agent', 'http://test').read('space/a', {messageId: 'm/a'}));
  assert.equal(calls[0].url, 'http://test/conversations/shared/space%2Fa/messages/m%2Fa');
  assert.equal((calls[0].init?.headers as Record<string,string>)['X-Ziggs-Execution'], 'shared-execution');
});
it('conversation tools call the runner backend they were given', async () => {
  const urls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: unknown) => { urls.push(String(url)); return Response.json({ message: { messageId: 'stable' }, outcome: 'created' }); });
  const env = { creds: { operatorKey: 'key', agentId: 'agent' }, baseUrl: 'http://runner.test', surface: 'sdk' as const };
  await readConversationCapability.handler({ agreementId: 'work', taskId: 'task' }, env);
  await readConversationCapability.handler({ agreementId: 'work', messageId: 'm' }, env);
  await sendConversationCapability.handler({ agreementId: 'work', messageId: 'stable', text: 'Answer', replyToMessageId: 'm' }, env);
  assert.equal(urls.length, 3);
  assert.ok(urls.every(url => url.startsWith('http://runner.test/messaging/work/work/messages')), urls.join(' '));
});
it('preserves agreement-scoped message sources through the conversation tool', async () => {
  let body: Record<string, unknown> = {};
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ message: { messageId: 'answer' }, outcome: 'created' });
  });
  const sources = [{ kind: 'message', id: 'question', agreementId: 'work' }];
  await sendConversationCapability.handler({ agreementId: 'work', messageId: 'answer', text: 'Answer', recipientRef: 'recipient', sources }, { creds: { operatorKey: 'key', agentId: 'agent' }, baseUrl: 'http://test' });
  assert.deepEqual(body.sources, sources);
  assert.ok(sendConversationCapability.params.sources.items?.properties?.agreementId);
});

it('validates the exact assigned shared record before handing it to an executor', async () => {
  let row = { chatId: 'space', messageId: 'wanted', text: 'hello' };
  const urls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: unknown) => { urls.push(String(url)); return Response.json(row); });
  const client = new SharedMessagesClient('key', 'agent', 'http://test');
  assert.equal((await client.get('space', 'wanted')).text, 'hello');
  row = { ...row, messageId: 'different' };
  await assert.rejects(client.get('space', 'wanted'), /does not match/);
  row = { ...row, messageId: 'wanted', chatId: 'elsewhere' };
  await assert.rejects(client.get('space', 'wanted'), /does not match/);
  assert.ok(urls.every(url => url === 'http://test/conversations/shared/space/messages/wanted'));
});
