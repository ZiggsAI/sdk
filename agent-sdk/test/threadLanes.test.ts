/**
 * A thread keeps one lane, and threads run side by side.
 *
 * The server prepares a fresh execution for every request message, so a lane
 * named after the execution forgot everything between two messages of the same
 * conversation. A message wake now runs on its thread's lane, named from the
 * thread, the work and the readers; the inbox runs different threads at once
 * and keeps one thread in order.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withWorkExecution, type WorkExecutionContext } from '@ziggs-ai/api-client';
import { Agent } from '../src/Agent.js';
import { laneKeyFor, runInLane, threadLaneId } from '../src/platform/laneKey.js';
import { EventQueue } from '../src/platform/EventQueue.js';
import { InMemoryStore, type MemoryStore } from '../src/memory/MemoryStore.js';
import { inboxConcurrency, pollInboxOnce, runInboxLoop, type InboxLoopDeps } from '../src/platform/inboxLoop.js';
import { SeenMessages } from '../src/platform/SeenMessages.js';
import type { StateTimers } from '../src/platform/StateTimers.js';
import type { WakeLedger } from '../src/platform/WakeLedger.js';
import { message } from './fixtures/message.js';

const exec = (contextId: string, over: Partial<WorkExecutionContext> = {}): WorkExecutionContext => ({
  contextId, actorId: 'agent', principalId: 'owner', agreementId: null, taskId: null, position: 'participant',
  action: { kind: 'message', id: `m-${contextId}` }, audienceIds: ['owner', 'alice'], audienceRevision: 'r1', ...over,
}) as WorkExecutionContext;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `work`, or a failure naming `why` once `ms` has passed. The timer never outlives the answer. */
async function within<T>(work: Promise<T>, ms: number, why: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(why)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

describe('thread lane key', () => {
  it('gives one lane to the messages of a thread under the same work and readers', () => {
    const first = laneKeyFor('agent', 'thr-root', { execution: exec('c1'), threadRootId: 'root' });
    const later = laneKeyFor('agent', 'thr-root', { execution: exec('c2', { audienceIds: ['alice', 'owner', 'alice'] }), threadRootId: 'root' });
    assert.equal(later, first, 'a new execution per message, the same lane');
    assert.match(first, /^agent:thr-[0-9a-f]{32}$/);
  });

  it('gives a new lane when a reader joins or leaves, or the work or thread changes', () => {
    const base = laneKeyFor('agent', 's', { execution: exec('c1'), threadRootId: 'root' });
    const changes: Array<[string, Parameters<typeof laneKeyFor>[2]]> = [
      ['a reader joins', { execution: exec('c2', { audienceIds: ['owner', 'alice', 'bob'] }), threadRootId: 'root' }],
      ['a reader leaves', { execution: exec('c2', { audienceIds: ['owner'] }), threadRootId: 'root' }],
      ['another agreement', { execution: exec('c2', { agreementId: 'agr-1' }), threadRootId: 'root' }],
      ['a task', { execution: exec('c2', { taskId: 'task-1' }), threadRootId: 'root' }],
      ['another thread', { execution: exec('c2'), threadRootId: 'other-root' }],
    ];
    for (const [what, wake] of changes) assert.notEqual(laneKeyFor('agent', 's', wake), base, what);
  });

  it('keeps task wakes, threadless messages and plain sessions on their old lanes', () => {
    const task = exec('c1', { action: { kind: 'task', id: 'task-1' } });
    assert.equal(laneKeyFor('agent', 'agrn-a', { execution: task, threadRootId: 'root' }), 'agent:c1');
    assert.equal(threadLaneId(task, 'root'), undefined);
    assert.equal(laneKeyFor('agent', 'msgn-m', { execution: exec('c1') }), 'agent:c1');
    assert.equal(laneKeyFor('agent', 'room'), 'agent:room');
  });

  it('names the running lane for a call that holds only a session id', async () => {
    const lane = laneKeyFor('agent', 's', { execution: exec('c1'), threadRootId: 'root' });
    await withWorkExecution(exec('c9'), () => runInLane('agent', lane, () => {
      assert.equal(laneKeyFor('agent', 's'), lane);
      // Another agent's lane is never borrowed.
      assert.equal(laneKeyFor('other-agent', 's'), 'other-agent:c9');
    }));
  });
});

type HostInternals = {
  eventQueue: { enqueue: (event: unknown, lane: string, execution?: WorkExecutionContext) => Promise<void> };
  sessions: Map<string, { sessionId: string; ownAgentId: string; executionContext?: WorkExecutionContext; thread?: { rootMessageId: string; laneId: string } }>;
  memoryForWake: (session: { sessionId: string; thread?: { laneId: string } }) => MemoryStore;
  _processEvent: (event: unknown, lane: string, execution?: WorkExecutionContext) => Promise<void>;
  stateTimers: StateTimers;
  wakeLedger: WakeLedger;
  armOwnWake(sessionId: string, at: number, reason: string | null): unknown;
  restoreWakes(): Promise<void>;
};

const host = (memory: MemoryStore = new InMemoryStore()) => {
  const agent = new Agent({ agentId: 'agent', operatorKey: 'key', anthropicKey: 'test', initial: 'idle',
    states: { idle: { kind: 'parked', transitions: [] } }, inboxCatchUp: false, memory });
  return { agent, internals: agent as unknown as HostInternals };
};

const send = (agent: Agent, id: string, execution: WorkExecutionContext, threadRootId = 'root') =>
  agent.handleMessage(`text ${id}`, { messageId: id, receiptId: `r-${id}`, threadRootId, roomless: true,
    sender: { id: 'alice', type: 'user' }, executionContext: execution });

describe('a thread on one lane', () => {
  it('routes a thread to one lane and session, each message under its own execution', async () => {
    const { agent, internals } = host();
    const queued: Array<{ lane: string; contextId?: string }> = [];
    internals.eventQueue.enqueue = async (_event, lane, execution) => { queued.push({ lane, contextId: execution?.contextId }); };
    await send(agent, 'm1', exec('c1'));
    await send(agent, 'm2', exec('c2'));
    await send(agent, 'm3', exec('c3', { audienceIds: ['owner', 'alice', 'bob'] }));
    assert.equal(queued[1].lane, queued[0].lane, 'same thread, same readers');
    assert.notEqual(queued[2].lane, queued[0].lane, 'a new reader starts a new lane');
    assert.deepEqual(queued.map(q => q.contextId), ['c1', 'c2', 'c3']);
    const session = internals.sessions.get(queued[0].lane)!;
    assert.equal(session.sessionId, 'thr-root', 'the default resolver names the thread before the message');
    assert.deepEqual(session.thread, { rootMessageId: 'root', laneId: threadLaneId(exec('c1'), 'root') });
  });

  it('keeps notes for the thread, and a lane with other readers does not see them', async () => {
    const { internals } = host();
    const thread = { laneId: threadLaneId(exec('c1'), 'root')! };
    await withWorkExecution(exec('c1'), () => internals.memoryForWake({ sessionId: 'thr-root', thread }).put('note', 'kept'));
    await withWorkExecution(exec('c2'), async () =>
      assert.equal(await internals.memoryForWake({ sessionId: 'thr-root', thread }).get('note'), 'kept'));
    const wider = exec('c3', { audienceIds: ['owner', 'alice', 'bob'] });
    await withWorkExecution(wider, async () =>
      assert.equal(await internals.memoryForWake({ sessionId: 'thr-root', thread: { laneId: threadLaneId(wider, 'root')! } }).get('note'), undefined));
  });

  it('runs a thread one message at a time, in order, each under its own execution', async () => {
    const { agent, internals } = host();
    const runs: string[] = [];
    let active = 0;
    let peak = 0;
    internals._processEvent = async (event, _lane, execution) => {
      active++; peak = Math.max(peak, active);
      runs.push(`${(event as { messageId: string }).messageId}@${execution?.contextId}`);
      await sleep(10);
      active--;
    };
    await Promise.all([send(agent, 'm1', exec('c1')), send(agent, 'm2', exec('c2')), send(agent, 'm3', exec('c3'))]);
    // m2 and m3 queue behind m1 together, and still run as two wakes: two executions.
    assert.deepEqual(runs, ['m1@c1', 'm2@c2', 'm3@c3']);
    assert.equal(peak, 1);
  });

  it('re-arms a check-back from a thread lane on the same lane after a restart', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const store = new InMemoryStore();
    const before = host(store).internals;
    const execution = exec('c1');
    const lane = laneKeyFor('agent', 'thr-root', { execution, threadRootId: 'root' });
    before.sessions.set(lane, { sessionId: 'thr-root', ownAgentId: 'agent', executionContext: execution,
      thread: { rootMessageId: 'root', laneId: threadLaneId(execution, 'root')! } });
    await withWorkExecution(execution, () => runInLane('agent', lane, () => before.armOwnWake('thr-root', 600_000, 'check back')));
    assert.equal(before.stateTimers.peek(lane)?.firesAt, 600_000, 'armed on the running thread lane');
    await before.wakeLedger.flushed();
    before.stateTimers.clearAll();

    const after = host(store).internals;
    await after.restoreWakes();
    assert.equal(after.stateTimers.peek(lane)?.firesAt, 600_000);
    assert.equal(after.sessions.get(lane)?.thread?.rootMessageId, 'root');
    after.stateTimers.clearAll();
    t.mock.timers.reset();
  });
});

