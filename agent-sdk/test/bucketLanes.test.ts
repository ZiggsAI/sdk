/** Executions own lanes and retained state; bucket pointers are optional view metadata. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withWorkExecution, type WorkExecutionContext } from '@ziggs-ai/api-client';
import { Agent } from '../src/Agent.js';
import { bucketLaneId, laneKeyFor, runInLane, type LaneBucket } from '../src/platform/laneKey.js';
import { EventQueue } from '../src/platform/EventQueue.js';
import { InMemoryStore, partitionMemoryStore, type MemoryStore } from '../src/memory/MemoryStore.js';
import { inboxConcurrency, pollInboxOnce, runInboxLoop, type InboxLoopDeps } from '../src/platform/inboxLoop.js';
import { SeenMessages } from '../src/platform/SeenMessages.js';
import type { StateTimers } from '../src/platform/StateTimers.js';
import type { WakeLedger } from '../src/platform/WakeLedger.js';
import { message } from './fixtures/message.js';
import { bucketBlock } from '../src/brain/claudeCognition.js';

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

const b1: LaneBucket = { bucketId: 'b1', revision: 0 };

describe('bucket lane key', () => {
  it('keeps distinct executions isolated even inside the same bucket', () => {
    const first = laneKeyFor('agent', 'bkt-b1', { execution: exec('c1'), bucket: b1 });
    const later = laneKeyFor('agent', 'bkt-b1', {
      execution: exec('c2', { audienceIds: ['alice'], agreementId: 'agr-1', taskId: 'task-1' }),
      bucket: { ...b1 },
    });
    assert.notEqual(later, first);
    assert.equal(first, 'agent:c1');
    assert.equal(later, 'agent:c2');
  });

  it('keeps the same execution lane when a view moves or changes revision', () => {
    const base = laneKeyFor('agent', 's', { execution: exec('c1'), bucket: b1 });
    assert.equal(laneKeyFor('agent', 's', { execution: exec('c1'), bucket: { bucketId: 'b1', revision: 1 } }), base);
    assert.equal(laneKeyFor('agent', 's', { execution: exec('c1'), bucket: { bucketId: 'b2', revision: 0 } }), base);
  });

  it('keeps task and message executions independent of their view', () => {
    const task = exec('c1', { action: { kind: 'task', id: 'task-1' } });
    assert.equal(laneKeyFor('agent', 'agrn-a', { execution: task, bucket: b1 }), 'agent:c1');
    assert.notEqual(laneKeyFor('agent', 'agrn-a', { execution: task, bucket: b1 }), laneKeyFor('agent', 'bkt-b1', { execution: exec('c2'), bucket: b1 }));
  });

  it('keeps wakes in no bucket, agreement wakes and plain sessions on their old lanes', () => {
    const task = exec('c1', { action: { kind: 'task', id: 'task-1' } });
    assert.equal(laneKeyFor('agent', 'agrn-a', { execution: task }), 'agent:c1');
    const agreement = exec('c1', { action: { kind: 'agreement', id: 'agr-1' } } as never);
    assert.equal(bucketLaneId(agreement, b1), undefined);
    assert.equal(laneKeyFor('agent', 'msgn-m', { execution: exec('c1') }), 'agent:c1');
    assert.equal(laneKeyFor('agent', 'room'), 'agent:room');
  });

  it('names the running lane for a call that holds only a session id', async () => {
    const lane = laneKeyFor('agent', 's', { execution: exec('c1'), bucket: b1 });
    await withWorkExecution(exec('c9'), () => runInLane('agent', lane, () => {
      assert.equal(laneKeyFor('agent', 's'), lane);
      // Another agent's lane is never borrowed.
      assert.equal(laneKeyFor('other-agent', 's'), 'other-agent:c9');
    }));
  });
});

type HostInternals = {
  eventQueue: { enqueue: (event: unknown, lane: string, execution?: WorkExecutionContext) => Promise<void> };
  sessions: Map<string, { sessionId: string; ownAgentId: string; executionContext?: WorkExecutionContext; bucket?: LaneBucket }>;
  memoryForWake: (session: { sessionId: string; bucket?: LaneBucket }) => MemoryStore;
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

const send = (agent: Agent, id: string, execution: WorkExecutionContext, bucket: LaneBucket = b1) =>
  agent.handleMessage(`text ${id}`, { messageId: id, receiptId: `r-${id}`, bucket, roomless: true,
    sender: { id: 'alice', type: 'user' }, executionContext: execution });

describe('execution lanes with optional bucket views', () => {
  it('routes each execution to its own lane, retaining bucket metadata only for display', async () => {
    const { agent, internals } = host();
    const queued: Array<{ lane: string; contextId?: string }> = [];
    internals.eventQueue.enqueue = async (_event, lane, execution) => { queued.push({ lane, contextId: execution?.contextId }); };
    await send(agent, 'm1', exec('c1'));
    await send(agent, 'm2', exec('c2', { audienceIds: ['owner'] }));
    await send(agent, 'm3', exec('c3'), { bucketId: 'b1', revision: 1 });
    assert.notEqual(queued[1].lane, queued[0].lane, 'the same view cannot merge distinct work');
    assert.notEqual(queued[2].lane, queued[0].lane, 'distinct work remains isolated across revisions');
    assert.deepEqual(queued.map(q => q.contextId), ['c1', 'c2', 'c3']);
    const session = internals.sessions.get(queued[0].lane)!;
    assert.equal(session.sessionId, 'msgn-m1', 'the default resolver names the underlying message');
    assert.deepEqual(session.bucket, b1);
  });

  it('isolates retained notes by execution and preserves them across view changes', async () => {
    const { internals } = host();
    await withWorkExecution(exec('c1'), () => internals.memoryForWake({ sessionId: 'bkt-b1', bucket: b1 }).put('note', 'kept'));
    await withWorkExecution(exec('c2'), async () =>
      assert.equal(await internals.memoryForWake({ sessionId: 'bkt-b1', bucket: b1 }).get('note'), undefined));
    await withWorkExecution(exec('c1'), async () =>
      assert.equal(await internals.memoryForWake({ sessionId: 'another-view', bucket: { bucketId: 'b2', revision: 3 } }).get('note'), 'kept'));
    await withWorkExecution(exec('c3'), async () =>
      assert.equal(await internals.memoryForWake({ sessionId: 'bkt-b1', bucket: { bucketId: 'b1', revision: 1 } }).get('note'), undefined));
  });

  it('allows independent executions to run concurrently within one view', async () => {
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
    // Each execution runs independently, even when all messages share a view.
    assert.deepEqual(runs, ['m1@c1', 'm2@c2', 'm3@c3']);
    assert.ok(peak > 1);
  });

  it('moves a saved legacy bucket timer to its execution without importing bucket memory', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const store = new InMemoryStore();
    const before = host(store).internals;
    const execution = exec('legacy-context');
    const oldLane = 'agent:bkt-b1-r0';
    await partitionMemoryStore(store, 'bucket:b1-r0').put('note', 'old shared bucket memory');
    before.wakeLedger.arm({ wakeId: 'legacy-wake', laneKey: oldLane, sessionId: 'bkt-b1',
      firesAt: 600_000, reason: 'check back', executionContext: execution, bucket: b1 });
    await before.wakeLedger.flushed();
    const after = host(store).internals;
    await after.restoreWakes();
    assert.equal(after.stateTimers.peek(oldLane), null);
    assert.equal(after.stateTimers.peek('agent:legacy-context')?.firesAt, 600_000);
    assert.deepEqual((await after.wakeLedger.pending()).map(w => w.laneKey), ['agent:legacy-context']);
    assert.deepEqual(after.sessions.get('agent:legacy-context')?.executionContext, execution);
    await withWorkExecution(execution, async () =>
      assert.equal(await after.memoryForWake({ sessionId: 'bkt-b1', bucket: b1 }).get('note'), undefined));
    after.stateTimers.clearAll();
    t.mock.timers.reset();
  });

  it('re-arms an execution check-back after a restart', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const store = new InMemoryStore();
    const before = host(store).internals;
    const execution = exec('c1');
    const lane = laneKeyFor('agent', 'bkt-b1', { execution, bucket: b1 });
    before.sessions.set(lane, { sessionId: 'bkt-b1', ownAgentId: 'agent', executionContext: execution, bucket: b1 });
    await withWorkExecution(execution, () => runInLane('agent', lane, () => before.armOwnWake('bkt-b1', 600_000, 'check back')));
    assert.equal(before.stateTimers.peek(lane)?.firesAt, 600_000, 'armed on the running execution lane');
    await before.wakeLedger.flushed();
    before.stateTimers.clearAll();

    const after = host(store).internals;
    await after.restoreWakes();
    assert.equal(after.stateTimers.peek(lane)?.firesAt, 600_000);
    assert.deepEqual(after.sessions.get(lane)?.bucket, b1);
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

/**
 * One fake server: the inbox lists `rows()`, each with the bucket the server
 * worked out for it from `buckets` (each message its own bucket when not
 * listed; none when listed as null).
 */
