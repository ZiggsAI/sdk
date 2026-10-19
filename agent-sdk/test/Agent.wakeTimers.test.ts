import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import { StateTimers, type TimerEvent } from '../src/platform/StateTimers.js';
import type { Ctx } from '../src/types.js';
import type { TickInput, TickOutput } from '../src/brain/ZiggsBrain.js';

const lane = 'timer-agent:room';
const idle = (): TickOutput => ({
  ctx: {},
  state: 'idle',
  parked: true,
  stateTimeoutUnhandled: false,
  metrics: { llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } },
});

function makeHost(tick: (input: TickInput) => Promise<TickOutput> = async () => idle()) {
  const host = new Agent({
    agentId: 'timer-agent',
    operatorKey: 'test-key',
    anthropicKey: 'test-key',
    initial: 'idle',
    states: { idle: { kind: 'parked', transitions: [] } },
    inboxCatchUp: false,
  });
  host.brain = {
    workflow: {
      id: 'timers', description: 'test', initial: 'idle',
      states: { idle: { kind: 'parked', transitions: [] } },
    },
    tick,
  } as Agent['brain'];
  const internals = host as unknown as {
    sessions: Map<string, { sessionId: string; ownAgentId: string; ctx: Ctx; state: string }>;
    stateTimers: StateTimers;
    recordWakeOutcome: () => void;
    taskService: { getTask(id: string): Promise<unknown> };
    _processEvent(event: unknown, laneKey: string): Promise<void>;
  };
  internals.taskService = { getTask: async taskId => ({ taskId, state: 'active', assigneeId: 'timer-agent' }) };
  const fired: TimerEvent[] = [];
  const timers = new StateTimers((event) => fired.push(event));
  internals.stateTimers = timers;
  internals.recordWakeOutcome = () => {};
  internals.sessions.set(lane, {
    sessionId: 'room', ownAgentId: 'timer-agent', ctx: {}, state: 'idle',
  });
  return { timers, fired, process: (event: unknown) => internals._processEvent(event, lane) };
}

describe('Agent preserves requested wakes across unrelated events', () => {
  for (const event of [
    { type: 'notification', text: 'Plan updated' },
    { type: 'resource_changed', resource: { kind: 'task-state', change: 'updated' } },
    { type: 'task_result', result: { taskId: 'task-1', state: 'active' } },
  ]) {
    it(`keeps a reminder after a ${event.type} wake that does not re-arm`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      const { timers, fired, process } = makeHost();
      timers.armWakeAt(lane, 300_000, 'remind approver');
      await process(event);
      assert.equal(timers.peek(lane)?.firesAt, 300_000);
      t.mock.timers.tick(300_000);
      assert.equal(fired.length, 1);
      assert.equal(fired[0].type, 'wake-at');
      await process(fired[0]);
      assert.equal(timers.peek(lane), null, 'the matching timer event consumes the wake');
    });
  }

  it('keeps a fired but queued reminder when another event is handled first', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const seen: unknown[] = [];
    const { timers, fired, process } = makeHost(async ({ event }) => {
      seen.push(event);
      return idle();
    });
    timers.armWakeAt(lane, 300_000, 'remind approver');
    t.mock.timers.tick(300_000);
    await process({ type: 'notification', text: 'status changed' });
    await process(fired[0]);
    assert.equal(seen.length, 2);
    assert.equal(seen[1], fired[0]);
    assert.equal(timers.peek(lane), null);
  });

  it('consumes a reminder within a coalesced frame', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { timers, fired, process } = makeHost();
    timers.armWakeAt(lane, 300_000, 'remind approver');
    t.mock.timers.tick(300_000);
    await process({ type: 'batch', events: [{ type: 'notification' }, fired[0]] });
    assert.equal(timers.peek(lane), null);
  });

  it('lets a timed wake arm the next reminder without losing or duplicating it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let handled = 0;
    const { timers, fired, process } = makeHost(async () => {
      handled++;
      if (handled === 1) timers.armWakeAt(lane, 600_000, 'final reminder');
      return idle();
    });
    timers.armWakeAt(lane, 300_000, 'first reminder');
    t.mock.timers.tick(300_000);
    await process(fired[0]);
    assert.equal(timers.peek(lane)?.firesAt, 600_000);
    t.mock.timers.tick(300_000);
    await process(fired[1]);
    assert.equal(handled, 2);
    assert.equal(timers.peek(lane), null);
    t.mock.timers.tick(300_000);
    assert.equal(fired.length, 2);
  });

  it('drops a superseded timer without consuming its replacement', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let calls = 0;
    const { timers, fired, process } = makeHost(async () => { calls++; return idle(); });
    timers.armWakeAt(lane, 300_000, 'first');
    t.mock.timers.tick(300_000);
    timers.armWakeAt(lane, 600_000, 'rescheduled');
    await process(fired[0]);
    assert.equal(calls, 0);
    assert.equal(timers.peek(lane)?.firesAt, 600_000);
    timers.clearAll();
  });

  it('preserves a reminder if an unrelated tick fails', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { timers, process } = makeHost(async () => { throw new Error('test failure'); });
    timers.armWakeAt(lane, 300_000, 'remind approver');
    await assert.rejects(process({ type: 'notification' }), /test failure/);
    assert.equal(timers.peek(lane)?.firesAt, 300_000);
    timers.clearAll();
  });

  it('still clears the host liveness timer when its state is no longer timed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { timers, fired, process } = makeHost();
    timers.arm(lane, 'waiting', 1000);
    await process({ type: 'notification' });
    assert.equal(timers.peek(lane), null);
    t.mock.timers.tick(1000);
    assert.equal(fired.length, 0);
  });
});