describe('EventQueue keeps executions apart', () => {
  it('never merges two executions into one dispatch; a timer joins the next one', async () => {
    const calls: Array<{ events: unknown[]; contextId?: string }> = [];
    const queue = new EventQueue(async (event, _lane, execution) => {
      const frame = event as { type?: string; events?: unknown[] };
      calls.push({ events: frame.type === 'batch' ? frame.events! : [event], contextId: execution?.contextId });
      await sleep(5);
    });
    await Promise.all([
      queue.enqueue({ n: 0 }, 'lane', exec('c1')),
      queue.enqueue({ n: 1 }, 'lane', exec('c2')),
      queue.enqueue({ n: 'timer' }, 'lane'),
      queue.enqueue({ n: 3 }, 'lane', exec('c2')),
      queue.enqueue({ n: 4 }, 'lane', exec('c3')),
    ]);
    assert.deepEqual(calls.map(c => [c.contextId, (c.events as Array<{ n: unknown }>).map(e => e.n)]), [
      ['c1', [0]],
      ['c2', [1, 'timer', 3]],
      ['c3', [4]],
    ]);
  });
});

const T = (n: number) => `2026-11-04T00:00:0${n}.000Z`;
const row = (id: string, ts: string) => ({ kind: 'message', action: { kind: 'message', id }, resourceId: id, receiptId: `r-${id}`,
  addressId: null, agreementId: null, taskId: null, assigneeId: 'agent', ts });

