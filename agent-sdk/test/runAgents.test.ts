import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { runAgents } from '../src/launcher/runAgents.js';
import { inboxHealth, type AgentLiveness } from '../src/launcher/createHealthServer.js';
import type { AgentOptions } from '../src/Agent.js';

function config(agentId: string, polled: string[]): AgentOptions {
  return {
    agentId, operatorKey: 'test-key', anthropicKey: 'test-key',
    inboxCatchUp: false, telemetryIngest: false,
    initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } },
    polls: [{ kind: 'mail', chatId: 'triage' }],
    pollKinds: [{ id: 'mail', intervalMs: 5, async poll() {
      polled.push(agentId);
      return { actionable: false };
    } }],
  };
}

it('single process starts polls and health, and exposes idempotent shutdown', async () => {
  const polled: string[] = [];
  let shutdowns = 0;
  const run = await runAgents(config('single', polled), {
    port: 0, handleSignals: false, onShutdown: async () => { shutdowns++; },
  });
  try {
    const port = (run.healthServer!.address() as AddressInfo).port;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    // This agent has inboxCatchUp off, so there is no inbox reading to be
    // stale about and the process is healthy with nothing watched.
    assert.deepEqual(
      (await health.json() as { ok: boolean; watching: number }),
      { ok: true, staleMs: 360_000, watching: 0, oldestAttemptAgeMs: null, oldestPassAgeMs: null,
        agents: [{ agentId: 'single', connected: true, pollingInbox: false, lastPassAt: null,
          lastAttemptAt: null, passAgeMs: null, attemptAgeMs: null }] } as never,
    );
    assert.equal((await fetch(`http://127.0.0.1:${port}/missing`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/fleet-deliver`, { method: 'POST' })).status, 404);
    await delay(25);
    assert.ok(polled.includes('single'));
    await Promise.all([run.shutdown(), run.shutdown()]);
    const count = polled.length;
    await delay(20);
    assert.equal(polled.length, count);
    assert.equal(shutdowns, 1);
    assert.equal(run.healthServer!.listening, false);
    assert.equal(run.agent.isConnected(), false);
  } finally { await run.shutdown(); }
});

it('fleet, including its primary, runs declared polls and stops every agent', async () => {
  const polled: string[] = [];
  const run = await runAgents([config('a', polled), config('b', polled)], {
    healthServer: false, handleSignals: false, primary: config('primary', polled),
  });
  try {
    await delay(30);
    assert.deepEqual([...new Set(polled)].sort(), ['a', 'b', 'primary']);
    await run.shutdown();
    const count = polled.length;
    await delay(20);
    assert.equal(polled.length, count);
    assert.equal(run.pool.listActive().length, 0);
    assert.equal(run.primary!.isConnected(), false);
  } finally { await run.shutdown(); }
});

it('an invalid poll on one agent does not stop the others from starting (ZIG-1771)', async () => {
  const polled: string[] = [];
  const bad = { ...config('bad', polled), pollKinds: [] };
  const run = await runAgents([config('good', polled), bad], {
    healthServer: false, handleSignals: false,
  });
  try {
    assert.deepEqual(run.pool.listActive().sort(), ['bad', 'good']);
    await delay(30);
    assert.ok(polled.includes('good'), 'the healthy agent must still poll');
    assert.ok(!polled.includes('bad'), 'the invalid poll must not run');
  } finally {
    await run.shutdown();
  }
});

it('a fleet where nobody started still rejects', async () => {
  const broken = (agentId: string): AgentOptions => ({
    ...config(agentId, []),
    polls: 'not-an-array' as unknown as AgentOptions['polls'],
  });
  await assert.rejects(runAgents([broken('a'), broken('b')], {
    healthServer: false, handleSignals: false,
  }), /0\/2 agents started/);
});

/**
 * The health verdict itself (ZIG-1738). The route used to answer "ok" as long
 * as this HTTP server replied, which a wedged process does happily while none
 * of its agents read anything. These pin the two halves apart: a loop that has
 * stopped turning is this process failing, and a backend that is down is not.
 */
const NOW = 1_000_000_000;
const row = (over: Partial<AgentLiveness> = {}): AgentLiveness => ({
  agentId: 'a', connected: true, pollingInbox: true,
  lastPassAt: NOW - 1_000, lastAttemptAt: NOW - 1_000, ...over,
});

it('the health page does not start an agent; the embedding process may add that route', async () => {
  const bare = await runAgents([config('a', [])], { port: 0, handleSignals: false });
  try {
    const port = (bare.healthServer!.address() as AddressInfo).port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/fleet-start/a`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/fleet-deliver`, { method: 'POST' })).status, 404);
  } finally { await bare.shutdown(); }

  const added = await runAgents([config('a', [])], {
    port: 0,
    handleSignals: false,
    onRequest: async ({ req, res }) => {
      if (req.method === 'POST' && req.url === '/fleet-start/a') {
        res.writeHead(204);
        res.end();
        return true;
      }
      return false;
    },
  });
  try {
    const port = (added.healthServer!.address() as AddressInfo).port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/fleet-start/a`, { method: 'POST' })).status, 204);
    assert.equal((await fetch(`http://127.0.0.1:${port}/fleet-deliver`, { method: 'POST' })).status, 404);
  } finally { await added.shutdown(); }
});

it('healthy while at least one agent is still turning its inbox loop', () => {
  const report = inboxHealth([row()], NOW);
  assert.equal(report.ok, true);
  assert.equal(report.watching, 1);
  assert.equal(report.oldestPassAgeMs, 1_000);
});

it('unhealthy when no watched agent has attempted a pass inside the window', () => {
  const report = inboxHealth([row({ lastAttemptAt: NOW - 400_000, lastPassAt: NOW - 400_000 })], NOW);
  assert.equal(report.ok, false);
  assert.match(report.reason!, /no inbox pass attempted by any of 1 agent/);
  assert.equal(report.oldestAttemptAgeMs, 400_000);
});

it('a backend outage is not this process failing: attempts turn, passes do not land', () => {
  const report = inboxHealth([row({ lastAttemptAt: NOW - 2_000, lastPassAt: NOW - 900_000 })], NOW);
  assert.equal(report.ok, true);
  assert.equal(report.oldestPassAgeMs, 900_000);
});

it('one wedged agent does not restart a process whose others still read', () => {
  const report = inboxHealth(
    [row({ agentId: 'stuck', lastAttemptAt: NOW - 500_000 }), row({ agentId: 'fine' })],
    NOW,
  );
  assert.equal(report.ok, true);
  assert.equal(report.agents.find((a) => a.agentId === 'stuck')?.attemptAgeMs, 500_000);
});

it('agents that do not poll, or are disconnected, are not watched', () => {
  const off = inboxHealth([row({ pollingInbox: false, lastAttemptAt: null, lastPassAt: null })], NOW);
  assert.equal(off.ok, true);
  assert.equal(off.watching, 0);
  const gone = inboxHealth([row({ connected: false, lastAttemptAt: NOW - 900_000 })], NOW);
  assert.equal(gone.ok, true);
  assert.equal(gone.watching, 0);
});

it('an empty process is healthy: there is nothing to be stale about', () => {
  assert.equal(inboxHealth([], NOW).ok, true);
});
