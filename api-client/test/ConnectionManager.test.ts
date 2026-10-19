import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionManager } from '../src/ConnectionManager.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(handle: object = {}) {
  const openFn  = async () => handle;
  const closeFn = async (_h: unknown) => {};
  return { openFn, closeFn, handle };
}

// ── register ──────────────────────────────────────────────────────────────────

describe('ConnectionManager — no operator multiplex (ZIG-1192)', () => {
  it('exposes no start(operatorKey) poll entrypoint', () => {
    const mgr = new ConnectionManager();
    assert.equal(typeof (mgr as { start?: unknown }).start, 'undefined');
  });
});

describe('ConnectionManager.register', () => {
  it('throws when id is missing', () => {
    const mgr = new ConnectionManager();
    assert.throws(
      () => mgr.register(null as unknown as string, async () => {}, async () => {}),
      /id is required/,
    );
  });

  it('throws when openFn is not a function', () => {
    const mgr = new ConnectionManager();
    assert.throws(
      () => mgr.register('a', 'not-fn' as unknown as () => Promise<unknown>, async () => {}),
      /openFn must be a function/,
    );
  });

  it('throws when closeFn is not a function', () => {
    const mgr = new ConnectionManager();
    assert.throws(
      () => mgr.register('a', async () => {}, 'not-fn' as unknown as (_: unknown) => Promise<void>),
      /closeFn must be a function/,
    );
  });

  it('increments size after registration', () => {
    const mgr = new ConnectionManager();
    const { openFn, closeFn } = makeEntry();
    assert.equal(mgr.size, 0);
    mgr.register('agent-1', openFn, closeFn);
    assert.equal(mgr.size, 1);
  });

  it('stores optional metadata retrievable via getMeta', () => {
    const mgr  = new ConnectionManager();
    const meta = { domain: 'science', tags: ['nlp'] };
    mgr.register('agent-1', async () => {}, async () => {}, meta);
    assert.deepEqual(mgr.getMeta('agent-1'), meta);
  });
});

// ── startAgent ─────────────────────────────────────────────────────────────────

describe('ConnectionManager.startAgent', () => {
  it('calls openFn and returns its handle', async (t) => {
    const handle = { id: 'h1' };
    const openFn = t.mock.fn(async () => handle);
    const mgr = new ConnectionManager();
    mgr.register('agent-1', openFn, async () => {});

    const result = await mgr.startAgent('agent-1');

    assert.equal(result, handle);
    assert.equal(openFn.mock.calls.length, 1);
    await mgr.stopAll();
  });

  it('returns cached handle on repeated wake without calling openFn again', async (t) => {
    const openFn = t.mock.fn(async () => ({}));
    const mgr = new ConnectionManager();
    mgr.register('agent-1', openFn, async () => {});

    const first  = await mgr.startAgent('agent-1');
    const second = await mgr.startAgent('agent-1');

    assert.equal(first, second);
    assert.equal(openFn.mock.calls.length, 1);
    await mgr.stopAll();
  });

  it('adds id to listActive after wake', async () => {
    const mgr = new ConnectionManager();
    mgr.register('agent-1', async () => ({}), async () => {});

    await mgr.startAgent('agent-1');

    assert.deepEqual(mgr.listActive(), ['agent-1']);
    await mgr.stopAll();
  });

  it('throws for an unregistered id', async () => {
    const mgr = new ConnectionManager();
    await assert.rejects(
      () => mgr.startAgent('ghost'),
      /unknown id: "ghost"/,
    );
  });

  it('concurrent startAgent() calls return the same handle and call openFn exactly once (ZIG-405)', async (t) => {
    const handle = { id: 'h-shared' };
    const openFn = t.mock.fn(async () => handle);
    const mgr = new ConnectionManager();
    mgr.register('agent-1', openFn, async () => {});

    const [r1, r2, r3] = await Promise.all([
      mgr.startAgent('agent-1'),
      mgr.startAgent('agent-1'),
      mgr.startAgent('agent-1'),
    ]);

    assert.equal(r1, handle);
    assert.equal(r2, handle);
    assert.equal(r3, handle);
    assert.equal(openFn.mock.calls.length, 1, 'openFn must be called exactly once despite concurrent wakes');
    await mgr.stopAll();
  });
});

// ── stopAgent ─────────────────────────────────────────────────────────────────────

describe('ConnectionManager.stopAgent', () => {
  it('calls closeFn with the handle and removes from active', async (t) => {
    const handle  = { id: 'h1' };
    const closeFn = t.mock.fn(async () => {});
    const mgr = new ConnectionManager();
    mgr.register('agent-1', async () => handle, closeFn);

    await mgr.startAgent('agent-1');
    await mgr.stopAgent('agent-1');

    assert.equal(closeFn.mock.calls.length, 1);
    assert.equal((closeFn.mock.calls as Array<{ arguments: unknown[] }>)[0].arguments[0], handle);
    assert.deepEqual(mgr.listActive(), []);
  });

  it('is a no-op when the id is not active', async (t) => {
    const closeFn = t.mock.fn(async () => {});
    const mgr = new ConnectionManager();
    mgr.register('agent-1', async () => ({}), closeFn);

    await mgr.stopAgent('agent-1'); // never started — should not throw

    assert.equal(closeFn.mock.calls.length, 0);
  });
});

// ── stopAll ──────────────────────────────────────────────────────────────────

