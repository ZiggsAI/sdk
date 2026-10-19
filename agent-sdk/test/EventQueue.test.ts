import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue } from '../src/platform/EventQueue.js';

describe('EventQueue', () => {
  it('coalesces queued events while a lane is already processing', async () => {
    const calls: Array<{ event: Record<string, unknown>; laneKey: string }> = [];
    const queue = new EventQueue(async (event, laneKey) => {
      calls.push({ event: event as Record<string, unknown>, laneKey });
      await new Promise((r) => setTimeout(r, 10));
    });

    const p1 = queue.enqueue({ type: 'message', text: 'a' }, 'lane-1');
    const p2 = queue.enqueue({ type: 'message', text: 'b' }, 'lane-1');
    const p3 = queue.enqueue({ type: 'message', text: 'c' }, 'lane-1');
    await Promise.all([p1, p2, p3]);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].laneKey, 'lane-1');
    assert.equal(calls[1].laneKey, 'lane-1');
    assert.equal(calls[0].event.type, 'message');
    assert.equal(calls[1].event.type, 'batch');
    assert.equal((calls[1].event.events as unknown[]).length, 2);
  });

  // The lane survives a failed batch and keeps draining, but the failure is no
  // longer swallowed: ZIG-1191 made enqueue reject so the caller holding the
  // delivery can hold its ack instead of losing the wake.
  it('continues processing later events even if previous batch throws, and reports the failure', async () => {
    let callCount = 0;
    const seen: string[] = [];
    const queue = new EventQueue(async (event) => {
      callCount += 1;
      seen.push((event as Record<string, unknown>)['type'] as string);
      if (callCount === 1) {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error('boom');
      }
    });

    const p1 = queue.enqueue({ type: 'first' }, 'lane-2');
    await new Promise((r) => setTimeout(r, 1));
    const p2 = queue.enqueue({ type: 'second' }, 'lane-2');

    await assert.rejects(p1, /boom/);
    await p2;

    assert.equal(callCount, 2);
    assert.deepEqual(seen, ['first', 'second']);
  });

  it('waitForIdle resolves immediately when queue is empty', async () => {
    const queue = new EventQueue(async () => {});
    const result = await queue.waitForIdle(1_000);
    assert.equal(result.idle, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.queuedEvents, 0);
    assert.deepEqual(result.busyLanes, []);
    assert.ok(queue.isIdle);
  });

  it('waitForIdle resolves after in-flight tick completes', async () => {
    let processingDone = false;
    const queue = new EventQueue(async () => {
      await new Promise((r) => setTimeout(r, 30));
      processingDone = true;
    });

    queue.enqueue({ type: 'msg' }, 'lane-idle');
    assert.equal(queue.isIdle, false);

    const result = await queue.waitForIdle(1_000);
    assert.equal(result.idle, true);
    assert.equal(result.timedOut, false);
    assert.ok(processingDone);
    assert.ok(queue.isIdle);
  });

  it('waitForIdle timeout is returned as data naming the busy lane, not thrown', async () => {
    const queue = new EventQueue(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    const pending = queue.enqueue({ type: 'slow' }, 'agt_1:sess');
    const result = await queue.waitForIdle(80);
    assert.equal(result.timedOut, true);
    assert.equal(result.idle, false);
    assert.equal(result.timeoutMs, 80);
    assert.equal(result.busyLanes.length, 1);
    assert.equal(result.busyLanes[0].laneKey, 'agt_1:sess');
    assert.equal(result.busyLanes[0].processing, true);
    await pending;
  });

  it('waitForIdle timeout counts events still queued behind an in-flight turn', async () => {
    const queue = new EventQueue(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    const first = queue.enqueue({ type: 'a' }, 'agt:s');
    await new Promise((r) => setTimeout(r, 10));
    const second = queue.enqueue({ type: 'b' }, 'agt:s');
    const result = await queue.waitForIdle(50);
    assert.equal(result.timedOut, true);
    assert.ok(result.queuedEvents >= 1);
    assert.equal(result.busyLanes[0]?.laneKey, 'agt:s');
    await Promise.all([first, second]);
  });

  it('waitForIdle(0) returns immediately: idle if empty, timed out if a turn is in flight', async () => {
    const idle = new EventQueue(async () => {});
    const idleResult = await idle.waitForIdle(0);
    assert.equal(idleResult.idle, true);
    assert.equal(idleResult.timedOut, false);

    const busy = new EventQueue(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const pending = busy.enqueue({ type: 'x' }, 'lane');
    const busyResult = await busy.waitForIdle(0);
    assert.equal(busyResult.timedOut, true);
    assert.equal(busyResult.idle, false);
    await pending;
  });

  it('drops oldest queued events when lane exceeds max queue length', async () => {
    type TestEvent = { type: string; events?: Array<{ type: string }> };
    const seen: TestEvent[] = [];
    const queue = new EventQueue(async (event) => {
      seen.push(event as TestEvent);
      await new Promise((r) => setTimeout(r, 10));
    }, { maxQueueLengthPerLane: 2 });

    const p1 = queue.enqueue({ type: 'e1' }, 'lane-3');
    const p2 = queue.enqueue({ type: 'e2' }, 'lane-3');
    const p3 = queue.enqueue({ type: 'e3' }, 'lane-3');
    const p4 = queue.enqueue({ type: 'e4' }, 'lane-3');

    // e2 fell off the queue, so its caller is told (ZIG-1191) rather than being
    // left to believe the event was handled.
    await assert.rejects(p2, /dropped an event/);
    await Promise.all([p1, p3, p4]);

    assert.equal(seen.length, 2);
    assert.equal(seen[0].type, 'e1');
    assert.equal(seen[1].type, 'batch');
    assert.deepEqual(seen[1].events?.map((e) => e.type), ['e3', 'e4']);

    const metrics = queue.getMetrics();
    assert.equal(metrics.dropped, 1);
    assert.equal(metrics.processedEvents, 3);
  });
});

