import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../src/Agent.js';
import { PollRegistry, declaredPolls, type PollKind } from '../src/platform/polls/PollKind.js';
import { PollRunner, type WakeTarget } from '../src/platform/polls/PollRunner.js';

function recordingPool() {
  const wakes: {
    agentId: string;
    text: string;
    metadata?: Record<string, unknown>;
    opts?: { timeoutMs?: number };
  }[] = [];
  const pool: WakeTarget = {
    async sendTo(agentId, text, metadata, opts) {
      wakes.push({ agentId, text, ...(metadata ? { metadata } : {}), ...(opts ? { opts } : {}) });
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
      return actionable ? { actionable: true, hint: `${id} has work` } : { actionable: false };
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
      pool,
      registry,
      agents: [{ agentId: 'a1', polls: [{ kind: 'src', chatId: 'c1' }] }],
    });

    runner.start();
    await settle();
    runner.stop();

    assert.ok(wakes.length >= 1, 'expected at least one wake');
    assert.equal(wakes[0]!.agentId, 'a1');
    assert.match(wakes[0]!.text, /src has work/);
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
        pool,
        registry,
        agents: [{ agentId: 'a1', polls: [{ kind: 'stuck', chatId: 'c1' }] }],
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
        pool,
        registry,
        agents: [{ agentId: 'a1', polls: [{ kind: 'stuck', chatId: 'c1' }] }],
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
        pool,
        registry,
        agents: [
          { agentId: 'a1', polls: [{ kind: 'stuck', chatId: 'c1' }] },
          { agentId: 'a2', polls: [{ kind: 'other', chatId: 'c2' }] },
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
      pool,
      registry,
      agents: [{ agentId: 'a1', polls: [{ kind: 'quiet', chatId: 'c1' }] }],
    });

    runner.start();
    await settle();
    runner.stop();

    assert.equal(wakes.length, 0);
  });

  it('skips an unknown kind instead of throwing the fleet over', () => {
    const { pool } = recordingPool();
    const runner = new PollRunner({
      pool,
      registry: new PollRegistry(),
      agents: [{ agentId: 'a1', polls: [{ kind: 'nobody-registered-this', chatId: 'c1' }] }],
    });
    assert.equal(runner.size, 0);
  });

  it('skips a binding with no chatId instead of throwing the fleet over', () => {
    const { pool } = recordingPool();
    const runner = new PollRunner({
      pool,
      registry: new PollRegistry().register(kind('src', [true])),
      agents: [{ agentId: 'a1', polls: [{ kind: 'src' }] }],
    });
    assert.equal(runner.size, 0);
  });

  it('carries the lane on the wake, so the host can resolve a session', async () => {
    // Without chatId in the metadata, Agent's session resolver returns null
    // and drops the wake with only a debug line — the failure this guards.
    const { pool, wakes } = recordingPool();
    const registry = new PollRegistry().register(kind('src', [true, false]));
    const runner = new PollRunner({
      pool,
      registry,
      agents: [{ agentId: 'a1', polls: [{ kind: 'src', chatId: 'c-lane' }] }],
    });

    runner.start();
    await settle();
    runner.stop();

    assert.equal(wakes[0]!.metadata?.['chatId'], 'c-lane');
    assert.equal(wakes[0]!.metadata?.['pollKind'], 'src');
  });

  it('gives the wake longer than the pool default, so a real wake is not called hung', async () => {
    // Lab run: pool.sendTo defaults to 30s, a Claude-brain wake is allowed 300s,
    // so every healthy multi-turn wake logged a failure and backed the source
    // off. The runner has to set the timeout itself.
    const { pool, wakes } = recordingPool();
    const registry = new PollRegistry().register(kind('src', [true, false]));
    const runner = new PollRunner({
      pool,
      registry,
      agents: [{ agentId: 'a1', polls: [{ kind: 'src', chatId: 'c1' }] }],
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
      async sendTo() {
        throw new Error('sendTo timeout');
      },
    };
    let polls = 0;
    const healthy: PollKind = {
      id: 'healthy',
      intervalMs: 5,
      async poll() {
        polls += 1;
        return { actionable: true, hint: 'work' };
      },
    };
    const runner = new PollRunner({
      pool,
      registry: new PollRegistry().register(healthy),
      agents: [{ agentId: 'a1', polls: [{ kind: 'healthy', chatId: 'c1' }] }],
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

  it('refuses to register a binding with no lane', () => {
    const { pool } = recordingPool();
    const registry = new PollRegistry().register(kind('src', [true]));
    const runner = new PollRunner({
      pool,
      registry,
      agents: [{ agentId: 'a1', polls: [{ kind: 'src' }] }],
    });
    assert.equal(runner.size, 0, 'a laneless poll must be refused at startup, not per wake');
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
      pool,
      registry: new PollRegistry().register(broken),
      agents: [{ agentId: 'a1', polls: [{ kind: 'broken', chatId: 'c1' }] }],
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
      pool,
      registry,
      agents: [
        { agentId: 'a1', polls: [{ kind: 'one', chatId: 'c1' }, { kind: 'two', chatId: 'c1' }] },
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
        return { actionable: true, hint: 'recovered' };
      },
    };
    const runner = new PollRunner({
      pool,
      registry: new PollRegistry().register(flaky),
      agents: [{ agentId: 'a1', polls: [{ kind: 'flaky', chatId: 'c1' }] }],
    });

    runner.start();
    await settle();
    runner.stop();

    assert.ok(calls > 1, 'expected the loop to survive the throw and poll again');
    assert.ok(wakes.length >= 1, 'expected a wake once the source recovered');
  });

  it('reaches a real Agent lane end to end', async () => {
    // Regression: the first version sent no chatId. sendTo reached
    // handleMessage, the default session resolver keyed on chatId, returned
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
    const lanes: string[] = [];
    (
      host as never as { eventQueue: { enqueue: (e: unknown, l: string) => Promise<void> } }
    ).eventQueue = {
      async enqueue(_e, lane) {
        lanes.push(lane);
      },
    };

    const runner = new PollRunner({
      pool: { sendTo: (_id, text, metadata) => host.handleMessage(text, metadata ?? {}) },
      registry: new PollRegistry().register(kind('src', [true, false])),
      agents: [{ agentId: 'polled-agent', polls: [{ kind: 'src', chatId: 'chat_real' }] }],
    });

    runner.start();
    await settle();
    runner.stop();

    assert.deepEqual(lanes, ['polled-agent:chat_real']);
  });

  it('stop() halts further wakes', async () => {
    const { pool, wakes } = recordingPool();
    const registry = new PollRegistry().register(kind('busy', [true]));
    const runner = new PollRunner({
      pool,
      registry,
      agents: [{ agentId: 'a1', polls: [{ kind: 'busy', chatId: 'c1' }] }],
    });

    runner.start();
    await settle(30);
    runner.stop();
    const atStop = wakes.length;
    await settle(40);

    assert.equal(wakes.length, atStop, 'no wakes should land after stop()');
  });
});
