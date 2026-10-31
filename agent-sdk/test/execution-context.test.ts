import { it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import { pollInboxOnce } from '../src/platform/inboxLoop.js';
import { SeenMessages } from '../src/platform/SeenMessages.js';
import { withWorkExecution } from '@ziggs-ai/api-client';
import { InMemoryStore } from '../src/memory/MemoryStore.js';
import { WakeLedger } from '../src/platform/WakeLedger.js';
import type { WorkExecutionContext } from '@ziggs-ai/api-client';

const context = (id: string): WorkExecutionContext => ({ contextId: id, actorId: 'agent', principalId: 'person', agreementId: 'agreement', position: id === 'payer' ? 'payer' : 'provider', addressId: 'room', audienceRevision: 'revision' });
afterEach(() => mock.restoreAll());
it('queues the same message in two isolated sessions, without duplicating either', async () => {
  const host = new Agent({ agentId: 'agent', operatorKey: 'key', anthropicKey: 'test', initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } }, inboxCatchUp: false });
  const internals = host as unknown as { sessions: Map<string, { sessionId: string }>; eventQueue: { enqueue: (event: unknown, lane: string) => Promise<void> } };
  const lanes: string[] = [];
  internals.eventQueue.enqueue = async (_, lane) => { lanes.push(lane); };
  for (const id of ['payer', 'provider', 'payer']) await host.handleMessage('same record', { messageId: 'm', addressId: 'room', sender: { id: 'other', type: 'user' }, receiver: { id: 'agent', type: 'agent' }, receiptId: id, executionContext: context(id) });
  assert.deepEqual(lanes, ['agent:payer', 'agent:provider']);
  assert.deepEqual([...internals.sessions.values()].map(s => s.sessionId), ['room', 'room']);
});
it('reads and handles the same message for each responsibility, acknowledging only both exact ids', async () => {
  const handled: string[] = []; const reads: string[] = []; const acks: Record<string, unknown>[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/inbox')) return Response.json({ deliveries: ['payer', 'provider'].map(id => ({ kind: 'message', eventId: 'e', resourceId: 'm', receiptId: id, executionContext: context(id), addressId: 'room', agreementId: 'agreement', assigneeId: 'agent', ts: '2026-10-29T00:00:00Z', ackTo: 'token' })), ackTo: 'token', tasksAwaitingMe: [], proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [] });
    if (String(url).includes('/messaging/messages/')) {
      reads.push((init?.headers as Record<string, string>)['X-Ziggs-Execution']);
      return assignedMessageResponse([{ messageId: 'm', text: 'hello', addressId: 'room' }], String(url));
    }
    if (String(url).endsWith('/inbox/ack')) { acks.push(JSON.parse(String(init?.body))); return Response.json({}); }
    throw new Error(String(url));
  });
  const result = await pollInboxOnce({ creds: { operatorKey: 'key', agentId: 'agent' }, ownAgentId: 'agent', baseUrl: 'http://test', seen: new SeenMessages(), onMessage: async (_, metadata) => { handled.push(String(metadata.receiptId)); }, onResourceEvent: async () => {} });
  assert.equal(result.acked, true);
  assert.deepEqual(new Set(handled), new Set(['payer', 'provider']));
  assert.deepEqual(new Set(reads), new Set(['payer', 'provider']));
  assert.deepEqual(new Set(acks.flatMap(ack => ack.handledDeliveryIds as string[])), new Set(['payer', 'provider']));
  assert.ok(acks.every(ack => (ack.handledDeliveryIds as string[]).length === 1));
});

it('isolates memory by execution and preserves the context on durable wake records', async () => {
  const host = new Agent({ agentId: 'agent', operatorKey: 'key', anthropicKey: 'test', initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } }, inboxCatchUp: false, memory: new InMemoryStore() });
  const internal = host as unknown as { memoryForWake: (session: { sessionId: string }) => InMemoryStore };
  await withWorkExecution(context('payer'), async () => internal.memoryForWake({ sessionId: 'room' }).put('note', 'payer only'));
  await withWorkExecution(context('provider'), async () => assert.equal(await internal.memoryForWake({ sessionId: 'room' }).get('note'), undefined));
  await withWorkExecution(context('payer'), async () => assert.equal(await internal.memoryForWake({ sessionId: 'room' }).get('note'), 'payer only'));
  const ledger = new WakeLedger(new InMemoryStore());
  ledger.arm({ laneKey: 'agent:payer', sessionId: 'room', firesAt: Date.now(), reason: null, executionContext: context('payer') });
  assert.deepEqual((await ledger.pending())[0].executionContext, context('payer'));
});

