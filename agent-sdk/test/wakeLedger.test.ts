/**
 * An agent's own check-back survives a restart of its host.
 *
 * The timer is in memory; what it needs to be armed again is written to the
 * agent's memory notes when it is armed and marked done when it fires. These
 * tests restart the host by building a second Agent on the same store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import { InMemoryStore, type MemoryStore } from '../src/memory/MemoryStore.js';
import { WakeLedger } from '../src/platform/WakeLedger.js';
import type { StateTimers, TimerEvent } from '../src/platform/StateTimers.js';
import { wakeAtTool } from '../src/platform/tools/tier1/wakeTools.js';

/** A store that is not the in-memory one, the way a host's note store is not. */
function savedStore(): MemoryStore {
  const rows = new Map<string, unknown>();
  return {
    get: async (key) => rows.get(key),
    put: async (key, value) => {
      rows.set(key, value);
    },
    list: async (prefix) =>
      [...rows.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
  };
}

const AGENT = 'follow-up';
const ROOM = 'room-1';
const LANE = `${AGENT}:${ROOM}`;

function host(store: MemoryStore) {
  const agent = new Agent({
    agentId: AGENT,
    operatorKey: 'test-key',
    anthropicKey: 'test-key',
    initial: 'idle',
    states: { idle: { kind: 'parked', transitions: [] } },
    inboxCatchUp: false,
    memory: store,
  });
  const fired: Array<{ ev: TimerEvent; lane: string }> = [];
  const internals = agent as unknown as {
    sessions: Map<string, { sessionId: string; ownAgentId: string }>;
    stateTimers: StateTimers;
    wakeLedger: WakeLedger;
    eventQueue: { enqueue(ev: unknown, lane: string): Promise<void> };
    armOwnWake(sessionId: string, at: number, reason: string | null): { firesAt: number; durable: boolean };
    restoreWakes(): Promise<void>;
  };
  internals.eventQueue = {
    enqueue: async (ev, lane) => {
      fired.push({ ev: ev as TimerEvent, lane });
    },
  };
  return { agent, internals, fired };
}

describe('a check-back survives a restart', () => {
  it('arms a saved wake again on start, and it fires at its time', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const store = savedStore();
    const before = host(store);
    const armed = before.internals.armOwnWake(ROOM, 600_000, 'check whether Camila answered');
    assert.equal(armed.durable, true);
    await before.internals.wakeLedger.flushed();
    before.internals.stateTimers.clearAll(); // the process goes down

    const after = host(store);
    await after.internals.restoreWakes();
    assert.equal(after.internals.stateTimers.peek(LANE)?.firesAt, 600_000);
    assert.equal(after.internals.sessions.get(LANE)?.sessionId, ROOM, 'the lane gets a session to wake');

    t.mock.timers.tick(600_000);
    assert.equal(after.fired.length, 1);
    assert.equal(after.fired[0].lane, LANE);
    assert.equal(after.fired[0].ev.type, 'wake-at');
    assert.equal((after.fired[0].ev as { reason: string | null }).reason, 'check whether Camila answered');
    await after.internals.wakeLedger.flushed();
    assert.deepEqual(await after.internals.wakeLedger.pending(), []);
    t.mock.timers.reset();
  });

  it('fires a wake that passed while the host was down once, and never again', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const store = savedStore();
    const before = host(store);
    before.internals.armOwnWake(ROOM, 60_000, 'one follow-up');
    await before.internals.wakeLedger.flushed();
    before.internals.stateTimers.clearAll();

    t.mock.timers.setTime(3_600_000); // an hour later the host is back
    const after = host(store);
    await after.internals.restoreWakes();
    t.mock.timers.tick(0);
    assert.equal(after.fired.length, 1);
    await after.internals.wakeLedger.flushed();

    const again = host(store);
    await again.internals.restoreWakes();
    t.mock.timers.tick(3_600_000);
    assert.equal(again.fired.length, 0, 'a fired wake is not armed on the next start');
    t.mock.timers.reset();
  });

  it('keeps only the latest wake for a lane', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const store = savedStore();
    const before = host(store);
    before.internals.armOwnWake(ROOM, 60_000, 'first');
    before.internals.armOwnWake(ROOM, 120_000, 'second');
    await before.internals.wakeLedger.flushed();
    const pending = await before.internals.wakeLedger.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].reason, 'second');
    before.internals.stateTimers.clearAll();
    t.mock.timers.reset();
  });

  it('a wake that fires at once is marked done after it is saved, not before', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const store = savedStore();
    const before = host(store);
    before.internals.armOwnWake(ROOM, 0, 'already due');
    t.mock.timers.tick(0);
    await before.internals.wakeLedger.flushed();
    assert.deepEqual(await before.internals.wakeLedger.pending(), []);
    t.mock.timers.reset();
  });

  it('says a wake is not kept when the host has no saved store', () => {
    const ledger = new WakeLedger(new InMemoryStore());
    assert.equal(ledger.durable, false);
    assert.equal(new WakeLedger(savedStore()).durable, true);
  });

  it("tells the agent whether its wake survives a restart", async () => {
    const run = (durable: boolean) =>
      wakeAtTool.handler(
        { at: new Date(Date.now() + 60_000).toISOString(), reason: 'check back' },
        {
          chatId: ROOM,
          wakeScheduler: { armWakeAt: () => ({ firesAt: Date.now() + 60_000, delayMs: 60_000, durable }) },
        },
      ) as Promise<{ note: string }>;
    assert.match((await run(true)).note, /restart of your host arms it again/);
    assert.match((await run(false)).note, /if the process restarts before it fires it is lost/);
  });
});
