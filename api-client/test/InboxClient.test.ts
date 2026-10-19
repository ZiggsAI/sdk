import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { InboxClient } from '../src/http/InboxClient.js';
import {
  INBOX_HOST_CLAIMANT_HEADER,
  instanceIdentity,
  resetInstanceIdentityForTests,
} from '../src/instanceIdentity.js';

const EMPTY_ENVELOPE = {
  asOf: '2026-07-21T00:00:00.000Z',
  scopes: [],
  truncatedScopes: 0,
  countCap: 100,
  proposalsAwaitingMe: [],
  truncatedProposals: 0,
  connectionRequestsAwaitingMe: [],
  truncatedConnectionRequests: 0,
};

function stubFetch(payload: unknown) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
  }> = [];
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? 'GET'),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  return calls;
}

describe('InboxClient long-poll (delivery law)', () => {
  afterEach(() => {
    mock.restoreAll();
    resetInstanceIdentityForTests();
  });

  it('ZIG-1192: has no getOperatorInbox — that route is gone', () => {
    const client = new InboxClient('op', 'agent-a', 'http://test');
    assert.equal(
      typeof (client as { getOperatorInbox?: unknown }).getOperatorInbox,
      'undefined',
    );
  });

  it('getInbox omits wait by default — an immediate snapshot, exactly as before', async () => {
    const calls = stubFetch(EMPTY_ENVELOPE);
    const client = new InboxClient('op', 'agent-a', 'http://test');

    await client.getInbox();

    assert.equal(calls[0].url, 'http://test/inbox');
    assert.equal(calls[0].headers['X-Agent-Id'], 'agent-a');
    assert.equal(
      calls[0].headers[INBOX_HOST_CLAIMANT_HEADER],
      instanceIdentity(),
    );
  });

  it('ZIG-1199: GET /inbox stamps this host, not the API process', async () => {
    resetInstanceIdentityForTests();
    delete process.env.ECS_CONTAINER_METADATA_URI_V4;
    delete process.env.ECS_CONTAINER_METADATA_URI;
    process.env.HOSTNAME = 'laptop-fleet';
    resetInstanceIdentityForTests();
    const calls = stubFetch(EMPTY_ENVELOPE);
    const client = new InboxClient('op', 'agent-a', 'http://test');

    await client.getInbox();

    assert.equal(
      calls[0].headers[INBOX_HOST_CLAIMANT_HEADER],
      `local:laptop-fleet:${process.pid}`,
    );
  });

  it('peek hits /inbox/peek and still sends the instance header', async () => {
    const calls = stubFetch({ asOf: '2026-09-11T00:00:00.000Z', count: 1 });
    const client = new InboxClient('op', 'agent-a', 'http://test');

    const peek = await client.peek({ waitSeconds: 20 });

    assert.equal(calls[0].url, 'http://test/inbox/peek?wait=20');
    assert.equal(calls[0].headers['X-Agent-Id'], 'agent-a');
    assert.ok(calls[0].headers[INBOX_HOST_CLAIMANT_HEADER]);
    assert.equal(peek.count, 1);
  });

  it('getInbox threads waitSeconds as the wait query param', async () => {
    const calls = stubFetch(EMPTY_ENVELOPE);
    const client = new InboxClient('op', 'agent-a', 'http://test');

    await client.getInbox({ waitSeconds: 20 });

    assert.equal(calls[0].url, 'http://test/inbox?wait=20');
  });

  it('ZIG-1794: a rail that names its own host sends that, not this process', async () => {
    resetInstanceIdentityForTests();
    delete process.env.ZIGGS_INSTANCE_ID;
    process.env.HOSTNAME = 'api-task';
    const calls = stubFetch(EMPTY_ENVELOPE);
    const client = new InboxClient(
      'op',
      'agent-a',
      'http://test',
      'mcp:key-abc',
    );

    await client.getInbox();

    assert.equal(calls[0].headers[INBOX_HOST_CLAIMANT_HEADER], 'mcp:key-abc');
  });

  it('ZIG-2148: a window sends its id and its workspace, and nothing when it has none', async () => {
    const calls = stubFetch(EMPTY_ENVELOPE);
    const narrowed = new InboxClient('op', 'agent-a', 'http://test', 'mcp:key-abc', {
      clientSessionId: 'claude-code-backend',
      workspaceIds: 'org_backend',
      app: 'Claude Code',
      sessionName: 'Claude Code · MacBook · ziggs/backend',
    });
    await narrowed.getInbox();
    assert.equal(calls[0].headers['X-Ziggs-Session'], 'claude-code-backend');
    assert.equal(calls[0].headers['X-Ziggs-Workspaces'], 'org_backend');
    assert.equal(calls[0].headers['X-Ziggs-App'], 'Claude Code');
    assert.equal(calls[0].headers['X-Ziggs-Session-Name'], 'Claude Code · MacBook · ziggs/backend');

    const open = new InboxClient('op', 'agent-a', 'http://test', 'mcp:key-abc');
    await open.getInbox();
    assert.equal(calls[1].headers['X-Ziggs-Session'], undefined);
    assert.equal(calls[1].headers['X-Ziggs-Workspaces'], undefined);
  });

  it('ZIG-1794: the read and the ack of one host send the same identity', async () => {
    resetInstanceIdentityForTests();
    const calls = stubFetch(EMPTY_ENVELOPE);
    // Two clients built the same way, as two `ziggs-cli` invocations are:
    // an ack from the second must reach the inbox the first acquired.
    const read = new InboxClient('op', 'agent-a', 'http://test', 'cli:box:ido');
    const ack = new InboxClient('op', 'agent-a', 'http://test', 'cli:box:ido');

    await read.getInbox();
    await ack.ack('2026-09-10T00:00:00.000Z', { handledResourceIds: [] });

    assert.equal(calls[0].headers[INBOX_HOST_CLAIMANT_HEADER], 'cli:box:ido');
    assert.equal(
      calls[1].headers[INBOX_HOST_CLAIMANT_HEADER],
      calls[0].headers[INBOX_HOST_CLAIMANT_HEADER],
    );
  });

  it('releaseHost DELETEs /inbox/host with the same instance header', async () => {
    const calls = stubFetch({ released: true });
    const client = new InboxClient('op', 'agent-a', 'http://test', 'cli:box:ido');
    const out = await client.releaseHost();
    assert.equal(calls[0].url, 'http://test/inbox/host');
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].headers[INBOX_HOST_CLAIMANT_HEADER], 'cli:box:ido');
    assert.equal(out.released, true);
  });

  it('surfaces non-OK responses with status and body', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response('wait must be a non-negative number', { status: 400 }),
    );
    const client = new InboxClient('op', 'agent-a', 'http://test');

    await assert.rejects(
      () => client.getInbox({ waitSeconds: 5 }),
      (err: Error & { status?: number; body?: string }) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /wait must be a non-negative number/);
        assert.match(err.body ?? '', /wait must be/);
        return true;
      },
    );
  });
});