describe('ConnectionManager.stopAll', () => {
  it('closes all active handles', async (t) => {
    const close1 = t.mock.fn(async () => {});
    const close2 = t.mock.fn(async () => {});
    const mgr = new ConnectionManager();
    mgr.register('agent-1', async () => ({}), close1);
    mgr.register('agent-2', async () => ({}), close2);

    await mgr.startAgent('agent-1');
    await mgr.startAgent('agent-2');
    await mgr.stopAll();

    assert.deepEqual(mgr.listActive(), []);
    assert.equal(close1.mock.calls.length, 1);
    assert.equal(close2.mock.calls.length, 1);
  });
});

// ── list / listActive / size ──────────────────────────────────────────────────

describe('ConnectionManager introspection', () => {
  it('list returns all registered ids', () => {
    const mgr = new ConnectionManager();
    mgr.register('a', async () => {}, async () => {});
    mgr.register('b', async () => {}, async () => {});
    assert.deepEqual(mgr.list().sort(), ['a', 'b']);
  });

  it('listActive returns only woken ids', async () => {
    const mgr = new ConnectionManager();
    mgr.register('a', async () => ({}), async () => {});
    mgr.register('b', async () => ({}), async () => {});

    await mgr.startAgent('a');

    assert.deepEqual(mgr.listActive(), ['a']);
    await mgr.stopAll();
  });

  it('size reflects the number of registered entries', () => {
    const mgr = new ConnectionManager();
    mgr.register('x', async () => {}, async () => {});
    assert.equal(mgr.size, 1);
  });
});

// ── query ─────────────────────────────────────────────────────────────────────

describe('ConnectionManager.query', () => {
  function setupMgr() {
    const mgr = new ConnectionManager();
    mgr.register('a1', async () => {}, async () => {}, { domain: 'science', expertise: ['nlp', 'cv'], tags: ['fast'] });
    mgr.register('a2', async () => {}, async () => {}, { domain: 'arts',    expertise: ['music'],    tags: ['slow'] });
    mgr.register('a3', async () => {}, async () => {}, { domain: 'science', expertise: ['cv'],       tags: ['fast', 'gpu'] });
    return mgr;
  }

  it('returns all meta-registered ids when no filter given', () => {
    const mgr = setupMgr();
    assert.equal(mgr.query().length, 3);
  });

  it('filters by exact domain', () => {
    const result = setupMgr().query({ domain: 'science' }).sort();
    assert.deepEqual(result, ['a1', 'a3']);
  });

  it('filters by expertise (at least one match)', () => {
    const result = setupMgr().query({ expertise: ['nlp'] });
    assert.deepEqual(result, ['a1']);
  });

  it('filters by tags (at least one match)', () => {
    const result = setupMgr().query({ tags: ['gpu'] });
    assert.deepEqual(result, ['a3']);
  });

  it('combines domain + expertise filters', () => {
    const result = setupMgr().query({ domain: 'science', expertise: ['cv'] }).sort();
    assert.deepEqual(result, ['a1', 'a3']);
  });

  it('returns empty array when no ids match', () => {
    assert.deepEqual(setupMgr().query({ domain: 'sports' }), []);
  });

  it('getMeta returns undefined for id with no metadata', () => {
    const mgr = new ConnectionManager();
    mgr.register('bare', async () => {}, async () => {}); // no meta
    assert.equal(mgr.getMeta('bare'), undefined);
  });
});

// ── connectAll ────────────────────────────────────────────────────────────────
//
// ZIG-1108: the launcher hosts every agent it was handed. There is no subset to
// choose, so "connected" must equal "registered" after a launch — and a single
// host that cannot come up must not take the other 28 with it.

describe('ConnectionManager.connectAll', () => {
  it('connects every registered agent', async () => {
    const opened: string[] = [];
    const mgr = new ConnectionManager();
    for (const id of ['a', 'b', 'c']) {
      mgr.register(id, async () => { opened.push(id); return {}; }, async () => {});
    }

    await mgr.connectAll();

    assert.deepEqual(opened.sort(), ['a', 'b', 'c']);
    assert.deepEqual(mgr.listActive().sort(), ['a', 'b', 'c']);
    await mgr.stopAll();
  });

  it('one agent that cannot connect does not stop the rest', async () => {
    const mgr = new ConnectionManager();
    mgr.register('ok-1', async () => ({}), async () => {});
    mgr.register('broken', async () => { throw new Error('backend refused'); }, async () => {});
    mgr.register('ok-2', async () => ({}), async () => {});

    await mgr.connectAll();

    assert.deepEqual(mgr.listActive().sort(), ['ok-1', 'ok-2']);
    await mgr.stopAll();
  });

  it('is idempotent — a second pass opens nothing again', async (t) => {
    const openFn = t.mock.fn(async () => ({}));
    const mgr = new ConnectionManager();
    mgr.register('a', openFn, async () => {});

    await mgr.connectAll();
    await mgr.connectAll();

    assert.equal(openFn.mock.calls.length, 1);
    await mgr.stopAll();
  });

  it('holds every host up — nothing stops on its own', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const closeFn = t.mock.fn(async () => {});
    const mgr = new ConnectionManager();
    mgr.register('a', async () => ({}), closeFn);

    await mgr.connectAll();
    t.mock.timers.tick(60 * 60_000);
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(mgr.listActive(), ['a'], 'a quiet host is still a hosted host');
    assert.equal(closeFn.mock.calls.length, 0);
    t.mock.timers.reset();
  });

  it('no cap: more agents than any old maxActive all stay connected', async () => {
    const mgr = new ConnectionManager();
    const ids = Array.from({ length: 120 }, (_, i) => `agent-${i}`);
    for (const id of ids) mgr.register(id, async () => ({}), async () => {});

    await mgr.connectAll();

    assert.equal(mgr.listActive().length, 120);
    await mgr.stopAll();
  });
});
