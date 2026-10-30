import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pollInboxOnce } from '../src/platform/inboxLoop.js';
import { SeenMessages } from '../src/platform/SeenMessages.js';
import { Agent } from '../src/Agent.js';
import { laneKeyFor } from '../src/platform/laneKey.js';
import type { WorkExecutionContext } from '@ziggs-ai/api-client';

const context = (id: string): WorkExecutionContext => ({ contextId: id, actorId: 'worker', principalId: 'owner', position: 'provider', agreementId: 'work', taskId: null, chatId: null, audienceIds: ['owner', 'customer'], authorityRevision: 'rev' } as WorkExecutionContext);
const ref = { kind: 'message', resourceId: 'm1', responsibilityId: 'r1', chatId: null, agreementId: 'work', taskId: null, assigneeId: 'worker', ts: '2026-10-30T10:00:00.000Z', executionContext: context('ctx1') };
const envelope = { asOf: ref.ts, ackTo: ref.ts, deliveries: [ref], chats: [], tasksAwaitingMe: [], proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [] };
describe('roomless message assignments', () => {
  afterEach(() => mock.restoreAll());
  it('reads the exact message with execution, hands over once, then acknowledges the responsibility', async () => {
    const calls: string[] = []; const handed: Record<string, unknown>[] = []; const acks: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith('/inbox') && !init?.method) return Response.json(envelope);
      if (String(url).endsWith('/conversations/work/messages/m1')) {
        assert.equal((init?.headers as Record<string, string>)['X-Ziggs-Execution'], 'ctx1');
        return Response.json({ messageId: 'm1', agreementId: 'work', taskId: null, text: 'Hello', timestamp: ref.ts, sender: { ref: 'ep_customer', kind: 'user' }, receiver: { ref: 'ep_worker', kind: 'agent' } });
      }
      if (String(url).endsWith('/inbox/ack')) { acks.push(...JSON.parse(String(init?.body)).handledDeliveryIds); return Response.json({ ackedUpTo: ref.ts }); }
      assert.fail(`Unexpected room dependency: ${url}`);
    });
    const deps = { creds: { operatorKey: 'op', agentId: 'worker' }, ownAgentId: 'worker', baseUrl: 'http://test', seen: new SeenMessages(20), onMessage: async (_text: string, metadata: Record<string, unknown>) => { handed.push(metadata); }, onResourceEvent: async () => assert.fail('not a resource wake') };
    const first = await pollInboxOnce(deps); await pollInboxOnce(deps);
    assert.equal(first.messagesDelivered, 1); assert.equal(handed.length, 1);
    assert.equal(handed[0].chatId, undefined); assert.equal(handed[0].agreementId, 'work');
    assert.equal((handed[0].executionContext as WorkExecutionContext).contextId, 'ctx1');
    assert.ok(acks.includes('r1')); assert.equal(calls.filter(c => c.endsWith('/messages/m1')).length, 1);
  });
  it('leaves a scoped refusal pending instead of acknowledging unread content', async () => {
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/inbox') && !init?.method) return Response.json(envelope);
      if (String(url).endsWith('/messages/m1')) return Response.json({ message: 'Audience changed' }, { status: 403 });
      assert.fail('Unread work must not be acknowledged');
    });
    const result = await pollInboxOnce({ creds: { operatorKey: 'op', agentId: 'worker' }, ownAgentId: 'worker', baseUrl: 'http://test', seen: new SeenMessages(), onMessage: async () => assert.fail('No wake'), onResourceEvent: async () => assert.fail('No wake') });
    assert.equal(result.failures, 1); assert.equal(result.messagesDelivered, 0); assert.equal(result.acked, false);
  });
  it('uses one visual agreement lane but distinct retained execution lanes', async () => {
    const host = new Agent({ agentId: 'worker', operatorKey: 'key', anthropicKey: 'test', initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } }, inboxCatchUp: false });
    const internal = host as unknown as { eventQueue: { enqueue: (event: unknown, lane: string) => Promise<void> }; sessions: Map<string, {sessionId: string}> };
    const lanes: string[] = []; internal.eventQueue.enqueue = async (_event, lane) => { lanes.push(lane); };
    for (const id of ['ctx1', 'ctx2']) await host.handleMessage('Hello', { messageId: `m-${id}`, agreementId: 'work', sender: { id: 'ep_customer', type: 'user' }, executionContext: context(id) });
    assert.deepEqual(lanes, ['ctx1', 'ctx2'].map(id => laneKeyFor('worker', 'agrn-work', id)));
    assert.equal(internal.sessions.size, 2);
    assert.ok([...internal.sessions.values()].every(s => s.sessionId === 'agrn-work'));
  });
});
