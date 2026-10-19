import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import { runInboxLoop, type InboxLoopHandle } from '../src/platform/inboxLoop.js';
import { SeenMessages } from '../src/platform/SeenMessages.js';

describe('Agent shutdown and the inbox host lease', () => {
  afterEach(() => mock.restoreAll());

  it('a second connect while connected starts no second inbox loop', async () => {
    let reads = 0;
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Response.json({ released: true });
      reads++;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
    });
    const host = new Agent({ agentId: 'agent-1', operatorKey: 'op', anthropicKey: 'test-key',
      telemetryIngest: false, initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } } });
    await host.connectAsync();
    await host.connectAsync();
    assert.equal(host.isConnected(), true);
    await host.disconnect(1000);
    assert.equal(reads, 1, 'one inbox loop reads, however many times connect is called');
    assert.equal(host.isConnected(), false);
  });

  async function activeHost() {
    let finish!: () => void;
    let started!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    const working = new Promise<void>((resolve) => { started = resolve; });
    const order: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        order.push('release'); return Response.json({ released: true });
      }
      if (String(url).endsWith('/inbox/ack')) {
        order.push('ack'); return Response.json({ ackedUpTo: 't1' });
      }
      return Response.json({ asOf: '2026-10-01T00:00:00Z', ackTo: 't1', chats: [],
        proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [],
        deliveries: [{ kind: 'task', resourceId: 'task-1', taskId: 'task-1',
          assigneeId: 'agent-1', ts: '2026-10-01T00:00:00Z' }] });
    });
    const host = new Agent({ agentId: 'agent-1', operatorKey: 'op', anthropicKey: 'test-key',
      initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } }, inboxCatchUp: false });
    const loop = runInboxLoop({ creds: { operatorKey: 'op', agentId: 'agent-1' }, ownAgentId: 'agent-1',
      baseUrl: 'http://test', seen: new SeenMessages(), onMessage: async () => {},
      onResourceEvent: async () => { started(); await work; order.push('finished'); } });
    (host as unknown as { inboxLoop: InboxLoopHandle }).inboxLoop = loop;
    await working;
    return { host, finish, order };
  }

  it('disconnect waits for the pass in flight to acknowledge, then releases the lease', async () => {
    const { host, finish, order } = await activeHost();
    let disconnected = false;
    const disconnecting = host.disconnect(1000).then(() => { disconnected = true; });
    await Promise.resolve();
    assert.equal(disconnected, false);
    assert.deepEqual(order, []);
    finish();
    await disconnecting;
    assert.deepEqual(order, ['finished', 'ack', 'release']);
    assert.equal((await host.drain(1000)).idle, true);
  });

  it('a pass that outlasts the bound does not keep the lease', async () => {
    const { host, finish, order } = await activeHost();
    await host.disconnect(5);
    assert.deepEqual(order, ['release'], 'released while the pass was still running');
    finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ['release', 'finished', 'ack'], 'the late pass still acknowledges and releases nothing twice');
  });
});
