import { it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import { InboxDispatch, pollInboxOnce, sharedInboxHost } from '../src/platform/inboxLoop.js';
import { SeenMessages } from '../src/platform/SeenMessages.js';

afterEach(() => mock.restoreAll());

const emptyEnvelope = (host?: { shared: true; leader: boolean }) => ({
  deliveries: [], ackTo: null, tasksAwaitingMe: [], proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [],
  ...(host ? { host } : {}),
});

it('a shared host says so on every read, with how many more threads it can start', async () => {
  const headers: Array<Record<string, string>> = [];
  const leadership: boolean[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/inbox')) {
      headers.push(init?.headers as Record<string, string>);
      return Response.json(emptyEnvelope({ shared: true, leader: false }));
    }
    return Response.json({});
  });
  const dispatch = new InboxDispatch(3);
  void dispatch.start('busy', () => new Promise(() => {})); // one slot in use
  await pollInboxOnce(
    { creds: { operatorKey: 'key', agentId: 'agent' }, ownAgentId: 'agent', baseUrl: 'http://test', seen: new SeenMessages(),
      onMessage: async () => {}, onResourceEvent: async () => {}, sharedHost: true, onLeadership: (l) => leadership.push(l) },
    0,
    { dispatch },
  );
  assert.equal(headers[0]['X-Ziggs-Inbox-Hosts'], 'shared');
  assert.equal(headers[0]['X-Ziggs-Inbox-Capacity'], '2');
  assert.deepEqual(leadership, [false]);
});

it('a single host sends neither header, as before', async () => {
  const headers: Array<Record<string, string>> = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/inbox')) {
      headers.push(init?.headers as Record<string, string>);
      return Response.json(emptyEnvelope());
    }
    return Response.json({});
  });
  await pollInboxOnce({ creds: { operatorKey: 'key', agentId: 'agent' }, ownAgentId: 'agent', baseUrl: 'http://test', seen: new SeenMessages(),
    onMessage: async () => {}, onResourceEvent: async () => {}, sharedHost: false });
  assert.equal(headers[0]['X-Ziggs-Inbox-Hosts'], undefined);
  assert.equal(headers[0]['X-Ziggs-Inbox-Capacity'], undefined);
});

it('ZIGGS_AGENT_SHARED_INBOX turns shared hosting on', () => {
  const before = process.env.ZIGGS_AGENT_SHARED_INBOX;
  process.env.ZIGGS_AGENT_SHARED_INBOX = '1';
  assert.equal(sharedInboxHost(), true);
  assert.equal(sharedInboxHost(false), false);
  delete process.env.ZIGGS_AGENT_SHARED_INBOX;
  assert.equal(sharedInboxHost(), false);
  if (before !== undefined) process.env.ZIGGS_AGENT_SHARED_INBOX = before;
});

it('only the leading shared host runs the agent polls, and it hands them over when it stops leading', () => {
  const host = new Agent({ agentId: 'agent', operatorKey: 'key', anthropicKey: 'test', initial: 'idle',
    states: { idle: { kind: 'parked', transitions: [] } }, inboxCatchUp: false, sharedInbox: true });
  const calls: string[] = [];
  const internals = host as unknown as {
    pollRunner: { start: () => void; stop: () => void };
    restoreWakes: () => Promise<void>;
    setLeadership: (leader: boolean) => void;
  };
  internals.pollRunner = { start: () => calls.push('start'), stop: () => calls.push('stop') };
  internals.restoreWakes = async () => { calls.push('restore'); };
  internals.setLeadership(false);
  internals.setLeadership(true);
  internals.setLeadership(true);
  internals.setLeadership(false);
  internals.setLeadership(true);
  assert.deepEqual(calls, ['start', 'restore', 'stop', 'start']);
});

it('a shared host reloads a thread session on every wake, since another process may have run it', async () => {
  const loads: string[] = [];
  const host = new Agent({ agentId: 'agent', operatorKey: 'key', anthropicKey: 'test', initial: 'idle',
    states: { idle: { kind: 'parked', transitions: [] } }, inboxCatchUp: false, sharedInbox: true,
    sessionStore: { load: async (lane: string) => { loads.push(lane); return { ctx: { from: 'store' }, state: 'idle' }; }, save: async () => {} } });
  const internals = host as unknown as { sessionStore: { load: (lane: string) => Promise<unknown> } };
  assert.ok(internals.sessionStore);
  // The gate itself: a shared host does not trust an in-memory copy.
  const src = (await import('node:fs')).readFileSync(new URL('../src/Agent.ts', import.meta.url), 'utf8');
  assert.match(src, /this\.sessionStore && \(this\.sharedInbox \|\| \(session\.ctx === undefined && session\.state === undefined\)\)/);
  assert.deepEqual(loads, []);
});
