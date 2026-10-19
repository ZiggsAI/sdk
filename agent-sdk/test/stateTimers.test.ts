import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateTimers, type StateTimeoutEvent } from '../src/platform/StateTimers.js';

test('StateTimers', async (t) => {
  await t.test('arm fires exactly once with the right frame; re-tick does not re-fire', () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fired: Array<{ ev: StateTimeoutEvent; lane: string }> = [];
    const timers = new StateTimers((ev, lane) => fired.push({ ev, lane }));
    timers.arm('L1', 'waiting', 5000);
    t.mock.timers.tick(5000);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].lane, 'L1');
    assert.equal(fired[0].ev.type, 'state-timeout');
    assert.equal(fired[0].ev.state, 'waiting');
    assert.equal(fired[0].ev.waitedMs, 5000);
    assert.equal(typeof fired[0].ev.epoch, 'number');
    t.mock.timers.tick(10000);
    assert.equal(fired.length, 1);
    t.mock.timers.reset();
  });

  await t.test('clear before fire cancels', () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fired: StateTimeoutEvent[] = [];
    const timers = new StateTimers((ev) => fired.push(ev));
    timers.arm('L1', 'waiting', 5000);
    timers.clear('L1');
    t.mock.timers.tick(6000);
    assert.equal(fired.length, 0);
    t.mock.timers.reset();
  });

  await t.test('re-arm supersedes epoch; stripStale drops the old epoch frame', () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fired: StateTimeoutEvent[] = [];
    const timers = new StateTimers((ev) => fired.push(ev));
    timers.arm('L1', 'waiting', 5000);
    const staleFrame = { type: 'state-timeout', state: 'waiting', waitedMs: 5000, epoch: 1 };
    timers.arm('L1', 'waiting', 5000); // epoch 2
    t.mock.timers.tick(5000);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].epoch, 2);
    assert.equal(timers.stripStale(staleFrame, 'L1'), null);
    t.mock.timers.reset();
  });

  await t.test('stripStale: fresh passes, stale drops, batch keeps real events', () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const timers = new StateTimers(() => {});
    timers.arm('L1', 'waiting', 5000);
    const armed = (timers as any)._timers.get('L1').epoch as number;
    const fresh = { type: 'state-timeout', state: 'waiting', waitedMs: 5000, epoch: armed };
    const stale = { type: 'state-timeout', state: 'waiting', waitedMs: 5000, epoch: armed - 1 };
    const msg = { type: 'message', text: 'hi', senderId: 'u1' };
    assert.deepEqual(timers.stripStale(fresh, 'L1'), fresh);
    assert.equal(timers.stripStale(stale, 'L1'), null);
    // batch [stale, msg] → the message survives, unwrapped
    assert.deepEqual(timers.stripStale({ type: 'batch', events: [stale, msg] }, 'L1'), msg);
    // batch [fresh, msg] → both kept
    assert.deepEqual(timers.stripStale({ type: 'batch', events: [fresh, msg] }, 'L1'), { type: 'batch', events: [fresh, msg] });
    // batch of only stale → null
    assert.equal(timers.stripStale({ type: 'batch', events: [stale] }, 'L1'), null);
    t.mock.timers.reset();
  });

  await t.test('clearAll cancels every armed lane', () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fired: StateTimeoutEvent[] = [];
    const timers = new StateTimers((ev) => fired.push(ev));
    timers.arm('L1', 'a', 5000);
    timers.arm('L2', 'b', 5000);
    timers.clearAll();
    t.mock.timers.tick(10000);
    assert.equal(fired.length, 0);
    t.mock.timers.reset();
  });
});
