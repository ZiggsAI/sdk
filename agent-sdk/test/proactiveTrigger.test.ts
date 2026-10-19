import { test } from 'node:test';
import assert from 'node:assert/strict';

const CREDS = { operatorKey: 'opk.test', agentId: 'agent-test' };

test('ProactiveTrigger', async (t) => {
  const mockPublishOffer = t.mock.fn(async () => ({}));
  const mockPullOffers   = t.mock.fn(async () => []);
  const mockClaimAgreement = t.mock.fn(async () => ({ agreement: {}, kind: 'offer' }));

  t.mock.module('@ziggs-ai/api-client', {
    namedExports: {
      publishOffer: mockPublishOffer,
      pullOffers:   mockPullOffers,
      claimOpenAgreement: mockClaimAgreement,
      runtimeLog: { debug() {}, info() {}, warn() {}, error() {} },
      resetRuntimeLogLevelCache() {},
    },
  });

  const { ProactiveTrigger } = await import('../src/platform/proactive/ProactiveTrigger.js');

  // ── Constructor validation ──────────────────────────────────────────────────

  await t.test('throws when interval is below 1000ms', () => {
    assert.throws(
      () => new ProactiveTrigger({ interval: 500, creds: CREDS, onTick: async () => {} }),
      /interval must be a number >= 1000ms/,
    );
  });

  await t.test('throws when interval is not a number', () => {
    assert.throws(
      () => new ProactiveTrigger({ interval: '5000' as unknown as number, creds: CREDS, onTick: async () => {} }),
      /interval must be a number >= 1000ms/,
    );
  });

  await t.test('throws when creds.operatorKey is missing', () => {
    assert.throws(
      () => new ProactiveTrigger({ interval: 5000, creds: { agentId: 'a' } as any, onTick: async () => {} }),
      /operatorKey/,
    );
  });

  await t.test('throws when creds.agentId is missing', () => {
    assert.throws(
      () => new ProactiveTrigger({ interval: 5000, creds: { operatorKey: 'k' } as any, onTick: async () => {} }),
      /agentId/,
    );
  });

  await t.test('throws when onTick is not a function', () => {
    assert.throws(
      () => new ProactiveTrigger({ interval: 5000, creds: CREDS, onTick: 'not-a-fn' as any }),
      /onTick must be a function/,
    );
  });

  await t.test('accepts valid config and initialises as stopped', () => {
    const trigger = new ProactiveTrigger({ interval: 5000, creds: CREDS, onTick: async () => {} });
    assert.equal((trigger as any)._running, false);
    assert.equal((trigger as any).interval, 5000);
    assert.deepEqual((trigger as any).creds, CREDS);
  });

  // ── start / stop ────────────────────────────────────────────────────────────

  await t.test('start sets _running to true', () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const trigger = new ProactiveTrigger({ interval: 5000, creds: CREDS, onTick: async () => {} });
    trigger.start();
    assert.equal((trigger as any)._running, true);
    trigger.stop();
    t.mock.timers.reset();
  });

  await t.test('calling start() twice is idempotent', () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const onTick = t.mock.fn(async () => {});
    const trigger = new ProactiveTrigger({ interval: 5000, creds: CREDS, onTick });
    trigger.start();
    trigger.start(); // second call should be a no-op
    t.mock.timers.tick(5000);
    assert.equal(onTick.mock.calls.length, 1, 'onTick called more than once from double start');
    trigger.stop();
    t.mock.timers.reset();
  });

  await t.test('stop sets _running to false and clears the timer', () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const trigger = new ProactiveTrigger({ interval: 5000, creds: CREDS, onTick: async () => {} });
    trigger.start();
    trigger.stop();
    assert.equal((trigger as any)._running, false);
    assert.equal((trigger as any)._timer, null);
    t.mock.timers.reset();
  });

  // ── Tick scheduling ─────────────────────────────────────────────────────────

  await t.test('onTick is called after the interval elapses', async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const onTick = t.mock.fn(async () => {});
    const trigger = new ProactiveTrigger({ interval: 5000, creds: CREDS, onTick });

    trigger.start();
    assert.equal(onTick.mock.calls.length, 0, 'onTick must not fire before interval');

    t.mock.timers.tick(5000);
    await Promise.resolve(); // flush microtasks so async _tick() runs

    assert.equal(onTick.mock.calls.length, 1);
    trigger.stop();
    t.mock.timers.reset();
  });

  await t.test('onTick is re-scheduled after each call', async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const onTick = t.mock.fn(async () => {});
    const trigger = new ProactiveTrigger({ interval: 5000, creds: CREDS, onTick });

    trigger.start();
    t.mock.timers.tick(5000);
    await Promise.resolve(); // first tick completes, re-schedules
    t.mock.timers.tick(5000);
    await Promise.resolve(); // second tick completes

    assert.equal(onTick.mock.calls.length, 2);
    trigger.stop();
    t.mock.timers.reset();
  });

  await t.test('runImmediately fires onTick without waiting for interval', async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const onTick = t.mock.fn(async () => {});
    const trigger = new ProactiveTrigger({
      interval: 5000,
      creds: CREDS,
      onTick,
      runImmediately: true,
    });

    trigger.start();
    await Promise.resolve(); // flush the immediate tick

    assert.equal(onTick.mock.calls.length, 1, 'onTick should fire immediately on start');
    trigger.stop();
    t.mock.timers.reset();
  });

  await t.test('stop prevents further ticks after the running one', async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const onTick = t.mock.fn(async () => {});
    const trigger = new ProactiveTrigger({ interval: 5000, creds: CREDS, onTick });

    trigger.start();
    t.mock.timers.tick(5000);
    await Promise.resolve();
    trigger.stop();
    // Advance clock again — no new tick should fire
    t.mock.timers.tick(5000);
    await Promise.resolve();

    assert.equal(onTick.mock.calls.length, 1, 'onTick must not fire after stop');
    t.mock.timers.reset();
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  await t.test('errors in onTick are forwarded to onError and tick continues', async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const boom = new Error('tick exploded');
    const onTick  = t.mock.fn(async () => { throw boom; });
    const onError = t.mock.fn(() => {});
    const trigger = new ProactiveTrigger({ interval: 5000, creds: CREDS, onTick, onError });

    trigger.start();
    t.mock.timers.tick(5000);
    await Promise.resolve();

    assert.equal(onError.mock.calls.length, 1);
    assert.equal((onError.mock.calls as Array<{ arguments: unknown[] }>)[0].arguments[0], boom);
    // Trigger reschedules even after error — confirm _running is still true
    assert.equal((trigger as any)._running, true);
    trigger.stop();
    t.mock.timers.reset();
  });

  // ── Context ─────────────────────────────────────────────────────────────────

  await t.test('onTick receives ctx with agentId and marketplace helpers', async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let capturedCtx: unknown;
    const onTick = t.mock.fn(async (ctx: unknown) => { capturedCtx = ctx; });
    const trigger = new ProactiveTrigger({ interval: 5000, creds: CREDS, onTick: onTick as any });

    trigger.start();
    t.mock.timers.tick(5000);
    await Promise.resolve();

    const ctx = capturedCtx as Record<string, unknown>;
    assert.ok(ctx);
    assert.equal(ctx.agentId, CREDS.agentId);
    assert.equal(typeof (ctx.marketplace as Record<string, unknown>).publishOffer, 'function');
    assert.equal(typeof (ctx.marketplace as Record<string, unknown>).pullOffers, 'function');
    assert.equal(typeof (ctx.marketplace as Record<string, unknown>).claimAgreement, 'function');
    trigger.stop();
    t.mock.timers.reset();
  });

  await t.test('marketplace.publishOffer in ctx delegates to api-client', async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockPublishOffer.mock.resetCalls();
    let capturedCtx: unknown;
    const onTick = t.mock.fn(async (ctx: unknown) => { capturedCtx = ctx; });
    const trigger = new ProactiveTrigger({ interval: 5000, creds: CREDS, onTick: onTick as any });

    trigger.start();
    t.mock.timers.tick(5000);
    await Promise.resolve();
    trigger.stop();
    t.mock.timers.reset();

    const ctx = capturedCtx as Record<string, unknown>;
    assert.ok(ctx);
    await (ctx.marketplace as Record<string, (arg: unknown) => Promise<unknown>>).publishOffer({ description: 'offer' });
    assert.equal(mockPublishOffer.mock.calls.length, 1);
    assert.deepEqual((mockPublishOffer.mock.calls as Array<{ arguments: unknown[] }>)[0].arguments[1], CREDS);
  });
});
