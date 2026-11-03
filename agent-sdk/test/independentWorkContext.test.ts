import {message} from './fixtures/message.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZiggsEffectHandler, type ZiggsEffectDeps } from '../src/platform/ZiggsEffectHandler.js';
import { contextScopesFromWake } from '../src/runtime/wakeEffects.js';
import { assertRequiredContext } from '../src/runtime/requiredContext.js';

const required = { history: [], agreements: [{ agreementId: 'work' }], users: [], agents: [],
  work: { minimumComplete: true, authorization: { active: true }, task: { taskId: 'task' } } };
function handler(snapshot: (query?: unknown) => Promise<typeof required> = async () => required) {
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
const trigger = { messageId: 'old-trigger', mandate:{agreementId:'work',taskId:'task'},content:{text:'Question'},intent:'request',recipients:[],
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
  const contextReads: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    urls.push(String(url));
    return String(url).endsWith('/messages/old-trigger') ? Response.json(trigger) : Response.json({}, { status: 500 });
  });
  const snap = await handler(async query => {
    contextReads.push(query);
    if ((query as { via: string }).via.startsWith('message:')) throw new Error('History unavailable');
    return required;
  })({ kind: 'read-context', sessionId: 'local-key', opts: {
    workScopes: [{ ...scope, messageId: 'old-trigger' }], includeHistory: true,
  } });
  assert.equal(urls.length, 1);
  assert.ok(urls[0].endsWith('/messaging/messages/old-trigger'));
  assert.deepEqual(contextReads.at(-1), { via: 'message:old-trigger', maxMessages: 12 });
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
    { type: 'message', agreementId: 'work', taskId: 'task', addressId: 'group-a', messageId: 'message-a' },
    { type: 'message', agreementId: 'work', taskId: 'task', addressId: 'group-b', messageId: 'message-b' },
  ] }, 'local-key');
  assert.equal(workScopes.length, 2);
  const sources: string[] = [];
  const contextReads: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    assert.match(path, /\/messaging\/messages\/message-[ab]$/);
    const messageId = path.split('/').at(-1)!;
    const addressId = messageId === 'message-a' ? 'group-a' : 'group-b';
    sources.push(addressId);
    return Response.json(message(messageId,addressId,{mandate:{agreementId:'work',taskId:'task'}}));
  });
  const snapshot = async (query?: unknown) => { contextReads.push(query); return required; };
  const snap = await handler(snapshot)({ kind: 'read-context', sessionId: 'local-key', opts: { workScopes } });
  assert.deepEqual(contextReads, [
    {via:'task:task',agreementId:'work',maxMessages:undefined},
    {via:'task:task',agreementId:'work',maxMessages:undefined},
    {via:'message:message-a',maxMessages:12},
    {via:'message:message-b',maxMessages:12},
  ]);
  assert.deepEqual(sources.sort(), ['group-a', 'group-b']);
  const packets = (snap.work as { contexts: Array<{ history: Array<{ text: string }> }> }).contexts;
  assert.deepEqual(packets.map(p => p.history[0].text), ['group-a', 'group-b']);
  assert.equal(snap.unavailable, false);
});

test('an exact trigger cannot be substituted with another message', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(message('different-trigger','Wrong message')));
  const snap = await handler()({ kind: 'read-context', sessionId: 'local-key', opts: {
    workScopes: [{ ...scope, messageId: 'old-trigger' }],
  } });
  assert.equal(snap.unavailable, true);
});

test('navigation on task wakes is not a message input', () => {
  assert.deepEqual(contextScopesFromWake({ type: 'task_result', addressId: 'obsolete-group',
    result: { agreementId: 'work', taskId: 'task' } }, 'local-key'), [scope]);
});