function server(opts: { rows: () => unknown[]; buckets?: Record<string, string | null>; readDelay?: (id: string) => Promise<void> | undefined; onGet?: (url: string) => Promise<void> | void }) {
  const acks: string[] = [];
  const asked: string[] = [];
  const bucketOf = (id: string) => {
    const bucketId = opts.buckets && id in opts.buckets ? opts.buckets[id] : `bkt-of-${id}`;
    return bucketId ? { bucketId, revision: 0 } : null;
  };
  const fetch = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    asked.push(new URL(u).pathname);
    if ((init?.method ?? 'GET') === 'DELETE') return Response.json({ released: true });
    if (u.endsWith('/execution/prepare')) {
      const action = JSON.parse(String(init?.body)) as { kind: 'message'; id: string };
      return Response.json(exec(`x-${action.id}`, { action }));
    }
    if (u.includes('/messaging/messages/')) {
      const id = decodeURIComponent(new URL(u).pathname.split('/').at(-1)!);
      await opts.readDelay?.(id);
      return Response.json(message(id, `text ${id}`));
    }
    if (u.endsWith('/inbox/ack')) {
      acks.push(...(JSON.parse(String(init?.body)).handledDeliveryIds as string[]));
      return Response.json({ ackedUpTo: 't' });
    }
    if (new URL(u).pathname === '/inbox') {
      await opts.onGet?.(u);
      const listed = (opts.rows() as Array<{ ts: string; resourceId: string }>).map((r) => ({ ...r, bucket: bucketOf(r.resourceId) }));
      const bellAt = listed.map((r) => r.ts).sort().at(-1) ?? null;
      return Response.json({ asOf: 't', ackTo: 't', bellAt, deliveries: listed, chats: [], tasksAwaitingMe: [],
        proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [] });
    }
    throw new Error(`unexpected ${u}`);
  };
  return { fetch, acks, asked };
}

