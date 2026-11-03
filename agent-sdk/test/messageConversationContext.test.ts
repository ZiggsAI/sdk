import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZiggsEffectHandler, type ZiggsEffectDeps } from '../src/platform/ZiggsEffectHandler.js';
import { contextSnapshotTool } from '../src/brain/claudeSdkTools.js';
import { message } from './fixtures/message.js';

const prior = message('prior', 'Create a page listing all my pages', { timestamp: '2026-11-03T01:00:00Z' });
const answer = message('answer', 'This needs an agreement', { timestamp: '2026-11-03T01:00:01Z' });
const followup = message('followup', 'Create that agreement and share it with me', { timestamp: '2026-11-03T01:00:02Z' });
const packet = (history = [prior, answer, followup]) => ({
  history, agreements: [], users: [], agents: [],
  work: { trigger: { kind: 'message', messageId: followup.messageId }, minimumComplete: true },
});
function reader(snapshot: (query: Record<string, unknown>) => Promise<unknown>) {
  return createZiggsEffectHandler({
    agentId: 'agent', operatorKey: 'key',
    contextReadClient: { snapshot } as ZiggsEffectDeps['contextReadClient'],
    artifactsClient: {} as ZiggsEffectDeps['artifactsClient'],
    taskService: {} as ZiggsEffectDeps['taskService'],
    agreementService: {} as ZiggsEffectDeps['agreementService'],
    toolManager: {} as ZiggsEffectDeps['toolManager'], messageSender: async () => ({}),
  });
}

test('a follow-up without replyTo preserves the server-authorized conversation by default', async t => {
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.ok(String(url).endsWith('/messaging/messages/followup'));
    return Response.json(followup);
  });
  const calls: unknown[] = [];
  const eff = reader(async query => { calls.push(query); return packet(); });
  const result = await eff({ kind: 'read-context', sessionId: 'fresh-followup-session', opts: { workScopes: [{ messageId: 'followup' }] } });
  assert.deepEqual(result.history.map(row => row.text), [prior.content.text, answer.content.text, followup.content.text]);
  assert.equal(result.messageRecord?.messageId, 'followup');
  assert.equal(result.messageMandate, undefined, 'history never selects work');
  assert.equal(calls.length, 1, 'no unbounded messages or replies scan');
});

test('an explicit minimal read keeps only the trigger and no duplicate history', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(followup));
  const result = await reader(async query => {
    assert.equal(query.maxMessages, 1, 'send preparation must not read or record unnecessary history dependencies');
    return packet();
  })({
    kind: 'read-context', sessionId: 'followup',
    opts: { workScopes: [{ messageId: 'followup' }], includeHistory: false },
  });
  assert.deepEqual(result.history.map(row => row.messageId), ['followup']);
});

test('a message inside work reads its exact conversation without inheriting another audience', async t => {
  const scoped = { ...followup, mandate: { agreementId: 'work', taskId: 'task' } };
  t.mock.method(globalThis, 'fetch', async () => Response.json(scoped));
  const selectedWork = { minimumComplete: true, task: { taskId: 'task' } };
  const calls: unknown[] = [];
  const result = await reader(async query => {
    calls.push(query);
    return String(query.via).startsWith('message:') ? packet([prior, scoped])
      : { ...packet([]), agreements: [{ agreementId: 'work' }], work: selectedWork };
  })({ kind: 'read-context', sessionId: 'work', opts: { workScopes: [{ agreementId: 'work', taskId: 'task', messageId: 'followup' }] } });
  assert.deepEqual(calls, [
    { via: 'task:task', agreementId: 'work', maxMessages: undefined },
    { via: 'message:followup', maxMessages: 12 },
  ]);
  assert.deepEqual(result.work, selectedWork);
  assert.deepEqual(result.messageMandate, { agreementId: 'work', taskId: 'task' });
  assert.deepEqual(result.history.map(row => row.messageId), ['prior', 'followup']);
});

test('execution revocation during message-context reading prevents a turn with stale work', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...followup, mandate: { agreementId: 'work' } }));
  const result = await reader(async query => {
    if (String(query.via).startsWith('message:')) throw Object.assign(new Error('Revoked'), { status: 403, code: 'EXECUTION_CONTEXT_CHANGED' });
    return packet([]);
  })({ kind: 'read-context', sessionId: 'work', opts: { workScopes: [{ agreementId: 'work', messageId: 'followup' }] } });
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.history, []);
});

test('the context tool leaves the message-history default intact but preserves an explicit opt-out', async () => {
  const effects: unknown[] = [];
  const eff = async (effect: unknown) => { effects.push(effect); return packet(); };
  const ctx = { operatorKey: 'key', agentId: 'agent', sessionId: 'followup', eff };
  await contextSnapshotTool.handler({}, ctx);
  await contextSnapshotTool.handler({ includeHistory: false }, ctx);
  assert.equal((effects[0] as { opts: { includeHistory?: boolean } }).opts.includeHistory, undefined);
  assert.equal((effects[1] as { opts: { includeHistory?: boolean } }).opts.includeHistory, false);
});
