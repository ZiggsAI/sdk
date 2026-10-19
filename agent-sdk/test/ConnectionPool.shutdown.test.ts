/**
 * A rolling deploy runs two hosts at once, and both are handed the same
 * delivery unless the one going away stops taking work. Measured on prod
 * 2026-08-16: one buyer request, two different result artifacts 65s apart.
 *
 * The ordering below is the fix, so it is what these tests pin. Draining first
 * and stopping intake afterwards is not a style choice — the wait IS the window.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConnectionPool } from '../src/platform/ConnectionPool.js';

/** A host that records when intake stopped and when its turn finished. */
function fakeHost(log: string[], id: string, turnMs: number) {
  let stopped = false;
  return {
    id,
    get stopped() {
      return stopped;
    },
    disconnect() {
      stopped = true;
      log.push(`stop:${id}`);
    },
    // Mirrors Agent.drain: waits for the turn, but gives up at timeoutMs
    // rather than blocking a shutdown that is on a clock of its own.
    async drain(timeoutMs: number) {
      const finished = await Promise.race([
        new Promise((r) => setTimeout(() => r(true), turnMs)),
        new Promise((r) => setTimeout(() => r(false), timeoutMs)),
      ]);
      if (finished) log.push(`drained:${id}`);
    },
  };
}

/**
 * Drives the pool's real shutdown against fake hosts. `register` builds hosts
 * itself, so the private map is seeded directly — the contract under test is
 * the order of stop-vs-drain, not how a host is constructed.
 */
function poolWith(hosts: ReturnType<typeof fakeHost>[]) {
  const pool = new ConnectionPool();
  const inner = pool as unknown as {
    hosts: Map<string, unknown>;
    manager: { stopAll(): Promise<void> };
  };
  for (const h of hosts) inner.hosts.set(h.id, h);
  inner.manager = {
    async stopAll() {
      for (const h of hosts) h.disconnect();
    },
  };
  return pool;
}

describe('ConnectionPool.shutdown', () => {
  it('stops intake on EVERY agent before waiting on any turn', async () => {
    const log: string[] = [];
    // The slow host is the one whose drain would have covered for the others.
    const hosts = [fakeHost(log, 'slow', 40), fakeHost(log, 'fast', 1)];
    await poolWith(hosts).shutdown(1_000);

    const firstDrain = log.findIndex((l) => l.startsWith('drained:'));
    const lastStop = log.map((l) => l.startsWith('stop:')).lastIndexOf(true);
    assert.equal(
      log.filter((l) => l.startsWith('stop:')).length,
      2,
      'both agents must stop taking work',
    );
    assert.ok(
      lastStop < firstDrain,
      `every stop must land before the first drain completes — got ${log.join(', ')}`,
    );
    assert.ok(
      hosts.every((h) => h.stopped),
      'an agent still polling during shutdown is the duplicate-delivery window',
    );
  });

  it('waits for in-flight turns rather than abandoning them', async () => {
    const log: string[] = [];
    await poolWith([fakeHost(log, 'a', 20), fakeHost(log, 'b', 30)]).shutdown(
      1_000,
    );
    assert.ok(log.includes('drained:a'), 'turn a was abandoned');
    assert.ok(log.includes('drained:b'), 'turn b was abandoned');
  });

  it('one host that will not finish does not hold up the rest', async () => {
    const log: string[] = [];
    const hosts = [fakeHost(log, 'wedged', 5_000), fakeHost(log, 'ok', 1)];
    // Resolves on the timeout instead of the wedged host, and does not throw.
    await poolWith(hosts).shutdown(30);
    assert.ok(log.includes('drained:ok'));
    assert.ok(
      hosts.every((h) => h.stopped),
      'intake stops even for a host that cannot drain',
    );
  });
});