/** One fake server: the inbox lists `rows()`, each read answers with the message's thread. */
function server(opts: { rows: () => unknown[]; roots?: Record<string, string>; readDelay?: (id: string) => Promise<void> | undefined; onGet?: (url: string) => Promise<void> | void }) {
  const acks: string[] = [];
  const fetch = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if ((init?.method ?? 'GET') === 'DELETE') return Response.json({ released: true });
    if (u.endsWith('/execution/prepare')) {
      const action = JSON.parse(String(init?.body)) as { kind: 'message'; id: string };
      return Response.json(exec(`x-${action.id}`, { action }));
    }
    if (u.includes('/messaging/messages/')) {
      const id = decodeURIComponent(new URL(u).pathname.split('/').at(-1)!);
      await opts.readDelay?.(id);
      return Response.json(message(id, `text ${id}`, { rootMessageId: opts.roots?.[id] ?? id } as never));
    }
    if (u.endsWith('/inbox/ack')) {
      acks.push(...(JSON.parse(String(init?.body)).handledDeliveryIds as string[]));
      return Response.json({ ackedUpTo: 't' });
    }
    if (new URL(u).pathname === '/inbox') {
      await opts.onGet?.(u);
      return Response.json({ asOf: 't', ackTo: 't', deliveries: opts.rows(), chats: [], tasksAwaitingMe: [],
        proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [] });
    }
    throw new Error(`unexpected ${u}`);
  };
  return { fetch, acks };
}

const deps = (over: Partial<InboxLoopDeps>): InboxLoopDeps => ({
  creds: { operatorKey: 'key', agentId: 'agent' }, ownAgentId: 'agent', baseUrl: 'http://test',
  seen: new SeenMessages(), onMessage: async () => {}, onResourceEvent: async () => {}, ...over,
});

