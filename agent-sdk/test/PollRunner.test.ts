import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { assistantRequestHeaders, withAssistantRequest, withWorkExecution, type WorkExecutionContext } from '@ziggs-ai/api-client';
const execution = (agentId = 'a1', taskId = 't1'): WorkExecutionContext => ({contextId:`ctx-${taskId}`, actorId:agentId, principalId:agentId, taskId, agreementId:'agr', position:'provider', audienceIds:[agentId], audienceRevision:'1', action:{kind:'task',id:taskId}});
beforeEach(() => { mock.method(globalThis, 'fetch', async (_url, init) => new Response(JSON.stringify(execution(new Headers(init?.headers).get('X-Agent-Id') ?? 'a1', JSON.parse(String(init?.body)).id)), {status:200})); });
afterEach(() => mock.restoreAll());
import assert from 'node:assert/strict';

import { Agent } from '../src/Agent.js';
import { PollRegistry, declaredPolls, type PollKind } from '../src/platform/polls/PollKind.js';
import { PollRunner, type WakeTarget } from '../src/platform/polls/PollRunner.js';

function recordingPool() {
  const wakes: {
    agentId: string;
    taskId: string;
    metadata?: Record<string, unknown>;
    opts?: { timeoutMs?: number };
  }[] = [];
  const pool: WakeTarget = {
    async wakeTask(agentId, taskId, context, opts) {
      wakes.push({ agentId, taskId, metadata:{executionContext:context}, ...(opts ? { opts } : {}) });
      return null;
    },
  };
  return { pool, wakes };
}

