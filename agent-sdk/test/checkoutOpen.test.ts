/**
 * Opening a checkout refuses by name: no repository in the task, no host box,
 * no GitHub grant, or a grant that cannot see the repository. Only a grant
 * the door answers for opens a box.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openCheckout, closeCheckout, type OpenCheckoutDeps } from '../src/checkout/open.js';
import type { CheckoutProvider } from '../src/checkout/types.js';

/** A box that answers the channel the way the real one does, without git. */
function checkpoints() {
  const values = new Map<string, Uint8Array>();
  return { values, load: async (key: string) => values.get(key) ?? null,
    save: async (key: string, data: Uint8Array) => { values.set(key, data); } };
}

/** Exercise the HTTP client contract without requiring a local listening socket. */
async function fakeBox() {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.includes('/connections/')) return new Response('refs');
    if (path === '/relay/next') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      return new Response(null, { status: 204 });
    }
    if (path === '/setup') return Response.json({ baseBranch: 'main', branch: 'agent/task_1', head: 'a'.repeat(40), resumed: false });
    if (path === '/checkpoint') return new Response('private-checkpoint');
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { calls, fetchFn, url: 'http://box.test' };
}

function deps(overrides: Partial<OpenCheckoutDeps> & { doorStatus?: number; stopped?: string[] } = {}): OpenCheckoutDeps & { failed: Array<{ taskId: string; reason: string }> } {
  const failed: Array<{ taskId: string; reason: string }> = [];
  const doorStatus = overrides.doorStatus ?? 200;
  return {
    provider: undefined,
    needs: [{ checkout: 'git' }],
    taskId: 'task_1',
    getTask: async () => ({ title: 'Add a page to ZiggsAI/frontend, base branch main' }),
    listConnections: async () => [{ connectionId: 'con_gh', provider: 'mcp', grants: [{ grantId: 'cgr_1' } as never] }],
    door: { backendUrl: 'http://backend.test', operatorKey: 'op', agentId: 'a1', laneId: 'chat_1' },
    failTask: async (taskId, reason) => { failed.push({ taskId, reason }); },
    log: () => {},
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://backend.test/')) {
        return new Response(doorStatus === 200 ? '001e# service=git-upload-pack\n0000' : 'no', { status: doorStatus });
      }
      return fetch(input, init);
    }) as typeof fetch,
    readyTimeoutMs: 5_000,
    failed,
    ...overrides,
  };
}

describe('openCheckout refuses by name', () => {
  it('needs no checkout on a wake without a task, or for an agent without the need', async () => {
    assert.equal(await openCheckout(deps({ taskId: undefined })), null);
    assert.equal(await openCheckout(deps({ needs: [{ connection: 'mcp' }] })), null);
  });

  it('a task naming no repository', async () => {
    const d = deps({ getTask: async () => ({ title: 'Change the footer copy' }) });
    assert.equal(await openCheckout(d), 'refused');
    assert.match(d.failed[0].reason, /names no repository/);
  });

  it('a host that provides no box', async () => {
    const d = deps();
    assert.equal(await openCheckout(d), 'refused');
    assert.match(d.failed[0].reason, /this host provides none/);
    assert.match(d.failed[0].reason, /ZiggsAI\/frontend/);
  });

  it('a hire with no GitHub grant', async () => {
    const d = deps({ provider: { checkpoints: checkpoints(), start: async () => { throw new Error('must not start'); } }, listConnections: async () => [{ connectionId: 'con_linear', provider: 'linear', grants: [{ grantId: 'g' } as never] }] });
    assert.equal(await openCheckout(d), 'refused');
    assert.match(d.failed[0].reason, /no live grant for a GitHub connection \(for the checkout\)/);
  });

  it('a GitHub grant the door says cannot see the repository', async () => {
    const d = deps({ doorStatus: 404, provider: { checkpoints: checkpoints(), start: async () => { throw new Error('must not start'); } } });
    assert.equal(await openCheckout(d), 'refused');
    assert.match(d.failed[0].reason, /no GitHub connection grant on this hire can read ZiggsAI\/frontend/);
    assert.match(d.failed[0].reason, /con_gh: 404/);
  });

  it('opens a box only once the door answered, clones the task branch, and is closed with its cost', async () => {
    const box = await fakeBox();
    let secretSeen = '';
    let stopped = 0;
    const provider: CheckoutProvider = {
      checkpoints: checkpoints(),
      start: async (spec) => {
        secretSeen = spec.secret;
        assert.equal(spec.label.repository, 'ZiggsAI/frontend');
        return { endpoint: { url: box.url, secret: spec.secret }, kind: 'fake', resources: { vcpu: 1 }, stop: async () => { stopped += 1; } };
      },
    };
    const d = deps({ provider, fetchFn: box.fetchFn });
    const open = await openCheckout(d);
    assert.ok(open && open !== 'refused');
    assert.equal(open.session.branch, 'agent/task_1');
    assert.equal(open.session.baseBranch, 'main');
    assert.equal(open.session.target.repository, 'ZiggsAI/frontend');
    assert.equal(secretSeen.length, 64, 'a fresh secret per box');
    assert.ok(box.calls.includes('POST /setup'));
    const cost = await closeCheckout(open);
    assert.equal(cost.kind, 'fake');
    assert.equal(cost.vcpu, 1);
    assert.ok(cost.seconds >= 1);
    assert.equal(stopped, 1);
    assert.deepEqual(d.failed, []);
    assert.ok(box.calls.includes('POST /checkpoint'));
    assert.ok(box.calls.includes('POST /cancel'));
  });

  it('a box that never comes up is stopped without permanently failing the task', async () => {
    let stopped = 0;
    const d = deps({
      provider: { checkpoints: checkpoints(), start: async () => ({ endpoint: { url: 'http://127.0.0.1:1', secret: 's' }, kind: 'fake', stop: async () => { stopped += 1; } }) },
      readyTimeoutMs: 1_500,
    });
    await assert.rejects(openCheckout(d), /Could not open checkout of ZiggsAI\/frontend/);
    assert.deepEqual(d.failed, []);
    assert.equal(stopped, 1);
  });
  it('restores uncommitted work under the same task and never shares it with another hire', async () => {
    const box = await fakeBox();
    const store = checkpoints();
    const provider: CheckoutProvider = { checkpoints: store, start: async spec => ({
      endpoint: { url: box.url, secret: spec.secret }, kind: 'fake', stop: async () => {},
    }) };
    const d = deps({ provider, fetchFn: box.fetchFn });
    const first = await openCheckout(d);
    assert.ok(first && first !== 'refused');
    await first.session.client.write('draft.txt', 'uncommitted');
    assert.equal(store.values.size, 1, 'each mutating tool checkpoints before returning');
    await closeCheckout(first);
    const second = await openCheckout(d);
    assert.ok(second && second !== 'refused');
    assert.ok(box.calls.includes('POST /restore'));
    await closeCheckout(second);
    box.calls.length = 0;
    const other = await openCheckout({ ...d, door: { ...d.door, laneId: 'different-hire' } });
    assert.ok(other && other !== 'refused');
    assert.ok(!box.calls.includes('POST /restore'));
    await closeCheckout(other);
  });

  it('stops the box even when saving a checkpoint fails', async () => {
    const box = await fakeBox();
    let stopped = false;
    const d = deps({ fetchFn: box.fetchFn, provider: {
      checkpoints: { load: async () => null, save: async () => { throw new Error('storage unavailable'); } },
      start: async spec => ({ endpoint: { url: box.url, secret: spec.secret }, kind: 'fake', stop: async () => { stopped = true; } }),
    } });
    const open = await openCheckout(d);
    assert.ok(open && open !== 'refused');
    const result = await open.session.client.write('draft.txt', 'content');
    assert.match(result.checkpointWarning!, /storage unavailable/);
    assert.equal((result as any).ok, true);
    assert.equal((await closeCheckout(open)).kind, 'fake');
    assert.equal(box.calls.filter(call => call === 'POST /checkpoint').length, 1);
    assert.deepEqual(d.failed, []);
    assert.equal(stopped, true);
    assert.ok(box.calls.includes('POST /stop'));
  });

});

