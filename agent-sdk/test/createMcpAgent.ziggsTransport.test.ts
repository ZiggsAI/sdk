const WAKE_LANE_HEADER = 'X-Ziggs-Lane';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureApiClient } from '@ziggs-ai/api-client';
import {
  resolveZiggsGatewayTarget,
  resolvePerUserGatewayTarget,
  wrapGatewayFetch,
  ZiggsGatewayError,
} from '../src/mcp/createMcpAgent.js';

describe('wrapGatewayFetch (ZIG-702)', () => {
  test('maps a structured 403 body to a typed ZiggsGatewayError', async () => {
    const base = (async () =>
      new Response(JSON.stringify({ code: 'GRANT_REVOKED', message: 'Grant is revoked' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const wrapped = wrapGatewayFetch(base);
    await assert.rejects(
      () => wrapped('https://api.example/connections/c/mcp'),
      (err: unknown) => {
        assert.ok(err instanceof ZiggsGatewayError);
        assert.equal(err.code, 'GRANT_REVOKED');
        assert.equal(err.status, 403);
        assert.match(err.message, /revoked/);
        return true;
      },
    );
  });

  test('passes through a 403 without a code (non-gateway shape) untouched', async () => {
    const base = (async () =>
      new Response('plain forbidden', { status: 403 })) as typeof fetch;
    const wrapped = wrapGatewayFetch(base);
    const res = await wrapped('https://api.example/x');
    assert.equal(res.status, 403);
    assert.equal(await res.text(), 'plain forbidden');
  });

  test('leaves successful responses untouched (body still readable)', async () => {
    const base = (async () =>
      new Response('{"ok":true}', { status: 200 })) as typeof fetch;
    const wrapped = wrapGatewayFetch(base);
    const res = await wrapped('https://api.example/x');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe('resolveZiggsGatewayTarget', () => {
  const prevEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['ZIGGS_OPERATOR_KEY', 'BACKEND_URL', 'ZIGGS_BACKEND_URL'];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
  });

  test('builds the gateway URL and auth headers from explicit config', () => {
    const target = resolveZiggsGatewayTarget(
      {
        type: 'ziggs',
        connectionId: 'con_abc',
        grantId: 'cgr_xyz',
        operatorKey: 'op-key-1',
        baseUrl: 'https://api.ziggs.example/',
        agentId: 'agent_7',
      },
    );
    assert.equal(
      target.url.toString(),
      'https://api.ziggs.example/connections/con_abc/mcp',
    );
    assert.deepEqual(target.headers, {
      authorization: 'Bearer op-key-1',
      'x-agent-id': 'agent_7',
      'x-grant-id': 'cgr_xyz',
    });
  });

  test('falls back to env operator key, env base url, and host agentId', () => {
    process.env.ZIGGS_OPERATOR_KEY = 'env-op-key';
    process.env.ZIGGS_BACKEND_URL = 'http://backend:3000';
    const target = resolveZiggsGatewayTarget(
      { type: 'ziggs', connectionId: 'con_abc', grantId: 'cgr_xyz' },
      { agentId: 'host-agent' },
    );
    assert.equal(
      target.url.toString(),
      'http://backend:3000/connections/con_abc/mcp',
    );
    assert.equal(target.headers.authorization, 'Bearer env-op-key');
    assert.equal(target.headers['x-agent-id'], 'host-agent');
  });

  /**
   * The deployment case, which is what actually broke (ZIG-1104). The fleet task
   * sets HTTP_URL and neither BACKEND_URL nor ZIGGS_BACKEND_URL, so the old chain
   * fell through to `localhost:3000`: every gateway call died inside the container
   * and the agent reported the MCP server as unreachable, with nothing in the
   * backend's logs because no request ever arrived.
   */
  test('resolves the configured backend when only HTTP_URL is set', () => {
    process.env.ZIGGS_OPERATOR_KEY = 'env-op-key';
    delete process.env.ZIGGS_BACKEND_URL;
    delete process.env.BACKEND_URL;
    // The same call env-init makes at boot from HTTP_URL — testing the real
    // mechanism rather than the env var it happens to come from.
    configureApiClient({ httpUrl: 'https://api.example.test' });
    const target = resolveZiggsGatewayTarget(
      { type: 'ziggs', connectionId: 'con_abc', grantId: 'cgr_xyz' },
      { agentId: 'host-agent' },
    );
    assert.equal(
      target.url.toString(),
      'https://api.example.test/connections/con_abc/mcp',
    );
  });

  test('throws without an operator key', () => {
    assert.throws(
      () =>
        resolveZiggsGatewayTarget(
          { type: 'ziggs', connectionId: 'con_abc', grantId: 'cgr_xyz' },
          { agentId: 'host-agent' },
        ),
      /operatorKey/,
    );
  });

  test('throws without an agent id to impersonate', () => {
    process.env.ZIGGS_OPERATOR_KEY = 'env-op-key';
    assert.throws(
      () =>
        resolveZiggsGatewayTarget({
          type: 'ziggs',
          connectionId: 'con_abc',
          grantId: 'cgr_xyz',
        }),
      /agentId/,
    );
  });

  test('throws without connectionId or grantId', () => {
    process.env.ZIGGS_OPERATOR_KEY = 'env-op-key';
    assert.throws(
      () =>
        resolveZiggsGatewayTarget(
          { type: 'ziggs', connectionId: '', grantId: 'cgr_xyz' },
          { agentId: 'a' },
        ),
      /connectionId/,
    );
    assert.throws(
      () =>
        resolveZiggsGatewayTarget(
          { type: 'ziggs', connectionId: 'con_abc', grantId: '' },
          { agentId: 'a' },
        ),
      /grantId/,
    );
  });
});

describe('resolvePerUserGatewayTarget (ZIG-771)', () => {
  const prevEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['ZIGGS_OPERATOR_KEY', 'BACKEND_URL', 'ZIGGS_BACKEND_URL'];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
  });

  test('targets /connections/mcp/relay with on-behalf-of header, no connectionId', () => {
    const target = resolvePerUserGatewayTarget(
      { type: 'ziggs-per-user', operatorKey: 'op-key-1', baseUrl: 'https://api.ziggs.example/' },
      'agent_7',
      'user_42',
    );
    assert.equal(target.url.toString(), 'https://api.ziggs.example/connections/mcp/relay');
    assert.deepEqual(target.headers, {
      authorization: 'Bearer op-key-1',
      'x-agent-id': 'agent_7',
      'x-on-behalf-of-user': 'user_42',
    });
    // The per-user target must never carry a connectionId or grantId.
    assert.ok(!('x-grant-id' in target.headers));
  });

  test('falls back to env operator key and base url', () => {
    process.env.ZIGGS_OPERATOR_KEY = 'env-op-key';
    process.env.ZIGGS_BACKEND_URL = 'http://backend:3000';
    const target = resolvePerUserGatewayTarget(
      { type: 'ziggs-per-user' },
      'host-agent',
      'user_9',
    );
    assert.equal(target.url.toString(), 'http://backend:3000/connections/mcp/relay');
    assert.equal(target.headers.authorization, 'Bearer env-op-key');
    assert.equal(target.headers['x-on-behalf-of-user'], 'user_9');
  });

  test('throws without an operator key', () => {
    assert.throws(
      () => resolvePerUserGatewayTarget({ type: 'ziggs-per-user' }, 'agent', 'user'),
      /operatorKey/,
    );
  });
});

/**
 * ZIG-1720 — the SDK's own gateway door has to state the lane too, for the
 * same reason the ziggs-mcp one does: without it the broker cannot tell which
 * customer this wake is working for, and the grant check has nothing to
 * compare the giver against.
 */
test('resolveZiggsGatewayTarget sends the lane when the wake has one', () => {
  const target = resolveZiggsGatewayTarget(
    {
      type: 'ziggs',
      connectionId: 'con_1',
      grantId: 'cgr_1',
      operatorKey: 'op',
      baseUrl: 'https://api.example.test',
    },
    { agentId: 'agent-1', laneId: 'agrn-agr_acme' },
  );
  assert.equal(target.headers[WAKE_LANE_HEADER], undefined);
});

test('resolveZiggsGatewayTarget omits the lane header when there is none', () => {
  const target = resolveZiggsGatewayTarget(
    {
      type: 'ziggs',
      connectionId: 'con_1',
      grantId: 'cgr_1',
      operatorKey: 'op',
      baseUrl: 'https://api.example.test',
    },
    { agentId: 'agent-1' },
  );
  assert.ok(!(WAKE_LANE_HEADER in target.headers));
});
