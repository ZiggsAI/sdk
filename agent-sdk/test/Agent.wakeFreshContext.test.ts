import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import type { WakeAtEvent } from '../src/platform/StateTimers.js';

const lane = 'wake-agent:xec_old';
const wake: WakeAtEvent = { type: 'wake-at', wakeId: 'wake-1', reason: 'next queue day', firedAt: 0 } as WakeAtEvent;
const changed = Object.assign(new Error('The work audience or authority changed.'), { code: 'EXECUTION_CONTEXT_CHANGED' });
const saved = { contextId: 'xec_old', actorId: 'wake-agent', action: { kind: 'task', id: 'task-1' } };
const fresh = { contextId: 'xec_new', actorId: 'wake-agent', action: { kind: 'task', id: 'task-1' } };

function makeHost(opts: {
  enqueue: (execution: unknown) => Promise<void>;
  prepare?: (action: unknown) => Promise<unknown>;
  session?: Record<string, unknown>;
}) {
  const host = new Agent({
    agentId: 'wake-agent',
    operatorKey: 'test-key',
    anthropicKey: 'test-key',
    initial: 'idle',
    states: { idle: { kind: 'parked', transitions: [] } },
    inboxCatchUp: false,
  });
  const internals = host as unknown as {
    sessions: Map<string, Record<string, unknown>>;
    eventQueue: { enqueue(event: unknown, laneKey: string, execution?: unknown): Promise<void> };
    wakeLedger: { done(laneKey: string, wakeId: string): void };
    prepareExecution: (action: unknown, operatorKey: string, agentId: string, baseUrl?: string) => Promise<unknown>;
    retryOwnWake: (ev: WakeAtEvent, laneKey: string) => void;
    runTimerEvent(ev: WakeAtEvent, laneKey: string): Promise<void>;
  };
  const seen = { ranUnder: [] as unknown[], prepared: [] as unknown[], done: [] as string[], retried: 0 };
  internals.sessions.set(lane, opts.session ?? { sessionId: 'room', ownAgentId: 'wake-agent', executionContext: saved });
  internals.eventQueue = {
    enqueue: async (_event, _laneKey, execution) => {
      seen.ranUnder.push(execution);
      await opts.enqueue(execution);
    },
  };
  internals.wakeLedger = { done: (_laneKey, wakeId) => { seen.done.push(wakeId); } };
  internals.prepareExecution = async (action) => {
    seen.prepared.push(action);
    return (opts.prepare ?? (async () => fresh))(action);
  };
  internals.retryOwnWake = () => { seen.retried++; };
  return { seen, run: () => internals.runTimerEvent(wake, lane) };
}

describe("an agent's own wake after the work's audience changed", () => {
  it('runs once more under a context prepared now, and is then done', async () => {
    const { seen, run } = makeHost({
      enqueue: async (execution) => { if (!execution) throw changed; },
    });
    await run();
    assert.deepEqual(seen.prepared, [saved.action], 'the same action is prepared again');
    assert.deepEqual(seen.ranUnder, [undefined, fresh]);
    assert.deepEqual(seen.done, ['wake-1']);
    assert.equal(seen.retried, 0, 'no retry under the saved context');
  });

  it('does not prepare a new context for any other failure', async () => {
    const { seen, run } = makeHost({
      enqueue: async () => { throw new Error('tick timeout'); },
    });
    await run();
    assert.deepEqual(seen.prepared, []);
    assert.equal(seen.retried, 1);
    assert.deepEqual(seen.done, []);
  });

  it('falls back to the usual retry when the backend refuses a new context', async () => {
    const { seen, run } = makeHost({
      enqueue: async () => { throw changed; },
      prepare: async () => { throw new Error('Action execution is unavailable'); },
    });
    await run();
    assert.deepEqual(seen.ranUnder, [undefined], 'the wake is not run without authority');
    assert.equal(seen.retried, 1);
    assert.deepEqual(seen.done, []);
  });

  it('falls back to the usual retry when the fresh run fails too', async () => {
    const { seen, run } = makeHost({
      enqueue: async () => { throw changed; },
    });
    await run();
    assert.deepEqual(seen.ranUnder, [undefined, fresh], 'one fresh run, not a loop');
    assert.equal(seen.retried, 1);
    assert.deepEqual(seen.done, []);
  });

  it('leaves a lane with no exact action to the usual retry', async () => {
    const { seen, run } = makeHost({
      enqueue: async () => { throw changed; },
      session: { sessionId: 'room', ownAgentId: 'wake-agent' },
    });
    await run();
    assert.deepEqual(seen.prepared, []);
    assert.equal(seen.retried, 1);
  });
});
