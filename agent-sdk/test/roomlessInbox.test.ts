import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pollInboxOnce } from '../src/platform/inboxLoop.js';
import { SeenMessages } from '../src/platform/SeenMessages.js';
import { Agent } from '../src/Agent.js';
import { laneKeyFor } from '../src/platform/laneKey.js';
import type { WorkExecutionContext } from '@ziggs-ai/api-client';
import { assertRequiredContext } from '../src/runtime/requiredContext.js';

const context = (id: string): WorkExecutionContext => ({ contextId: id, actorId: 'worker', principalId: 'owner', position: 'provider', agreementId: 'work', taskId: null, addressId: null, audienceIds: ['owner', 'customer'], authorityRevision: 'rev' } as WorkExecutionContext);
const ref = { kind: 'message', resourceId: 'm1', receiptId: 'r1', addressId: null, agreementId: 'work', taskId: null, assigneeId: 'worker', ts: '2026-10-30T10:00:00.000Z', executionContext: context('ctx1') };
const envelope = { asOf: ref.ts, ackTo: ref.ts, deliveries: [ref], chats: [], tasksAwaitingMe: [], proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [] };
describe('roomless message assignments', () => {
  afterEach(() => mock.restoreAll());
  it('does not acknowledge a model-context failure and retries the same responsibility after recovery', async () => {
    const acks: string[] = [];
    let recovered = false;
    let turns = 0;
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/inbox') && !init?.method) return Response.json(envelope);
      if (String(url).endsWith('/messages/m1')) return Response.json({ messageId: 'm1', mandate:{agreementId:'work'},content:{text:'Hello'},requestedAnswers:[],
        taskId: null, text: 'Hello', timestamp: ref.ts, sender: { ref: 'ep_customer', kind: 'user' }, receiver: { ref: 'ep_worker', kind: 'agent' } });
      if (String(url).endsWith('/inbox/ack')) {
        acks.push(...JSON.parse(String(init?.body)).handledDeliveryIds);
        return Response.json({ ackedUpTo: ref.ts });
      }
      assert.fail(`Unexpected request: ${url}`);
    });
    const deps = { creds: { operatorKey: 'op', agentId: 'worker' }, ownAgentId: 'worker', baseUrl: 'http://test',
      seen: new SeenMessages(), onResourceEvent: async () => assert.fail('No resource wake'),
      onMessage: async () => { assertRequiredContext({ unavailable: !recovered }); turns++; } };
    const first = await pollInboxOnce(deps);
    assert.equal(first.acked, false);
    assert.equal(first.failures, 1);
    assert.equal(turns, 0);
    assert.deepEqual(acks, []);
    recovered = true;
    const second = await pollInboxOnce(deps);
    assert.equal(second.failures, 0);
    assert.equal(turns, 1);
    assert.deepEqual(acks, ['r1']);
  });
  it('reads the exact message with execution, hands over once, then acknowledges the responsibility', async () => {
    const calls: string[] = []; const handed: Record<string, unknown>[] = []; const acks: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith('/inbox') && !init?.method) return Response.json(envelope);
      if (String(url).endsWith('/messaging/messages/m1')) {
        assert.equal((init?.headers as Record<string, string>)['X-Ziggs-Execution'], 'ctx1');
        return Response.json({ messageId: 'm1', mandate:{agreementId:'work'},content:{text:'Hello'},requestedAnswers:[], taskId: null, text: 'Hello', timestamp: ref.ts, sender: { ref: 'ep_customer', kind: 'user' }, receiver: { ref: 'ep_worker', kind: 'agent' } });
      }
      if (String(url).endsWith('/inbox/ack')) { acks.push(...JSON.parse(String(init?.body)).handledDeliveryIds); return Response.json({ ackedUpTo: ref.ts }); }
      assert.fail(`Unexpected room dependency: ${url}`);
    });
    const deps = { creds: { operatorKey: 'op', agentId: 'worker' }, ownAgentId: 'worker', baseUrl: 'http://test', seen: new SeenMessages(20), onMessage: async (_text: string, metadata: Record<string, unknown>) => { handed.push(metadata); }, onResourceEvent: async () => assert.fail('not a resource wake') };
    const first = await pollInboxOnce(deps); await pollInboxOnce(deps);
    assert.equal(first.messagesDelivered, 1); assert.equal(handed.length, 1);
    assert.equal(handed[0].addressId, undefined); assert.equal(handed[0].agreementId, 'work'); assert.equal(handed[0].roomless, true);
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
    const internal = host as unknown as { eventQueue: { enqueue: (event: unknown, lane: string) => Promise<void> }; sessions: Map<string, LaneView> };
    const lanes: string[] = []; internal.eventQueue.enqueue = async (_event, lane) => { lanes.push(lane); };
    for (const id of ['ctx1', 'ctx2']) await host.handleMessage('Hello', { messageId: `m-${id}`, agreementId: 'work', sender: { id: 'ep_customer', type: 'user' }, executionContext: context(id), roomless: true });
    assert.deepEqual(lanes, ['ctx1', 'ctx2'].map(id => laneKeyFor('worker', 'agrn-work', id)));
    assert.equal(internal.sessions.size, 2);
    assert.ok([...internal.sessions.values()].every(s => s.sessionId === 'agrn-work' && s.roomlessAgreementId === 'work'));
  });
  it('marks a lane roomless only for a roomless message, never for an agreement lane key', async () => {
    const host = new Agent({ agentId: 'worker', operatorKey: 'key', anthropicKey: 'test', initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } }, inboxCatchUp: false });
    const internal = host as unknown as { eventQueue: { enqueue: (event: unknown, lane: string) => Promise<void> }; sessions: Map<string, LaneView> };
    internal.eventQueue.enqueue = async () => {};
    // A task or claim wake on a hire made with a room still lanes as agrn-<hire>.
    await host.handleResourceEvent({ kind: 'task', resourceId: 'task-1', agreementId: 'hire', ts: ref.ts });
    // So does a message handed over without the inbox's roomless mark.
    await host.handleMessage('Hello', { messageId: 'm-plain', agreementId: 'hire', sender: { id: 'customer', type: 'user' } });
    const lanes = [...internal.sessions.values()];
    assert.ok(lanes.length > 0 && lanes.every(s => s.sessionId === 'agrn-hire' && s.roomlessAgreementId === undefined));
    // A roomless message reaching the same lane marks it.
    await host.handleMessage('Hello', { messageId: 'm-roomless', agreementId: 'hire', sender: { id: 'ep_customer', type: 'user' }, roomless: true });
    assert.equal(internal.sessions.get(laneKeyFor('worker', 'agrn-hire'))?.roomlessAgreementId, 'hire');
  });
  it('leaves a roomless message pending when the host cannot route it', async () => {
    const plainRef = { ...ref, executionContext: undefined };
    const plainEnvelope = { ...envelope, deliveries: [plainRef] };
    for (const broken of ['resolver', 'identity'] as const) {
      const host = new Agent({ agentId: 'worker', operatorKey: 'key', anthropicKey: 'test', initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } }, inboxCatchUp: false,
        ...(broken === 'resolver' ? { sessionResolver: () => null } : {}) });
      if (broken === 'identity') (host as unknown as { _resolveOwnAgentId: () => string | null })._resolveOwnAgentId = () => null;
      const internal = host as unknown as { eventQueue: { enqueue: () => Promise<void> } };
      let enqueued = 0; internal.eventQueue.enqueue = async () => { enqueued++; };
      const acks: string[] = []; let reads = 0;
      mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/inbox') && !init?.method) return Response.json(plainEnvelope);
        if (String(url).endsWith('/messaging/messages/m1')) { reads++; return Response.json({ messageId: 'm1', mandate:{agreementId:'work'},content:{text:'Hello'},requestedAnswers:[], taskId: null, text: 'Hello', timestamp: ref.ts, sender: { ref: 'ep_customer', kind: 'user' }, receiver: { ref: 'ep_worker', kind: 'agent' } }); }
        if (String(url).endsWith('/inbox/ack')) { acks.push(...(JSON.parse(String(init?.body)).handledDeliveryIds ?? [])); return Response.json({ ackedUpTo: ref.ts }); }
        return Response.json({});
      });
      // The host's own record of what it handled, as the agent wires it.
      const seen = (host as unknown as { seenMessages: SeenMessages }).seenMessages;
      const deps = { creds: { operatorKey: 'op', agentId: 'worker' }, ownAgentId: 'worker', baseUrl: 'http://test', seen, onMessage: (text: string, metadata: Record<string, unknown>) => host.handleMessage(text, metadata), onResourceEvent: async () => assert.fail('not a resource wake') };
      for (let pass = 0; pass < 2; pass++) {
        const result = await pollInboxOnce(deps);
        assert.equal(result.failures, 1, broken);
        assert.equal(result.messagesDelivered, 0, broken);
        assert.equal(result.acked, false, broken);
      }
      // Never remembered as handled, so each pass offers it again.
      assert.equal(reads, 2, broken); assert.equal(seen.has('r1'), false, broken);
      assert.deepEqual(acks, [], broken); assert.equal(enqueued, 0, broken);
      mock.restoreAll();
    }
  });
});

