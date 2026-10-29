import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PaymentsClient } from '../src/http/PaymentsClient.js';
import type { PaymentsError } from '../src/http/PaymentsClient.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): Call[] {
  const calls: Call[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return responder(String(url), init);
  });
  return calls;
}

describe('PaymentsClient', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('requires operatorKey but not agentId', () => {
    assert.throws(() => new PaymentsClient(''), /operatorKey/);
    assert.doesNotThrow(() => new PaymentsClient('op'));
  });

  it('balance unwraps the wallet envelope and sends auth headers', async () => {
    const calls = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            wallet: { walletId: 'wal_1', currency: 'pez' },
            balance: 700,
            availableBalance: 500,
          }),
          { status: 200 },
        ),
    );

    const client = new PaymentsClient('op_test', 'agent-a', 'http://test');
    const res = await client.balance();

    assert.deepEqual(res, {
      walletId: 'wal_1',
      currency: 'points',
      balance: 700,
      availableBalance: 500,
      unit: 'hundredths of a point',
    });
    assert.match(calls[0]?.url ?? '', /\/payments\/wallet$/);
    assert.equal(calls[0]?.headers.Authorization, 'Bearer op_test');
    assert.equal(calls[0]?.headers['X-Agent-Id'], 'agent-a');
  });

  /**
   * ZIG-1719 — the lane is WHICH engagement is spending the grant.
   *
   * The holder of a payment grant is the agent, and one fleet agent serves
   * every hirer, so without this header spend authority given for one job is
   * spendable in any job that agent is in. The backend fence can only compare
   * what the caller states, so a client that does not send it leaves the fence
   * inert.
   */
  it('sends X-Ziggs-Lane when constructed with a laneId', async () => {
    const calls = mockFetch(
      () =>
        new Response(JSON.stringify({ wallet: null, balance: 0, availableBalance: 0 }), {
          status: 200,
        }),
    );

    await new PaymentsClient(
      'op_test',
      'agent-a',
      'http://test',
    ).balance();
    assert.equal(calls[0]?.headers['X-Ziggs-Lane'], undefined);
  });

  it('omits X-Ziggs-Lane when no lane is known', async () => {
    const calls = mockFetch(
      () =>
        new Response(JSON.stringify({ wallet: null, balance: 0, availableBalance: 0 }), {
          status: 200,
        }),
    );

    await new PaymentsClient('op_test', 'agent-a', 'http://test').balance();
    assert.equal('X-Ziggs-Lane' in (calls[0]?.headers ?? {}), false);
  });

  it('omits X-Agent-Id when constructed without an agentId', async () => {
    const calls = mockFetch(
      () =>
        new Response(JSON.stringify({ wallet: null, balance: 0, availableBalance: 0 }), {
          status: 200,
        }),
    );

    await new PaymentsClient('op_test', undefined, 'http://test').balance();
    assert.equal('X-Agent-Id' in (calls[0]?.headers ?? {}), false);
  });

  it('grant mutations hit the wallet-rail endpoints', async () => {
    const calls = mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const client = new PaymentsClient('op_test', undefined, 'http://test');
    await client.issueGrant({ holderId: 'agent-a', caveats: [{ type: 'max_amount', value: 5 }] });
    await client.revokeGrant('pg_1');

    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.url ?? '', /\/payments\/grants$/);
    assert.equal(calls[1]?.method, 'DELETE');
    assert.match(calls[1]?.url ?? '', /\/payments\/grants\/pg_1$/);
    assert.equal('attenuateGrant' in client, false);
  });

  it('listGrants pages the unified GET /grants filtered to live wallet grants', async () => {
    const calls = mockFetch((url) => {
      const cursor = new URL(url).searchParams.get('cursor');
      return new Response(
        JSON.stringify(
          cursor
            ? { items: [{ grantId: 'g2' }], nextCursor: null, hasMore: false }
            : { items: [{ grantId: 'g1' }], nextCursor: 'CUR', hasMore: true },
        ),
        { status: 200 },
      );
    });

    const client = new PaymentsClient('op_test', 'agent-a', 'http://test');
    const grants = await client.listGrants();

    assert.deepEqual(
      grants.map((g) => g.grantId),
      ['g1', 'g2'],
    );
    const first = new URL(calls[0]?.url ?? 'http://x');
    assert.equal(first.pathname, '/grants');
    assert.equal(first.searchParams.get('scopeKind'), 'wallet');
    assert.equal(first.searchParams.get('health'), 'active');
  });

  it('errors carry the HTTP status and body, with the message parsed from JSON', async () => {
    mockFetch(
      () => new Response(JSON.stringify({ message: 'insufficient funds' }), { status: 400 }),
    );

    const client = new PaymentsClient('op_test', undefined, 'http://test');
    await assert.rejects(
      client.issueGrant({ holderId: 'agent-a' }),
      (err: PaymentsError) => {
        assert.equal(err.message, 'insufficient funds');
        assert.equal(err.status, 400);
        assert.ok(err.body?.includes('insufficient funds'));
        return true;
      },
    );
  });

  it('has no standalone movement verb: points move only when work settles', () => {
    const client = new PaymentsClient('op_test', undefined, 'http://test') as unknown as Record<
      string,
      unknown
    >;
    for (const verb of ['transfer', 'hold', 'release', 'approvals', 'getApproval', 'decide', 'waitForApproval']) {
      assert.equal(verb in client, false, `${verb} must not exist on PaymentsClient`);
    }
  });
});
