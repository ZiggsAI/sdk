import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GrantsClient } from '../src/http/GrantsClient.js';

function grantRow(id: string) {
  return {
    grantId: id,
    issuerId: 'user-1',
    holderId: 'agent-a',
    parentGrantId: null,
    agreementId: null,
    scope: { kind: 'chat', id: 'chat-1', label: 'Chat chat-1' },
    caveats: [],
    revoked: false,
    expiresAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    health: 'active',
  };
}

describe('GrantsClient', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('requires operatorKey but not agentId', () => {
    assert.throws(() => new GrantsClient(''), /operatorKey/);
    assert.doesNotThrow(() => new GrantsClient('op'));
  });

  it('listGrants unwraps {items,nextCursor,hasMore} and sends auth headers', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(
        JSON.stringify({
          items: [grantRow('g1')],
          nextCursor: 'CUR',
          hasMore: true,
        }),
        { status: 200 },
      );
    });

    const client = new GrantsClient('op_test', 'agent-a', 'http://test');
    const res = await client.listGrants();

    assert.equal(res.items.length, 1);
    assert.equal(res.items[0]?.grantId, 'g1');
    assert.equal(res.items[0]?.scope.label, 'Chat chat-1');
    assert.equal(res.nextCursor, 'CUR');
    assert.equal(res.hasMore, true);
    assert.match(calls[0]?.url ?? '', /\/grants(\?|$)/);
    assert.equal(calls[0]?.headers.Authorization, 'Bearer op_test');
    assert.equal(calls[0]?.headers['X-Agent-Id'], 'agent-a');
  });

  it('serializes a repeatable scopeKind plus holderId/health/cursor/limit', async () => {
    let seen = '';
    mock.method(globalThis, 'fetch', async (url: string) => {
      seen = String(url);
      return new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), {
        status: 200,
      });
    });

    const client = new GrantsClient('op_test', 'agent-a', 'http://test');
    await client.listGrants({
      scopeKind: ['chat', 'agreement', 'org'],
      holderId: 'agent-b',
      health: 'active',
      cursor: 'CUR',
      limit: 10,
    });

    const u = new URL(seen);
    assert.deepEqual(u.searchParams.getAll('scopeKind'), ['chat', 'agreement', 'org']);
    assert.equal(u.searchParams.get('holderId'), 'agent-b');
    assert.equal(u.searchParams.get('health'), 'active');
    assert.equal(u.searchParams.get('cursor'), 'CUR');
    assert.equal(u.searchParams.get('limit'), '10');
  });

  it('omits X-Agent-Id when agentId is absent', async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      calls.push({ headers: (init?.headers as Record<string, string>) ?? {} });
      return new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), {
        status: 200,
      });
    });

    const client = new GrantsClient('op_test', undefined, 'http://test');
    await client.listGrants();
    assert.equal(calls[0]?.headers.Authorization, 'Bearer op_test');
    assert.equal('X-Agent-Id' in (calls[0]?.headers ?? {}), false);
  });

  it('throws on a non-ok response', async () => {
    mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 500 }));
    const client = new GrantsClient('op_test', 'agent-a', 'http://test');
    await assert.rejects(
      () => client.listGrants(),
      (err: Error & { status?: number }) => {
        assert.equal(err.status, 500);
        assert.equal(err.message, 'nope');
        return true;
      },
    );
  });

  it('listAllGrants follows the cursor across pages', async () => {
    const cursors: (string | null)[] = [];
    let call = 0;
    mock.method(globalThis, 'fetch', async (url: string) => {
      cursors.push(new URL(String(url)).searchParams.get('cursor'));
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ items: [grantRow('g1')], nextCursor: 'C1', hasMore: true }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ items: [grantRow('g2')], nextCursor: null, hasMore: false }),
        { status: 200 },
      );
    });

    const client = new GrantsClient('op_test', 'agent-a', 'http://test');
    const all = await client.listAllGrants({ scopeKind: 'connection' });

    assert.deepEqual(all.map((g) => g.grantId), ['g1', 'g2']);
    // first page no cursor, second page carries C1
    assert.deepEqual(cursors, [null, 'C1']);
  });
});