it('retries a failed task read without failing the task or starting a box', async () => {
  const d = deps({ getTask: async () => { throw new Error('temporary 503'); } });
  await assert.rejects(openCheckout(d), /temporary 503/);
  assert.deepEqual(d.failed, []);
});

it('supports a host without checkpoint storage and reports branch-only persistence', async () => {
  const box = await fakeBox();
  const d = deps({ fetchFn: box.fetchFn, provider: {
    start: async spec => ({ endpoint: { url: box.url, secret: spec.secret }, kind: 'fake', stop: async () => {} }),
  } });
  const open = await openCheckout(d);
  assert.ok(open && open !== 'refused');
  const result = await open.session.client.write('draft.txt', 'content');
  assert.match(result.checkpointWarning!, /Only work pushed/);
  await closeCheckout(open);
  assert.ok(!box.calls.some(call => /checkpoint|restore/.test(call)));
  assert.deepEqual(d.failed, []);
});

it('does not overwrite recoverable work when loading a configured store fails', async () => {
  const box = await fakeBox();
  let stopped = false;
  const d = deps({ fetchFn: box.fetchFn, provider: {
    checkpoints: { load: async () => { throw new Error('storage read unavailable'); }, save: async () => { assert.fail('must not overwrite'); } },
    start: async spec => ({ endpoint: { url: box.url, secret: spec.secret }, kind: 'fake', stop: async () => { stopped = true; } }),
  } });
  await assert.rejects(openCheckout(d), /storage read unavailable/);
  assert.deepEqual(d.failed, []);
  assert.equal(stopped, true);
});

it('keeps command success and command failure intact when checkpointing throws', async () => {
  const { CheckoutBoxClient } = await import('../src/checkout/boxClient.js');
  let status = 200;
  const client = new CheckoutBoxClient({ url: 'http://box.test', secret: 's' }, (async () =>
    status === 200 ? Response.json({ exitCode: 0, stdout: 'tests passed' }) : new Response('original tool error', { status })
  ) as typeof fetch);
  client.onMutation = async () => { throw new Error('checkpoint exceeds 64 MiB'); };
  const result = await client.run('npm test');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'tests passed');
  assert.match(result.checkpointWarning!, /64 MiB/);
  status = 400;
  await assert.rejects(client.run('broken command'), /original tool error/);
});

it('does not fail a completed wake when its final checkpoint save fails', async () => {
  const box = await fakeBox();
  let stopped = false;
  const d = deps({ fetchFn: box.fetchFn, provider: {
    checkpoints: { load: async () => null, save: async () => { throw new Error('final save unavailable'); } },
    start: async spec => ({ endpoint: { url: box.url, secret: spec.secret }, kind: 'fake', stop: async () => { stopped = true; } }),
  } });
  const open = await openCheckout(d);
  assert.ok(open && open !== 'refused');
  assert.equal((await closeCheckout(open)).kind, 'fake');
  assert.match(open.session.client.checkpointWarning!, /final save unavailable/);
  assert.equal(stopped, true);
  assert.deepEqual(d.failed, []);
});