describe('the inbox runs threads side by side', () => {
  it('runs different threads at once, oldest first, never more than the bound', async (t) => {
    const fake = server({ rows: () => [row('c', T(3)), row('a', T(1)), row('b', T(2))] });
    t.mock.method(globalThis, 'fetch', fake.fetch);
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    let bothRunning!: () => void;
    const overlap = new Promise<void>((resolve) => { bothRunning = resolve; });
    const pass = pollInboxOnce(deps({
      concurrency: 2,
      onMessage: async (_text, metadata) => {
        started.push(String(metadata.messageId));
        active++; peak = Math.max(peak, active);
        if (active === 2) bothRunning();
        // The first wake finishes only once a second one is running beside it.
        await overlap;
        active--;
      },
    }));
    const result = await within(pass, 2_000, 'the first wake held up the second');
    assert.equal(peak, 2);
    assert.deepEqual(started, ['a', 'b', 'c']);
    assert.equal(result.messagesDelivered, 3);
    assert.deepEqual(new Set(fake.acks), new Set(['r-a', 'r-b', 'r-c']));
  });

  it('hands a thread over in the order it was sent, even when the older read is slower', async (t) => {
    const fake = server({ rows: () => [row('m2', T(2)), row('m1', T(1))], roots: { m1: 'm1', m2: 'm1' },
      readDelay: (id) => (id === 'm1' ? sleep(30) : undefined) });
    t.mock.method(globalThis, 'fetch', fake.fetch);
    const handed: Array<[unknown, unknown]> = [];
    await pollInboxOnce(deps({ onMessage: async (_text, metadata) => { handed.push([metadata.messageId, metadata.threadRootId]); } }));
    assert.deepEqual(handed, [['m1', 'm1'], ['m2', 'm1']]);
  });

  it('keeps one thread in order on its lane while another thread runs beside it', async (t) => {
    const fake = server({ rows: () => [row('a1', T(1)), row('a2', T(2)), row('b1', T(3))], roots: { a2: 'a1' } });
    t.mock.method(globalThis, 'fetch', fake.fetch);
    const { agent, internals } = host();
    const log: string[] = [];
    const lanes = new Map<string, string>();
    internals._processEvent = async (event, lane) => {
      const id = (event as { messageId: string }).messageId;
      lanes.set(id, lane);
      log.push(`start ${id}`);
      await sleep(20);
      log.push(`end ${id}`);
    };
    await pollInboxOnce(deps({ onMessage: (text, metadata) => agent.handleMessage(text, metadata) }));
    assert.equal(lanes.get('a1'), lanes.get('a2'));
    assert.notEqual(lanes.get('b1'), lanes.get('a1'));
    assert.ok(log.indexOf('start a2') > log.indexOf('end a1'), `a thread runs in order: ${log.join(', ')}`);
    assert.ok(log.indexOf('start b1') < log.indexOf('end a1'), `another thread does not wait: ${log.join(', ')}`);
  });

  it('never hands a running row over twice, and waits instead of re-reading it', async (t) => {
    let gets = 0;
    let handled = false;
    const fake = server({
      rows: () => (handled ? [] : [row('m1', T(1))]),
      onGet: async (url) => { gets++; if (handled && url.includes('wait=')) await sleep(20); },
    });
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      const response = await fake.fetch(url, init);
      if (fake.acks.includes('r-m1')) handled = true;
      return response;
    });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let running!: () => void;
    const started = new Promise<void>((resolve) => { running = resolve; });
    const loop = runInboxLoop(deps({ onMessage: async () => { calls++; running(); await gate; } }), { waitSeconds: 1 });
    await started;
    await sleep(150);
    assert.equal(calls, 1, 'the row is listed again while its wake runs, and is not handed over again');
    assert.equal(gets, 2, 'one read starts the wake, one finds it running; then the loop waits');
    assert.deepEqual(fake.acks, [], 'nothing is acknowledged before the wake finishes');
    release();
    for (let i = 0; i < 100 && !fake.acks.includes('r-m1'); i++) await sleep(5);
    assert.deepEqual(fake.acks, ['r-m1']);
    await loop.stop();
    assert.equal(calls, 1);
  });

  it('takes up a new thread while another wake is still running', async (t) => {
    let second = false;
    // Like the server: a row stays listed until it is acknowledged.
    const fake = server({
      rows: () => (second ? [row('m1', T(1)), row('m2', T(2))] : [row('m1', T(1))])
        .filter((r) => !fake.acks.includes(r.receiptId)),
      // A held read with nothing listed waits, as the server's long poll does.
      onGet: async (url) => { if (url.includes('wait=') && fake.acks.length >= 2) await sleep(20); },
    });
    t.mock.method(globalThis, 'fetch', fake.fetch);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstRunning!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstRunning = resolve; });
    let secondRunning!: () => void;
    const secondStarted = new Promise<void>((resolve) => { secondRunning = resolve; });
    const loop = runInboxLoop(deps({
      onMessage: async (_text, metadata) => {
        if (metadata.messageId === 'm1') { firstRunning(); await gate; } else secondRunning();
      },
    }), { waitSeconds: 110, busyRecheckMs: 20 });
    await firstStarted;
    second = true;
    await within(secondStarted, 2_000, 'the new thread waited for the running wake');
    release();
    for (let i = 0; i < 100 && fake.acks.length < 2; i++) await sleep(5);
    assert.deepEqual(new Set(fake.acks), new Set(['r-m1', 'r-m2']));
    await loop.stop();
  });

  it('takes the bound from the option, then ZIGGS_AGENT_INBOX_CONCURRENCY, then four', () => {
    const saved = process.env.ZIGGS_AGENT_INBOX_CONCURRENCY;
    try {
      delete process.env.ZIGGS_AGENT_INBOX_CONCURRENCY;
      assert.equal(inboxConcurrency(), 4);
      process.env.ZIGGS_AGENT_INBOX_CONCURRENCY = '7';
      assert.equal(inboxConcurrency(), 7);
      assert.equal(inboxConcurrency(2), 2);
      assert.equal(inboxConcurrency(0), 1);
      process.env.ZIGGS_AGENT_INBOX_CONCURRENCY = 'many';
      assert.equal(inboxConcurrency(), 4);
    } finally {
      if (saved === undefined) delete process.env.ZIGGS_AGENT_INBOX_CONCURRENCY;
      else process.env.ZIGGS_AGENT_INBOX_CONCURRENCY = saved;
    }
  });
});