type LaneView = { sessionId: string; roomlessAgreementId?: string };

it('normalizes an exact direct request and routes it by its action without a group', async t => {
  const directContext = { ...context('direct-context'), agreementId: null, position: 'participant', action: { kind: 'message', id: 'm1', slot:'answer',requestId:'reply' } };
  const host = new Agent({ agentId: 'worker', operatorKey: 'key', anthropicKey: 'test', initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } }, inboxCatchUp: false });
  const internal = host as unknown as { eventQueue: { enqueue: (event: unknown, lane: string) => Promise<void> } };
  const events: Array<{ event: unknown; lane: string }> = [];
  internal.eventQueue.enqueue = async (event, lane) => { events.push({ event, lane }); };
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/inbox') && !init?.method) return Response.json({ ...envelope, deliveries: [{ ...ref, agreementId: null, executionContext: directContext }] });
    if (String(url).endsWith('/messaging/messages/m1')) return Response.json({ messageId: 'm1', content:{text:'Question'},requestedAnswers:[],mandate:null, timestamp: ref.ts, sender: { ref: 'ep_sender', kind: 'user' }, readers: [], recipients: [], assignee: { ref: 'ep_worker', kind: 'agent' } });
    if (String(url).endsWith('/inbox/ack')) return Response.json({ ackedUpTo: ref.ts });
    assert.fail(`Unexpected request ${url}`);
  });
  const result = await pollInboxOnce({ creds: { operatorKey: 'op', agentId: 'worker' }, ownAgentId: 'worker', baseUrl: 'http://test', seen: new SeenMessages(),
    onMessage: (text, metadata) => host.handleMessage(text, metadata), onResourceEvent: async () => assert.fail('No task wake') });
  assert.equal(result.failures, 0);
  assert.equal(result.messagesDelivered, 1);
  assert.equal(events[0].lane, laneKeyFor('worker', 'msgn-m1', 'direct-context'));
  assert.equal((events[0].event as { senderId: string }).senderId, 'ep_sender');
});