it('refreshes authority on every request through a reused MCP transport', async () => {
  const { wrapGatewayFetch } = await import('../src/mcp/createMcpAgent.js');
  const ids: Array<string | null> = [];
  const gateway = wrapGatewayFetch((async (_url: unknown, init?: RequestInit) => {
    ids.push(new Headers(init?.headers).get('X-Ziggs-Execution'));
    return Response.json({});
  }) as typeof fetch);
  for (const id of ['first', 'second']) {
    await withWorkExecution(context(id), () => gateway('http://test', { headers: { 'X-Ziggs-Execution': 'stale' } }));
  }
  await gateway('http://test', { headers: { 'X-Ziggs-Execution': 'stale' } });
  assert.deepEqual(ids, ['first', 'second', null]);
});

it('keeps the checkout relay bound to the execution that opened it', async () => {
  const { doorHeaders } = await import('../src/checkout/boxClient.js');
  const door = { backendUrl: 'http://test', operatorKey: 'key', agentId: 'agent', connectionId: 'con', grantId: 'grant', taskId: 'task', repository: { owner: 'owner', name: 'repo' }, executionContextId: 'original' };
  const headers = await withWorkExecution(context('other'), () => doorHeaders(door, {}));
  assert.equal(headers['x-ziggs-execution'], 'original');
  assert.equal(headers['x-ziggs-lane'], undefined);
});


it('one blocked assignment does not wake or get acknowledged while other work proceeds', async () => {
  const handled: string[] = []; const acks: Array<{ handledDeliveryIds: string[] }> = [];
  const block = { code: 'EXECUTION_ACCESS_REQUIRED', message: 'Needs contribution consent' };
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/inbox')) return Response.json({
      deliveries: [
        { kind: 'artifact', eventId: 'blocked', resourceId: 'private', receiptId: 'blocked', assigneeId: 'agent', executionBlocked: block, ts: '2026-10-29T00:00:00Z' },
        { kind: 'artifact', eventId: 'unreadable', resourceId: 'locked', receiptId: 'unreadable', assigneeId: 'agent', outOfReach: { scopeKind: 'artifact', scopeId: 'locked' }, ts: '2026-10-29T00:00:00Z' },
        { kind: 'artifact', eventId: 'ready', resourceId: 'shared', receiptId: 'ready', assigneeId: 'agent', executionContext: context('ready'), ts: '2026-10-29T00:00:00Z' },
      ], ackTo: 'token', tasksAwaitingMe: [{ taskId: 'blocked-task', executionBlocked: block }],
      proposalsAwaitingMe: [{ agreementId: 'blocked-decision', assignedAgentId: 'agent', executionBlocked: block }], connectionRequestsAwaitingMe: [],
    });
    if (String(url).endsWith('/inbox/ack')) { acks.push(JSON.parse(String(init?.body))); return Response.json({}); }
    throw new Error(String(url));
  });
  const result = await pollInboxOnce({ creds: { operatorKey: 'key', agentId: 'agent' }, ownAgentId: 'agent', baseUrl: 'http://test', seen: new SeenMessages(),
    onMessage: async () => { throw new Error('no message'); },
    onResourceEvent: async e => { handled.push(String(e.resourceId)); },
    onTask: async () => { throw new Error('blocked task must not run'); },
  });
  assert.deepEqual(handled, ['shared']);
  assert.deepEqual(acks.flatMap(a => a.handledDeliveryIds), ['ready']);
  // Blocked work is skipped, not failed: the server keeps it pending without
  // ringing, so it neither holds the watermark nor backs the loop off.
  assert.equal(result.failures, 0);
  assert.equal(result.blocked, 4);
  assert.equal(result.acked, true);
});

it('a handled id the server leaves pending is reported, not retried, and the rest of the pass stands', async () => {
  const acks: Array<{ handledDeliveryIds: string[] }> = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/inbox')) return Response.json({
      deliveries: ['lost', 'kept'].map(id => ({ kind: 'artifact', eventId: id, resourceId: id, receiptId: id, assigneeId: 'agent', ts: '2026-10-29T00:00:00Z' })),
      ackTo: 'token', tasksAwaitingMe: [], proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [],
    });
    if (String(url).endsWith('/inbox/ack')) {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ ackedUpTo: 'token', refusedDeliveryIds: [{ id: 'lost', reason: 'out-of-reach' }] });
    }
    throw new Error(String(url));
  });
  const result = await pollInboxOnce({ creds: { operatorKey: 'key', agentId: 'agent' }, ownAgentId: 'agent', baseUrl: 'http://test', seen: new SeenMessages(),
    onMessage: async () => {}, onResourceEvent: async () => {} });
  assert.equal(result.failures, 0);
  assert.equal(result.acked, true);
  assert.equal(acks.length, 1);
  assert.deepEqual(new Set(acks[0].handledDeliveryIds), new Set(['lost', 'kept']));
});

function assignedMessageResponse(rows: Array<Record<string, unknown>>, url: string): Response {
  const path = new URL(url).pathname.split('/');
  const id = decodeURIComponent(path.at(-1)!);
  const row = rows.find(row => row.messageId === id);
  return row ? Response.json({ addressId: 'room', ...row }) : Response.json({}, { status: 404 });
}
