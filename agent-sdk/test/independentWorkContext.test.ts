import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZiggsEffectHandler, type ZiggsEffectDeps } from '../src/platform/ZiggsEffectHandler.js';
import { contextScopesFromWake } from '../src/runtime/wakeEffects.js';
import { assertRequiredContext } from '../src/runtime/requiredContext.js';

const required = { history: [], agreements: [{ agreementId: 'work' }], users: [], agents: [],
  work: { minimumComplete: true, authorization: { active: true }, task: { taskId: 'task' } } };
function handler(snapshot = async () => required) {
  return createZiggsEffectHandler({
    agentId: 'agent', operatorKey: 'key',
    contextReadClient: { snapshot } as unknown as ZiggsEffectDeps['contextReadClient'],
    artifactsClient: {} as ZiggsEffectDeps['artifactsClient'],
    taskService: {} as ZiggsEffectDeps['taskService'],
    agreementService: {} as ZiggsEffectDeps['agreementService'],
    toolManager: {} as ZiggsEffectDeps['toolManager'], messageSender: async () => ({}),
    conversationFor: () => ({ agreementId: 'work', taskId: 'task' }),
  });
}
const scope = { agreementId: 'work', taskId: 'task' };

test('readable proposals and expandable packets remain available for decisions and context recovery', () => {
  assert.doesNotThrow(() => assertRequiredContext({ work: { authorization: { active: false } } }));
  assert.doesNotThrow(() => assertRequiredContext({ work: { minimumComplete: false,
    expansion: [{ type: 'artifacts', via: 'artifact:input' }] } }));
});
const trigger = { messageId: 'old-trigger', agreementId: 'work', taskId: 'task', text: 'Question',
  timestamp: '2026-10-31T00:00:00Z', sender: { ref: 'customer', kind: 'user', isSelf: false },
  receiver: { ref: 'agent', kind: 'agent', isSelf: true } };

test('task initialization has no message-service dependency', async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('No message API should be called'); });
  const snap = await handler()({ kind: 'read-context', sessionId: 'local-key', opts: { workScopes: [scope] } });
  assert.deepEqual(snap.work, required.work);
  assert.deepEqual(snap.history, []);
  assert.equal(snap.unavailable, undefined);
});

test('optional history failure preserves required work without stale content', async t => {
  for (const status of [403, 500]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'Unavailable' }, { status }));
    const snap = await handler()({ kind: 'read-context', sessionId: 'local-key', opts: { workScopes: [scope], includeHistory: true } });
    assert.deepEqual(snap.work, required.work);
    assert.deepEqual(snap.history, []);
    assert.equal(snap.historyUnavailable, true);
    assert.equal(snap.unavailable, undefined);
    t.mock.restoreAll();
  }
});

test('the exact triggering message remains required and separate from optional history', async t => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    urls.push(String(url));
    return String(url).endsWith('/messages/old-trigger') ? Response.json(trigger) : Response.json({}, { status: 500 });
  });
  const snap = await handler()({ kind: 'read-context', sessionId: 'local-key', opts: {
    workScopes: [{ ...scope, messageId: 'old-trigger' }], includeHistory: true,
  } });
  assert.equal(urls.length, 2);
  assert.ok(urls.every(u => u.includes('/messaging/work/work/messages')));
  assert.deepEqual(snap.history.map(m => m.messageId), ['old-trigger']);
  assert.equal(snap.unavailable, undefined);
  assert.equal(snap.historyUnavailable, true);
});

test('an inaccessible trigger fails closed even when work itself is readable', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 403 }));
  const snap = await handler()({ kind: 'read-context', sessionId: 'local-key', opts: {
    workScopes: [{ ...scope, messageId: 'old-trigger' }],
  } });
  assert.equal(snap.unavailable, true);
  assert.deepEqual(snap.history, []);
});

test('failed required context never proceeds to optional message history', async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('No history after denied work'); });
  const snap = await handler(async () => { throw Object.assign(new Error('Revoked'), { status: 403 }); })({
    kind: 'read-context', sessionId: 'local-key', opts: { workScopes: [scope], includeHistory: true },
  });
  assert.equal(snap.unavailable, true);
});

test('execution revocation while loading optional history still stops work', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 'EXECUTION_CONTEXT_CHANGED', error: 'Audience changed' }, { status: 403 }));
  const snap = await handler()({ kind: 'read-context', sessionId: 'local-key', opts: { workScopes: [scope], includeHistory: true } });
  assert.equal(snap.unavailable, true);
  assert.deepEqual(snap.history, []);
});

test('batched shared triggers keep their own exact source while work reads stay independent', async t => {
  const workScopes = contextScopesFromWake({ type: 'batch', events: [
    { type: 'message', agreementId: 'work', taskId: 'task', chatId: 'group-a', messageId: 'same-id' },
    { type: 'message', agreementId: 'work', taskId: 'task', chatId: 'group-b', messageId: 'same-id' },
  ] }, 'local-key');
  assert.equal(workScopes.length, 2);
  const sources: string[] = [];
  const contextReads: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    assert.match(path, /\/conversations\/shared\/group-[ab]\/messages\/same-id$/);
    const chatId = path.split('/')[3];
    sources.push(chatId);
    return Response.json({ messageId: 'same-id', chatId, text: chatId, timestamp: '2026-10-31T00:00:00Z',
      sender: { id: 'user', type: 'user' }, receiver: { id: 'agent', type: 'agent' }, entryType: 'message', contentType: 'text' });
  });
  const snapshot = async (chatId?: string) => { contextReads.push(chatId); return required; };
  const snap = await handler(snapshot)({ kind: 'read-context', sessionId: 'local-key', opts: { workScopes } });
  assert.deepEqual(contextReads, [undefined, undefined]);
  assert.deepEqual(sources.sort(), ['group-a', 'group-b']);
  const packets = (snap.work as { contexts: Array<{ history: Array<{ text: string }> }> }).contexts;
  assert.deepEqual(packets.map(p => p.history[0].text), ['group-a', 'group-b']);
  assert.equal(snap.unavailable, false);
});

test('a shared trigger cannot be substituted with a message from another address', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ messageId: 'old-trigger', chatId: 'wrong-group' }));
  const snap = await handler()({ kind: 'read-context', sessionId: 'local-key', opts: {
    workScopes: [{ ...scope, chatId: 'expected-group', messageId: 'old-trigger' }],
  } });
  assert.equal(snap.unavailable, true);
});

test('navigation on task wakes is not a message input', () => {
  assert.deepEqual(contextScopesFromWake({ type: 'task_result', chatId: 'obsolete-group',
    result: { agreementId: 'work', taskId: 'task' } }, 'local-key'), [scope]);
});