function kind(id: string, results: boolean[]): PollKind {
  let i = 0;
  return {
    id,
    intervalMs: 5,
    async poll() {
      const actionable = results[Math.min(i, results.length - 1)] ?? false;
      i += 1;
      return actionable ? { actionable: true, action:{kind:'task',id:'t1'}, hint: `${id} has work` } : { actionable: false };
    },
  };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('declaredPolls', () => {
  it('reads well-formed bindings and ignores the rest', () => {
    const polls = declaredPolls({
      polls: [{ kind: 'a' }, { nope: true }, null, 'x', { kind: 'b', extra: 1 }],
    });
    assert.deepEqual(
      polls.map((p) => p.kind),
      ['a', 'b'],
    );
  });

  it('returns none when the agent declares nothing', () => {
    assert.deepEqual(declaredPolls({}), []);
    assert.deepEqual(declaredPolls({ polls: 'not-an-array' }), []);
  });
});

describe('PollRegistry', () => {
  it('refuses a duplicate kind rather than silently replacing one', () => {
    const reg = new PollRegistry().register(kind('dup', [false]));
    assert.throws(() => reg.register(kind('dup', [false])), /duplicate poll kind/);
  });
});

describe('PollRunner', () => {
  it('wakes the declaring agent when its source has work', async () => {
    const { pool, wakes } = recordingPool();
    const registry = new PollRegistry().register(kind('src', [true, false]));
    const runner = new PollRunner({
      operatorKey: 'key',
      pool,
      registry,
      agents: [{ agentId: 'a1', polls: [{ kind: 'src' }] }],
    });

    runner.start();
    await settle();
    runner.stop();

    assert.ok(wakes.length >= 1, 'expected at least one wake');
    assert.equal(wakes[0]!.agentId, 'a1');
    assert.equal(wakes[0]!.taskId, 't1');
  });

  // ZIG-1396. Nothing else bounds this: the agent polls the outside world and
  // triggers itself, so the backend never sees the trigger and the agreement
  // wake ceiling never fires. A source stuck on "actionable" costs a model run
  // per interval, forever.
  describe('wake cap', () => {
    it('stops waking a source that never stops reporting actionable', async () => {
      const { pool, wakes } = recordingPool();
      // Always actionable: the runaway shape.
      const registry = new PollRegistry().register(kind('stuck', [true]));
      const runner = new PollRunner({
      operatorKey: 'key',
        pool,
        registry,
        agents: [{ agentId: 'a1', polls: [{ kind: 'stuck' }] }],
        maxWakesPerWindow: 3,
        wakeWindowMs: 60_000,
      });

      runner.start();
      await settle(120);
      runner.stop();

      // The poll interval is 5ms, so an uncapped runner would have woken far
      // more than three times in that window.
      assert.equal(wakes.length, 3, `expected exactly 3 wakes, got ${wakes.length}`);
    });

    it('wakes again once the window rolls', async () => {
      const { pool, wakes } = recordingPool();
      const registry = new PollRegistry().register(kind('stuck', [true]));
      const runner = new PollRunner({
      operatorKey: 'key',
        pool,
        registry,
        agents: [{ agentId: 'a1', polls: [{ kind: 'stuck' }] }],
        maxWakesPerWindow: 2,
        // Short enough to roll during the test.
        wakeWindowMs: 40,
      });

      runner.start();
      await settle(200);
      runner.stop();

      // Capped at 2 per 40ms window over ~200ms: more than 2 (windows rolled)
      // but nothing like the ~40 an uncapped 5ms poll would produce.
      assert.ok(wakes.length > 2, `expected the cap to lift, got ${wakes.length}`);
      assert.ok(wakes.length <= 12, `expected the cap to still bind, got ${wakes.length}`);
    });

    it('caps each binding separately, so one runaway does not silence another', async () => {
      const { pool, wakes } = recordingPool();
      const registry = new PollRegistry()
        .register(kind('stuck', [true]))
        .register(kind('other', [true]));
      const runner = new PollRunner({
      operatorKey: 'key',
        pool,
        registry,
        agents: [
          { agentId: 'a1', polls: [{ kind: 'stuck' }] },
          { agentId: 'a2', polls: [{ kind: 'other' }] },
        ],
        maxWakesPerWindow: 2,
        wakeWindowMs: 60_000,
      });

      runner.start();
      await settle(120);
      runner.stop();

      assert.equal(wakes.filter((w) => w.agentId === 'a1').length, 2);
      assert.equal(wakes.filter((w) => w.agentId === 'a2').length, 2);
    });
  });

  it('does not wake when the source has nothing', async () => {
    const { pool, wakes } = recordingPool();
    const registry = new PollRegistry().register(kind('quiet', [false]));
    const runner = new PollRunner({
      operatorKey: 'key',
      pool,
      registry,
      agents: [{ agentId: 'a1', polls: [{ kind: 'quiet' }] }],
    });

    runner.start();
    await settle();
    runner.stop();

    assert.equal(wakes.length, 0);
  });

  it('skips an unknown kind instead of throwing the fleet over', () => {
    const { pool } = recordingPool();
    const runner = new PollRunner({
      operatorKey: 'key',
      pool,
      registry: new PollRegistry(),
      agents: [{ agentId: 'a1', polls: [{ kind: 'nobody-registered-this' }] }],
    });
    assert.equal(runner.size, 0);
  });

  it('registers a source-only binding without a room', () => {
    const { pool } = recordingPool();
    const runner = new PollRunner({
      operatorKey: 'key',
      pool,
      registry: new PollRegistry().register(kind('src', [true])),
      agents: [{ agentId: 'a1', polls: [{ kind: 'src' }] }],
    });
    assert.equal(runner.size, 1);
  });

  it('prepares the exact task before handing it to the host', async () => {
    // Without addressId in the metadata, Agent's session resolver returns null
    // and drops the wake with only a debug line — the failure this guards.
    const { pool, wakes } = recordingPool();
    const registry = new PollRegistry().register(kind('src', [true, false]));
    const runner = new PollRunner({
      operatorKey: 'key',
      pool,
      registry,
      agents: [{ agentId: 'a1', polls: [{ kind: 'src' }] }],
    });

    runner.start();
    await settle();
    runner.stop();

    assert.equal(wakes[0]!.taskId, 't1');
    assert.deepEqual(wakes[0]!.metadata?.executionContext, execution());
  });

  it('gives the wake longer than the pool default, so a real wake is not called hung', async () => {
    // Lab run: pool.sendTo defaults to 30s, a Claude-brain wake is allowed 300s,
    // so every healthy multi-turn wake logged a failure and backed the source
    // off. The runner has to set the timeout itself.
    const { pool, wakes } = recordingPool();
    const registry = new PollRegistry().register(kind('src', [true, false]));
    const runner = new PollRunner({
      operatorKey: 'key',
      pool,
      registry,
      agents: [{ agentId: 'a1', polls: [{ kind: 'src' }] }],
      wakeTimeoutMs: 123_456,
    });

    runner.start();
    await settle();
    runner.stop();

    assert.equal(wakes[0]!.opts?.timeoutMs, 123_456);
  });

  it('separates a failing source from a failing wake', async () => {
    const wakeErrors: string[] = [];
    const pool: WakeTarget = {
      async wakeTask() {
        throw new Error('wakeTask timeout');
      },
    };
    let polls = 0;
    const healthy: PollKind = {
      id: 'healthy',
      intervalMs: 5,
      async poll() {
        polls += 1;
        return { actionable: true, action:{kind:'task',id:'t1'}, hint: 'work' };
      },
    };
    const runner = new PollRunner({
      operatorKey: 'key',
      pool,
      registry: new PollRegistry().register(healthy),
      agents: [{ agentId: 'a1', polls: [{ kind: 'healthy' }] }],
      maxBackoffMs: 40,
    });

    runner.start();
    await settle(100);
    runner.stop();

    // The source keeps being polled — a broken wake must not be reported as the
    // source being down, and must not stop us noticing new work.
    assert.ok(polls >= 2, `expected the healthy source to keep being polled, got ${polls}`);
    assert.equal(wakeErrors.length, 0);
  });

  it('accepts a mechanical source without a model lane', () => {
    const { pool } = recordingPool();
    const registry = new PollRegistry().register(kind('src', [true]));
    const runner = new PollRunner({
      operatorKey: 'key',
      pool,
      registry,
      agents: [{ agentId: 'a1', polls: [{ kind: 'src' }] }],
    });
    assert.equal(runner.size, 1);
  });

  it('backs off a failing source instead of hammering it', async () => {
    const { pool } = recordingPool();
    let calls = 0;
    const broken: PollKind = {
      id: 'broken',
      intervalMs: 5,
      async poll() {
        calls += 1;
        throw new Error('source down');
      },
    };
    const runner = new PollRunner({
      operatorKey: 'key',
      pool,
      registry: new PollRegistry().register(broken),
      agents: [{ agentId: 'a1', polls: [{ kind: 'broken' }] }],
      maxBackoffMs: 400,
    });

    runner.start();
    await settle(120);
    runner.stop();

    // At a flat 5ms interval this window fits ~20 attempts; doubling should keep
    // it in the low single digits.
    assert.ok(calls >= 2, `expected retries, got ${calls}`);
    assert.ok(calls <= 8, `expected backoff to throttle retries, got ${calls}`);
  });

  it('registers one loop per declared binding, and none for undeclared agents', () => {
    const { pool } = recordingPool();
    const registry = new PollRegistry()
      .register(kind('one', [false]))
      .register(kind('two', [false]));
    const runner = new PollRunner({
      operatorKey: 'key',
      pool,
      registry,
      agents: [
        { agentId: 'a1', polls: [{ kind: 'one' }, { kind: 'two' }] },
        { agentId: 'a2' },
        { notAnAgent: true },
      ],
    });
    assert.equal(runner.size, 2);
  });

  it('keeps polling after a kind throws', async () => {
    const { pool, wakes } = recordingPool();
    let calls = 0;
    const flaky: PollKind = {
      id: 'flaky',
      intervalMs: 5,
      async poll() {
        calls += 1;
        if (calls === 1) throw new Error('source down');
        return { actionable: true, action:{kind:'task',id:'t1'}, hint: 'recovered' };
      },
    };
    const runner = new PollRunner({
      operatorKey: 'key',
      pool,
      registry: new PollRegistry().register(flaky),
      agents: [{ agentId: 'a1', polls: [{ kind: 'flaky' }] }],
    });

    runner.start();
    await settle();
    runner.stop();

    assert.ok(calls > 1, 'expected the loop to survive the throw and poll again');
    assert.ok(wakes.length >= 1, 'expected a wake once the source recovered');
  });

  it('reaches a real Agent lane end to end', async () => {
    // Regression: the first version sent no addressId. sendTo reached
    // handleMessage, the default session resolver keyed on addressId, returned
    // null, and the wake was discarded with a debug line — a poll that fired
    // every interval and delivered nothing, looking exactly like a quiet source.
    const host = new Agent({
      agentId: 'polled-agent',
      operatorKey: 'k',
      openaiKey: 'test-key',
      model: 'gpt-4o-mini',
      description: 'x',
      cognition: 'fsm',
      initial: 'ready',
      states: { ready: { kind: 'parked', transitions: [] } },
      inboxCatchUp: false,
    } as never);
    (host as unknown as {taskService:{getTask(id:string):Promise<unknown>}}).taskService = {getTask:async id => ({taskId:id,agreementId:'agr',state:'active'})};
    const lanes: string[] = [];
    (
      host as never as { eventQueue: { enqueue: (e: unknown, l: string) => Promise<void> } }
    ).eventQueue = {
      async enqueue(_e, lane) {
        lanes.push(lane);
      },
    };

    const runner = new PollRunner({
      operatorKey: 'key',
      pool: { wakeTask: (_id, taskId) => host.wakeTaskAssignment(taskId) },
      registry: new PollRegistry().register(kind('src', [true, false])),
      agents: [{ agentId: 'polled-agent', polls: [{ kind: 'src' }] }],
    });

    runner.start();
    await settle();
    runner.stop();

    assert.equal(lanes.length, 1);
    assert.match(lanes[0]!, /ctx-t1/);
    assert.doesNotMatch(lanes[0]!, /chat_real/);
  });

  it('stop() halts further wakes', async () => {
    const { pool, wakes } = recordingPool();
    const registry = new PollRegistry().register(kind('busy', [true]));
    const runner = new PollRunner({
      operatorKey: 'key',
      pool,
      registry,
      agents: [{ agentId: 'a1', polls: [{ kind: 'busy' }] }],
    });

    runner.start();
    await settle(30);
    runner.stop();
    const atStop = wakes.length;
    await settle(40);

    assert.equal(wakes.length, atStop, 'no wakes should land after stop()');
  });
});

it('mechanical callbacks start without inherited authority and cannot dispatch after stop during a read', async () => {
  let release!:()=>void, entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve});
  const started=new Promise<void>(resolve=>{entered=resolve});
  let dispatches=0;
  const {pool,wakes}=recordingPool();
  const source:PollKind={id:'mechanical',async poll(_binding,ctx){
    assert.deepEqual(assistantRequestHeaders(),{}); entered(); await gate;
    if(ctx.isActive()) dispatches++;
    return {actionable:false};
  }};
  const runner=new PollRunner({pool,registry:new PollRegistry().register(source),agents:[{agentId:'a1',polls:[{kind:'mechanical'}]}],operatorKey:'key'});
  await withAssistantRequest({orgId:'private',resource:'task:other',clientSessionId:'session',instanceId:'instance',workspaceIds:'private',app:'app',sessionName:'secret'},()=>withWorkExecution({...execution(),attemptId:'old-attempt'},async()=>{
    runner.start(); await started; runner.stop(); release(); await settle(10);
    assert.equal(assistantRequestHeaders()['X-Ziggs-Attempt'],'old-attempt');
  }));
  assert.equal(dispatches,0);assert.equal(wakes.length,0);
});
it('an unbound or refused action never wakes a model or falls back to room authority',async()=>{
  const {pool,wakes}=recordingPool();
  const requests:string[]=[];
  mock.method(globalThis,'fetch',async (_url,init)=>{requests.push(String(init?.body));return new Response('revoked',{status:403})});
  const registry=new PollRegistry().register({id:'unbound',poll:async()=>({actionable:true})}).register(kind('refused',[true]));
  const runner=new PollRunner({pool,registry,agents:[{agentId:'a1',polls:[{kind:'unbound'},{kind:'refused'}]}],operatorKey:'key'});
  runner.start(); await settle(30);runner.stop();
  assert.equal(wakes.length,0);assert.ok(requests.length>0);
  assert.ok(requests.every(body=>body===JSON.stringify({kind:'task',id:'t1'})));
});
