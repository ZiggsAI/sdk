/**
 * ZIG-1771: one host that cannot start must not abort the fleet. Zero
 * started still refuses — the process has nothing to host.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConnectionPool } from '../src/platform/ConnectionPool.js';
import type { AgentOptions } from '../src/Agent.js';

function parked(agentId: string, extra: Partial<AgentOptions> = {}): AgentOptions {
  return {
    agentId,
    operatorKey: 'test-key',
    anthropicKey: 'test-key',
    inboxCatchUp: false,
    telemetryIngest: false,
    initial: 'idle',
    states: { idle: { kind: 'parked', transitions: [] } },
    ...extra,
  };
}

describe('ConnectionPool.connectAll', () => {
  it('a replacement starts only after the stopped host released its lease', async () => {
    const pool = new ConnectionPool();
    pool.register([parked('agent')]);
    const old = await pool.startAgent('agent');
    const order: string[] = [];
    let finish!: () => void;
    const releasing = new Promise<boolean>((resolve) => { finish = () => { order.push('released'); resolve(true); }; });
    (old as unknown as { inboxLoop: { stop(): Promise<boolean> } }).inboxLoop = { stop: () => releasing };
    const stopped = pool.stopAgent('agent').then(() => { order.push('stopped'); });
    await Promise.resolve();
    assert.deepEqual(order, [], 'stopAgent resolves only once the lease is released');
    finish();
    await stopped;
    const next = await pool.startAgent('agent');
    assert.notEqual(next, old);
    assert.deepEqual(order, ['released', 'stopped']);
    await pool.shutdown(50);
  });

  it('shutdown hands its budget to each host and drains with what is left', async () => {
    const pool = new ConnectionPool();
    pool.register([parked('agent')]);
    const host = await pool.startAgent('agent');
    const budgets: number[] = [];
    (host as unknown as { inboxLoop: { stop(ms?: number): Promise<boolean> } }).inboxLoop = {
      stop: async (ms) => { budgets.push(ms!); return false; },
    };
    await pool.shutdown(250);
    assert.deepEqual(budgets, [250]);
    assert.deepEqual(pool.listActive(), []);
    assert.deepEqual(pool.liveness(), []);
  });

  it('one agent that cannot start does not refuse the rest', async () => {
    const pool = new ConnectionPool();
    pool.register([
      parked('good'),
      parked('bad', { polls: 'not-an-array' as unknown as AgentOptions['polls'] }),
    ]);
    await pool.connectAll();
    try {
      assert.deepEqual(pool.listActive(), ['good']);
    } finally {
      await pool.shutdown(50);
    }
  });

  it('zero agents started still refuses', async () => {
    const pool = new ConnectionPool();
    pool.register([
      parked('a', { polls: 'not-an-array' as unknown as AgentOptions['polls'] }),
      parked('b', { polls: 'not-an-array' as unknown as AgentOptions['polls'] }),
    ]);
    await assert.rejects(pool.connectAll(), /0\/2 agents started/);
  });
});
