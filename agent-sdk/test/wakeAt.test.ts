/**
 * ZIG-1813 — "wake me at", for both brains.
 *
 * The interesting cases are not "does setTimeout work". They are: does an
 * agent's own check-back survive the host's liveness re-arm, does a superseded
 * wake get dropped instead of arriving as a second reminder, and does the tool
 * report what was ARMED rather than what was asked for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StateTimers,
  MAX_WAKE_DELAY_MS,
  type TimerEvent,
} from '../src/platform/StateTimers.js';
import { wakeAtTool } from '../src/platform/tools/tier1/wakeTools.js';
import { laneKeyFor } from '../src/platform/laneKey.js';

// `armWakeAt` takes an ABSOLUTE time, so these tests mock Date alongside
// setTimeout. With only setTimeout mocked, `at: 60_000` reads as sixty seconds
// past the epoch — long gone — and every wake collapses to a zero delay that
// fires on the first tick, which makes the replace/precedence tests pass for
// the wrong reason.
test('StateTimers.armWakeAt', async (t) => {
  await t.test('fires a wake-at frame on the lane, carrying the reason', () => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const fired: Array<{ ev: TimerEvent; lane: string }> = [];
    const timers = new StateTimers((ev, lane) => fired.push({ ev, lane }));

    timers.armWakeAt('L1', 60_000, 'check whether Dana answered');
    t.mock.timers.tick(60_000);

    assert.equal(fired.length, 1);
    assert.equal(fired[0].lane, 'L1');
    assert.equal(fired[0].ev.type, 'wake-at');
    assert.equal(
      (fired[0].ev as { reason: string | null }).reason,
      'check whether Dana answered',
    );
    t.mock.timers.reset();
  });

  await t.test('accepts a Date as readily as epoch ms', () => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const fired: TimerEvent[] = [];
    const timers = new StateTimers((ev) => fired.push(ev));
    timers.armWakeAt('L1', new Date(30_000), null);
    t.mock.timers.tick(30_000);
    assert.equal(fired.length, 1);
    t.mock.timers.reset();
  });

  await t.test('a time already past wakes on the next turn rather than erroring', () => {
    // "wake me at 09:00" arriving at 09:00:01 means now. Refusing would just
    // be a check-back the agent never gets.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
    const fired: TimerEvent[] = [];
    const timers = new StateTimers((ev) => fired.push(ev));
    const armed = timers.armWakeAt('L1', 5_000, 'late');
    assert.equal(armed.delayMs, 0);
    t.mock.timers.tick(0);
    assert.equal(fired.length, 1);
    t.mock.timers.reset();
  });

  await t.test('refuses a wake past what a timer can hold, instead of firing at once', () => {
    // setTimeout overflows a 32-bit delay and fires immediately — a check-back
    // scheduled a year out would arrive the same second.
    const timers = new StateTimers(() => {});
    assert.throws(
      () => timers.armWakeAt('L1', Date.now() + MAX_WAKE_DELAY_MS + 60_000, null),
      /further out than this timer can hold/,
    );
  });

  await t.test('re-arming replaces: a check-back is a series of single wakes', () => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const fired: TimerEvent[] = [];
    const timers = new StateTimers((ev) => fired.push(ev));
    timers.armWakeAt('L1', 60_000, 'first');
    timers.armWakeAt('L1', 120_000, 'second');
    t.mock.timers.tick(60_000);
    assert.equal(fired.length, 0, 'the replaced wake must not fire');
    t.mock.timers.tick(60_000);
    assert.equal(fired.length, 1);
    assert.equal((fired[0] as { reason: string | null }).reason, 'second');
    t.mock.timers.reset();
  });

  await t.test('the liveness re-arm does not throw away the agent’s own wake', () => {
    // _armIfTimedParked runs after EVERY tick. If the generic net won here, an
    // agent that called wake_at inside a timed parked state would lose its
    // check-back on the way out of the tick that asked for it.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const fired: TimerEvent[] = [];
    const timers = new StateTimers((ev) => fired.push(ev));

    timers.armWakeAt('L1', 60_000, 'mine');
    timers.arm('L1', 'waiting', 5_000); // host liveness, must not replace it

    t.mock.timers.tick(5_000);
    assert.equal(fired.length, 0, 'liveness timeout must not have been armed');
    t.mock.timers.tick(55_000);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].type, 'wake-at');
    t.mock.timers.reset();
  });

  await t.test('an explicit wake DOES replace a pending liveness timeout', () => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const fired: TimerEvent[] = [];
    const timers = new StateTimers((ev) => fired.push(ev));
    timers.arm('L1', 'waiting', 5_000);
    timers.armWakeAt('L1', 60_000, 'mine');
    t.mock.timers.tick(60_000);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].type, 'wake-at');
    t.mock.timers.reset();
  });

  await t.test('a superseded wake-at frame is dropped, not delivered twice', () => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const timers = new StateTimers(() => {});
    timers.armWakeAt('L1', 60_000, 'first');
    const staleFrame = {
      type: 'wake-at',
      reason: 'first',
      scheduledFor: 60_000,
      epoch: 1,
    };
    timers.armWakeAt('L1', 60_000, 'second'); // epoch 2
    assert.equal(timers.stripStale(staleFrame, 'L1'), null);
    t.mock.timers.reset();
  });

  await t.test('clear cancels an armed wake', () => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const fired: TimerEvent[] = [];
    const timers = new StateTimers((ev) => fired.push(ev));
    timers.armWakeAt('L1', 60_000, null);
    timers.clear('L1');
    t.mock.timers.tick(120_000);
    assert.equal(fired.length, 0);
    t.mock.timers.reset();
  });

  await t.test('peek reports what is armed and of which kind', () => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const timers = new StateTimers(() => {});
    assert.equal(timers.peek('L1'), null);
    timers.armWakeAt('L1', 60_000, 'mine');
    assert.equal(timers.peek('L1')?.kind, 'wake-at');
    timers.clear('L1');
    timers.arm('L1', 'waiting', 5_000);
    assert.equal(timers.peek('L1')?.kind, 'liveness');
    t.mock.timers.reset();
  });
});

test('wake_at tool', async (t) => {
  const call = (args: Record<string, unknown>, ctx: Record<string, unknown>) =>
    (wakeAtTool.handler as (a: unknown, c: unknown) => Promise<unknown>)(args, ctx);

  await t.test('arms the lane for the session it was called in', async () => {
    const armed: Array<{ sessionId: string; at: unknown; reason: string | null }> = [];
    const result = (await call(
      { at: '2026-09-12T09:00:00Z', reason: 'chase Dana' },
      {
        chatId: 'chat_1',
        wakeScheduler: {
          armWakeAt: (sessionId: string, at: Date | number, reason: string | null) => {
            armed.push({ sessionId, at, reason });
            return { firesAt: Date.parse('2026-09-12T09:00:00Z'), delayMs: 1000 };
          },
        },
      },
    )) as { ok: boolean; wakeAt: string; reason: string | null };

    assert.equal(result.ok, true);
    assert.equal(armed.length, 1);
    assert.equal(armed[0].sessionId, 'chat_1');
    assert.equal(armed[0].reason, 'chase Dana');
    assert.equal(result.wakeAt, '2026-09-12T09:00:00.000Z');
  });

  await t.test('reports what was armed, not what was asked for', async () => {
    // They differ when the requested time has passed. An agent that thinks it
    // is waiting until tomorrow, but wakes in a second, spends its budget on
    // the difference.
    const actual = Date.parse('2026-09-11T00:00:00Z');
    const result = (await call(
      { at: '2020-01-01T00:00:00Z' },
      {
        chatId: 'chat_1',
        wakeScheduler: { armWakeAt: () => ({ firesAt: actual, delayMs: 0 }) },
      },
    )) as { wakeAt: string; inMs: number };
    assert.equal(result.wakeAt, new Date(actual).toISOString());
    assert.equal(result.inMs, 0);
  });

  await t.test('refuses an unreadable date rather than arming something arbitrary', async () => {
    await assert.rejects(
      call(
        { at: 'next Friday' },
        { chatId: 'chat_1', wakeScheduler: { armWakeAt: () => ({ firesAt: 0, delayMs: 0 }) } },
      ),
      /could not read "next Friday" as a date/,
    );
  });

  await t.test('requires `at`', async () => {
    await assert.rejects(
      call(
        {},
        { chatId: 'chat_1', wakeScheduler: { armWakeAt: () => ({ firesAt: 0, delayMs: 0 }) } },
      ),
      /requires `at`/,
    );
  });

  await t.test('says plainly when there is no scheduler, instead of pretending', async () => {
    await assert.rejects(
      call({ at: '2026-09-12T09:00:00Z' }, { chatId: 'chat_1' }),
      /wake_at is unavailable here/,
    );
  });
});

test('laneKeyFor is the one spelling of a lane', () => {
  // A timer armed on a differently-spelled lane never wakes anything, and
  // says nothing in the logs about why.
  assert.equal(laneKeyFor('agent_1', 'chat_1'), 'agent_1:chat_1');
});