describe('InboxClient.ackOrTakeHost', () => {
  afterEach(() => {
    mock.restoreAll();
    resetInstanceIdentityForTests();
  });

  const conflict = JSON.stringify({
    error: 'This process does not own the agent inbox.',
    code: 'INBOX_HOST_CONFLICT',
  });

  it('reads once then acks again after a departed host refusal', async () => {
    const calls: string[] = [];
    let acks = 0;
    mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      const path = String(url).replace('http://test', '');
      const method = String(init?.method ?? 'GET');
      calls.push(`${method} ${path}`);
      if (method === 'POST' && path === '/inbox/ack') {
        acks += 1;
        if (acks === 1) {
          return new Response(conflict, { status: 409 });
        }
        return new Response(JSON.stringify({ ackedUpTo: 'tok' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(EMPTY_ENVELOPE), { status: 200 });
    });

    const client = new InboxClient('op', 'agent-a', 'http://test', 'host-b');
    const out = await client.ackOrTakeHost('tok', { handledResourceIds: ['r1'] });

    assert.deepEqual(calls, [
      'POST /inbox/ack',
      'GET /inbox',
      'POST /inbox/ack',
    ]);
    assert.equal(out.ackedUpTo, 'tok');
  });

  it('rethrows a second host-conflict unchanged', async () => {
    mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      const method = String(init?.method ?? 'GET');
      if (method === 'POST') {
        return new Response(conflict, { status: 409 });
      }
      return new Response(JSON.stringify(EMPTY_ENVELOPE), { status: 200 });
    });

    const client = new InboxClient('op', 'agent-a', 'http://test', 'host-b');
    await assert.rejects(
      () => client.ackOrTakeHost('tok'),
      (err: Error & { code?: string | null; status?: number }) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, 'INBOX_HOST_CONFLICT');
        return true;
      },
    );
  });

  it('does not read when the refusal is not a host conflict', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(
        JSON.stringify({ error: 'unhandled', code: 'INBOX_ACK_UNHANDLED' }),
        { status: 400 },
      );
    });

    const client = new InboxClient('op', 'agent-a', 'http://test');
    await assert.rejects(() => client.ackOrTakeHost('tok'));
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /POST/);
  });
});