const deps = (over: Partial<InboxLoopDeps>): InboxLoopDeps => ({
  creds: { operatorKey: 'key', agentId: 'agent' }, ownAgentId: 'agent', baseUrl: 'http://test',
  seen: new SeenMessages(), onMessage: async () => {}, onResourceEvent: async () => {}, ...over,
});

describe('the inbox runs buckets side by side', () => {
  it('runs different buckets at once, oldest first, never more than the bound', async (t) => {
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

  it('hands a bucket over in the order it was sent, even when the older read is slower', async (t) => {
    const fake = server({ rows: () => [row('m2', T(2)), row('m1', T(1))], buckets: { m1: 'b1', m2: 'b1' },
      readDelay: (id) => (id === 'm1' ? sleep(30) : undefined) });
    t.mock.method(globalThis, 'fetch', fake.fetch);
    const handed: Array<[unknown, unknown]> = [];
    await pollInboxOnce(deps({ onMessage: async (_text, metadata) => { handed.push([metadata.messageId, metadata.bucket]); } }));
    assert.deepEqual(handed, [['m1', b1], ['m2', b1]]);
    // The bucket comes on the inbox row; nothing asks for it.
    assert.ok(!fake.asked.includes('/buckets'));
  });

  it('hands a task over with the bucket it was put in', async (t) => {
    const task = { kind: 'task-state', action: { kind: 'task', id: 't1' }, resourceId: 't1', receiptId: 'r-t1', eventId: 'e-t1',
      actionState: 'ready', addressId: null, agreementId: 'agr-1', taskId: 't1', assigneeId: 'agent', ts: T(1) };
    const fake = server({ rows: () => [task], buckets: { t1: 'b1' } });
    t.mock.method(globalThis, 'fetch', fake.fetch);
    const woke: unknown[] = [];
    await pollInboxOnce(deps({ onTask: async (_task, _inputs, wake) => { woke.push(wake?.bucket); } }));
    assert.deepEqual(woke, [b1]);
  });

  it('runs a message in no bucket on its own execution', async (t) => {
    const fake = server({ rows: () => [row('m1', T(1))], buckets: { m1: null } });
    t.mock.method(globalThis, 'fetch', fake.fetch);
    const { agent, internals } = host();
    const lanes: string[] = [];
    internals._processEvent = async (_event, lane) => { lanes.push(lane); };
    await pollInboxOnce(deps({ onMessage: (text, metadata) => agent.handleMessage(text, metadata) }));
    assert.deepEqual(lanes, ['agent:x-m1']);
  });

  it('keeps inbox work independent even when several messages share a view', async (t) => {
    const fake = server({ rows: () => [row('a1', T(1)), row('a2', T(2)), row('b1', T(3))], buckets: { a1: 'A', a2: 'A', b1: 'B' } });
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
    assert.notEqual(lanes.get('a1'), lanes.get('a2'));
    assert.notEqual(lanes.get('b1'), lanes.get('a1'));
    assert.ok(log.indexOf('start a2') < log.indexOf('end a1'), `independent executions can overlap: ${log.join(', ')}`);
    assert.ok(log.indexOf('start b1') < log.indexOf('end a1'), `another bucket does not wait: ${log.join(', ')}`);
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

  it('waits on the server for new mail while a wake runs, and takes up a new bucket as soon as it arrives', async (t) => {
    let second = false;
    let gets = 0;
    let heldWithSeen = 0;
    const listed = () => (second ? [row('m1', T(1)), row('m2', T(2))] : [row('m1', T(1))])
      .filter((r) => !fake.acks.includes(r.receiptId));
    // Like the server: a held read with `seen` answers only mail delivered after it.
    const fake = server({
      rows: listed,
      onGet: async (url) => {
        gets++;
        const seen = new URL(url).searchParams.get('seen');
        if (!seen || !url.includes('wait=')) return;
        heldWithSeen++;
        for (let i = 0; i < 400 && !listed().some((r) => r.ts > seen); i++) await sleep(5);
      },
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
    }), { waitSeconds: 110 });
    await firstStarted;
    await sleep(100);
    assert.ok(gets <= 3, `the loop waits on the server instead of re-reading (${gets} reads)`);
    assert.ok(heldWithSeen >= 1, 'the held read passed back what it had seen');
    second = true;
    await within(secondStarted, 2_000, 'the new bucket waited for the running wake');
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

describe('what a wake in a bucket starts from', () => {
  const contents = {
    bucket: { bucketId: 'b1', name: 'Q3 plan', audience: ['mia', 'agent'], revision: 0 },
    threads: [
      { rootMessageId: 'm1', title: 'Numbers', messageCount: 3, lastAt: T(3), yours: true, current: true },
      { rootMessageId: 'm7', title: 'Budget', messageCount: 2, lastAt: T(2), yours: true, current: false,
        recent: [{ messageId: 'm8', from: 'mia', text: 'Cap it at 40k', at: T(2) }] },
      { rootMessageId: 'm9', title: 'Offsite', messageCount: 4, lastAt: T(1), yours: false, current: false },
    ],
    artifacts: [{ artifactId: 'a1', name: 'Forecast' }],
    tasks: [],
    agreements: [],
    outOfReach: 1,
  };

  it('loads the agent\'s other threads, lists the rest, and says how to read them', () => {
    const block = bucketBlock(contents);
    assert.match(block, /Bucket "Q3 plan" \(b1\), for mia, agent\./);
    assert.match(block, /Your other threads here, latest messages:\n- Budget \(thread m7, 2 messages\)\n {4}mia: Cap it at 40k/);
    assert.match(block, /Other threads here, not loaded:\n- Offsite \(thread m9, 4 messages\)/);
    assert.ok(!block.includes('Numbers'), 'the thread being answered is in the snapshot already');
    assert.match(block, /Artifacts: a1 \(Forecast\)\./);
    assert.match(block, /message_list conversationOf=<thread>/);
    assert.match(block, /1 more item\(s\) here are out of this run's reach\./);
    assert.equal(bucketBlock(undefined), '');
  });

  it('reads the bucket under the run, naming the message being answered', async (t) => {
    const asked: Array<{ url: string; execution?: string }> = [];
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      asked.push({ url: String(url), execution: (init?.headers as Record<string, string>)['X-Ziggs-Execution'] });
      return Response.json(contents);
    });
    const { internals } = host();
    const read = (internals as unknown as { bucketContents: (b: LaneBucket) => Promise<unknown> }).bucketContents.bind(internals);
    const got = await withWorkExecution(exec('c1'), () => read(b1));
    assert.deepEqual(got, contents);
    assert.match(asked[0].url, /\/buckets\/b1\/contents\?current=m-c1$/);
    assert.equal(asked[0].execution, 'c1');
  });
});
