import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConnectionsClient,
  assertNoLeakedConnectionSecret,
} from '../src/http/ConnectionsClient.js';
import type { ConnectionsError } from '../src/http/ConnectionsClient.js';

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

describe('ConnectionsClient', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  /**
   * ZIG-610 — the difference between "no grants" and "not allowed to look".
   * A brokered connector agent refused work it could do because this method
   * answered [] for a rail its key could not read, and every caller above it
   * reported the wrong cause.
   */
  it('an unreadable connection rail is an error, not an empty grant list', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            items: [],
            nextCursor: null,
            unreadableRails: [{ rail: 'connection', requiredScope: 'connections:read' }],
          }),
          { status: 200 },
        ),
    );
    await assert.rejects(
      () => new ConnectionsClient('op', 'agent-1').listForHolder(),
      /connections:read/,
    );
  });

  it('a readable rail with no grants is still just an empty list', async () => {
    mockFetch(() => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
    assert.deepEqual(await new ConnectionsClient('op', 'agent-1').listForHolder(), []);
  });

  /**
   * A partial answer is an answer: the rail was readable enough to return a
   * grant, so refusing the whole call would hide access the agent really has.
   */
  it('grants that did come back are returned even if another rail was hidden', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            items: [
              {
                grantId: 'cgr_1',
                scope: { kind: 'connection', id: 'con_1', label: 'mcp' },
                holderId: 'agent-1',
              },
            ],
            nextCursor: null,
            unreadableRails: [{ rail: 'wallet', requiredScope: 'payments:read' }],
          }),
          { status: 200 },
        ),
    );
    const groups = await new ConnectionsClient('op', 'agent-1').listForHolder();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].connectionId, 'con_1');
    assert.equal(groups[0].provider, 'mcp');
  });

  it('requires operatorKey but not agentId', () => {
    assert.throws(() => new ConnectionsClient(''), /operatorKey/);
    assert.doesNotThrow(() => new ConnectionsClient('op'));
  });

  it('proxy requires an impersonated agent and unwraps the provider result', async () => {
    const calls = mockFetch(
      () => new Response(JSON.stringify({ result: { issues: [1, 2] } }), { status: 200 }),
    );

    const noAgent = new ConnectionsClient('op_test', undefined, 'http://test');
    await assert.rejects(
      noAgent.proxy({ connectionId: 'conn_1', grantId: 'cg_1', action: 'issue:list' }),
      /agentId is required/,
    );

    const client = new ConnectionsClient('op_test', 'agent-a', 'http://test');
    const result = await client.proxy({
      connectionId: 'conn_1',
      grantId: 'cg_1',
      action: 'issue:list',
      payload: { projectKey: 'TEST' },
    });

    assert.deepEqual(result, { issues: [1, 2] });
    const call = calls[0];
    assert.equal(call?.method, 'POST');
    assert.match(call?.url ?? '', /\/connections\/conn_1\/proxy$/);
    assert.equal(call?.headers.Authorization, 'Bearer op_test');
    assert.equal(call?.headers['X-Agent-Id'], 'agent-a');
    assert.deepEqual(call?.body, {
      grantId: 'cg_1',
      action: 'issue:list',
      payload: { projectKey: 'TEST' },
    });
  });

  it('proxy withholds a response that looks like a leaked credential', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ result: { token: 'ghp_aaaaaaaaaaaaaaaa' } }),
          { status: 200 },
        ),
    );

    const client = new ConnectionsClient('op_test', 'agent-a', 'http://test');
    await assert.rejects(
      client.proxy({ connectionId: 'conn_1', grantId: 'cg_1', action: 'repo:read' }),
      /token-leak guard/,
    );
  });

  it('listGrants filters server rows to the impersonated holder', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            grants: [
              { grantId: 'cg_mine', holderId: 'agent-a' },
              { grantId: 'cg_other', holderId: 'agent-b' },
            ],
          }),
          { status: 200 },
        ),
    );

    const client = new ConnectionsClient('op_test', 'agent-a', 'http://test');
    const grants = (await client.listGrants({ connectionId: 'conn_1' })) as Array<
      Record<string, unknown>
    >;

    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.['grantId'], 'cg_mine');
  });

  it('grant mutations hit the connection-rail endpoints', async () => {
    const calls = mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const client = new ConnectionsClient('op_test', undefined, 'http://test');
    await client.issueGrant({ connectionId: 'conn_1', holderId: 'agent-a' });
    await client.attenuateGrant({
      connectionId: 'conn_1',
      grantId: 'cg_1',
      holderId: 'agent-b',
    });
    await client.revokeGrant({ connectionId: 'conn_1', grantId: 'cg_1' });

    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.url ?? '', /\/connections\/conn_1\/grants$/);
    assert.equal(calls[1]?.method, 'POST');
    assert.match(calls[1]?.url ?? '', /\/connections\/conn_1\/grants\/cg_1\/attenuate$/);
    assert.equal(calls[2]?.method, 'DELETE');
    assert.match(calls[2]?.url ?? '', /\/connections\/conn_1\/grants\/cg_1$/);
  });

  it('requestMcpConnection posts the consent request with the working chat', async () => {
    const calls = mockFetch(
      () =>
        new Response(JSON.stringify({ status: 'pending', agreementId: 'agr_1' }), {
          status: 201,
        }),
    );

    const client = new ConnectionsClient('op_test', 'agent-a', 'http://test');
    const res = await client.requestMcpConnection({
      serverUrl: 'https://mcp.example.com',
      tools: ['search'],
      reason: 'need search',
      chatId: 'chat_1',
    });

    assert.equal(res['agreementId'], 'agr_1');
    assert.match(calls[0]?.url ?? '', /\/connections\/mcp\/requests$/);
    assert.deepEqual(calls[0]?.body, {
      serverUrl: 'https://mcp.example.com',
      tools: ['search'],
      reason: 'need search',
      chatId: 'chat_1',
    });
  });

  it('requestMcpConnection targets an end-user via X-On-Behalf-Of-User (per-user gateway)', async () => {
    const calls = mockFetch(
      () =>
        new Response(JSON.stringify({ request: { requestId: 'req_1' } }), { status: 201 }),
    );

    const client = new ConnectionsClient('op_test', 'agent-a', 'http://test');
    const res = await client.requestMcpConnection({
      serverUrl: 'https://mcp.example.com',
      tools: ['search'],
      onBehalfOfUserId: 'user_9',
    });

    assert.equal((res['request'] as Record<string, unknown>)['requestId'], 'req_1');
    assert.equal(calls[0]?.headers['X-On-Behalf-Of-User'], 'user_9');
    assert.equal('chatId' in ((calls[0]?.body as Record<string, unknown>) ?? {}), false);
  });

  it('errors carry the HTTP status and truncated body', async () => {
    mockFetch(() => new Response('grant revoked', { status: 403 }));

    const client = new ConnectionsClient('op_test', 'agent-a', 'http://test');
    await assert.rejects(
      client.proxy({ connectionId: 'conn_1', grantId: 'cg_1', action: 'repo:read' }),
      (err: ConnectionsError) => {
        assert.equal(err.status, 403);
        assert.equal(err.message, 'grant revoked');
        assert.equal(err.body, 'grant revoked');
        return true;
      },
    );
  });
});

describe('assertNoLeakedConnectionSecret', () => {
  it('flags known provider credential shapes and passes clean bodies', () => {
    for (const leak of [
      'ghp_aaaaaaaaaaaaaaaa',
      'github_pat_aaaaaaaaaaaaaaaaaaaa',
      'xoxb-1234567890-abc',
      'xapp-aaaaaaaaaa',
      '{"access_token":"aaaaaaaa"}',
    ]) {
      assert.throws(() => assertNoLeakedConnectionSecret(leak), /token-leak guard/);
    }
    assert.doesNotThrow(() =>
      assertNoLeakedConnectionSecret(JSON.stringify({ issues: ['TEST-1'], ok: true })),
    );
  });
});