test('a historical address hint alone does not select a snapshot', async () => {
  let calls = 0;
  const read = createZiggsEffectHandler({
    agentId:'agent',operatorKey:'key',contextReadClient:{snapshot:async()=>{calls++;return required;}} as any,
    artifactsClient:{} as any,taskService:{} as any,agreementService:{} as any,toolManager:{} as any,
    messageSender:async()=>({}) as any,conversationFor:()=>({addressId:'retired-room'}),
  });
  const snap = await read({kind:'read-context',sessionId:'retired-room'});
  assert.equal(calls,0);assert.match(String((snap.work as any).instruction),/exact message, artifact, task or agreement/);
});
test('an explicit resource snapshot does not inherit the wake agreement or task', async t => {
  const reads:unknown[]=[];
  t.mock.method(globalThis,'fetch',async()=>Response.json(message('private-message','Exact')));
  const read=handler(async query=>{reads.push(query);return required;});
  await read({kind:'read-context',sessionId:'local-key',opts:{via:'message:private-message',workScopes:[{messageId:'private-message'}]}});
  assert.deepEqual(reads,[{via:'message:private-message',maxMessages:undefined}]);
});

test('a message that arrived inside work reads the work, then the message on its own', async t => {
  // Mirrors ContextReadClient.snapshot: one exact message is never selected
  // beside another resource.
  const calls: Array<Record<string, unknown>> = [];
  const guarded = async (query?: unknown) => {
    const opts = query as Record<string, unknown>;
    calls.push(opts);
    if (String(opts.via).startsWith('message:') && (opts.agreementId || opts.artifactId))
      throw new Error('ContextReadClient.snapshot: select an exact message independently of other resources');
    return required;
  };
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    assert.equal(path, '/messaging/messages/old-trigger');
    assert.equal(calls.length, 1, 'the work snapshot is read before the trigger');
    return Response.json(trigger);
  });
  const snap = await handler(guarded)({ kind: 'read-context', sessionId: 'local-key', opts: {
    workScopes: [{ ...scope, messageId: 'old-trigger' }],
  } });
  assert.equal(snap.unavailable, undefined, 'the work context is available');
  assert.equal(calls[0].messageId, undefined, 'the snapshot selects the work only');
  assert.deepEqual(calls, [
    { via: 'task:task', agreementId: 'work', maxMessages: undefined },
    { via: 'message:old-trigger', maxMessages: 12 },
  ]);
  assert.deepEqual(paths, ['/messaging/messages/old-trigger']);
  assert.equal((snap.messageRecord as { messageId?: string } | undefined)?.messageId, 'old-trigger', 'the trigger is still read');
  assert.deepEqual(snap.history.map(entry => entry.messageId), ['old-trigger']);
});

test('a message on its own is still selected by the snapshot', async t => {
  const calls: Array<Record<string, unknown>> = [];
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    assert.equal(path, '/messaging/messages/only-message');
    return Response.json(message('only-message', 'An exact standalone message'));
  });
  const h = createZiggsEffectHandler({
    agentId: 'agent', operatorKey: 'key',
    contextReadClient: { snapshot: async (opts: Record<string, unknown>) => { calls.push(opts); return required; } } as unknown as ZiggsEffectDeps['contextReadClient'],
    artifactsClient: {} as ZiggsEffectDeps['artifactsClient'],
    taskService: {} as ZiggsEffectDeps['taskService'],
    agreementService: {} as ZiggsEffectDeps['agreementService'],
    toolManager: {} as ZiggsEffectDeps['toolManager'], messageSender: async () => ({}),
    conversationFor: () => undefined,
  });
  const snap = await h({ kind: 'read-context', sessionId: 'local-key', opts: { workScopes: [{ messageId: 'only-message' }] } });
  assert.deepEqual(calls, [{ via: 'message:only-message', maxMessages: undefined }]);
  assert.deepEqual(paths, ['/messaging/messages/only-message']);
  assert.equal(snap.unavailable, undefined, 'the message context is available');
  assert.equal((snap.messageRecord as { messageId?: string } | undefined)?.messageId, 'only-message');
  assert.deepEqual(snap.history.map(entry => entry.messageId), ['only-message']);
});
