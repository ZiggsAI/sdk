import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

/**
 * ZIG-641 / ZIG-648 — ziggs_connection_list discovers the connections an
 * agent holds grants for over the unified GET /grants (scopeKind=connection),
 * grouped client-side by connection with provider from the resolved scope label,
 * so ziggs_connection_proxy's connectionId/grantId no longer have to be shared
 * out of band.
 */
async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    { directConnection: true } as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function callText(result: unknown): string {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content.map((c) => c.text ?? '').join('');
}

function connectionGrant(over: Record<string, unknown> = {}) {
  return {
    grantId: 'grant-1',
    issuerId: 'user-1',
    holderId: 'agent-1',
    parentGrantId: null,
    agreementId: null,
    scope: { kind: 'connection', id: 'conn-1', label: 'github' },
    caveats: [],
    revoked: false,
    expiresAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    health: 'active',
    ...over,
  };
}

describe('ziggs_connection_list (ZIG-641 / ZIG-648)', () => {
  afterEach(() => mock.restoreAll());

  it('exposes the tool with a discovery description that routes mcp vs named connectors', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const tool = tools.find((t) => t.name === 'ziggs_connection_list');
    assert.ok(tool, 'ziggs_connection_list should be registered');
    assert.match(tool.description ?? '', /health/);
    // ZIG-1362 — do not send MCP rows at connection_proxy. Said where the
    // mistake is made: the proxy and the gateway call each name the other
    // (mcp-connection-tools.test.ts, connection-proxy.test.ts), since a
    // surface without them must not point at them from here.
    await client.close();
  });

  it('ziggs_connection_proxy points to ziggs_connection_list for discovery', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const tool = tools.find((t) => t.name === 'ziggs_connection_proxy');
    assert.ok(tool);
    assert.match(tool!.description ?? '', /ziggs_connection_list/);
    assert.doesNotMatch(tool!.description ?? '', /separate tool\/ticket/);
    await client.close();
  });

  it('queries GET /grants?scopeKind=connection and groups by connection', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          items: [
            connectionGrant({ grantId: 'grant-1' }),
            connectionGrant({ grantId: 'grant-2' }),
          ],
          nextCursor: null,
          hasMore: false,
        }),
        { status: 200 },
      );
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_connection_list', {});

    assert.ok(captured);
    const u = new URL(captured!.url);
    assert.match(u.pathname, /\/grants$/);
    assert.deepEqual(u.searchParams.getAll('scopeKind'), ['connection']);
    assert.equal(captured!.init.method ?? 'GET', 'GET');
    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers['X-Agent-Id'], 'agent-1');
    assert.equal(headers['Authorization'], 'Bearer op');

    const text = callText(result);
    // provider recovered from the resolved scope label; both grants grouped
    assert.match(text, /github/);
    assert.match(text, /conn-1/);
    assert.match(text, /grant-1/);
    assert.match(text, /grant-2/);
    assert.doesNotMatch(text, /isError/);
    await client.close();
  });

  it('surfaces a backend error as a tool error', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () => new Response('{"message":"boom"}', { status: 500 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_connection_list', {});
    assert.equal((result as { isError?: boolean }).isError, true);
    // ZIG-667: errors are typed — a 500 surfaces as UPSTREAM_ERROR.
    assert.match(callText(result), /UPSTREAM_ERROR/);
    assert.match(callText(result), /boom/);
    await client.close();
  });

  it('withholds a response that looks like it leaked a token', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            items: [
              connectionGrant({
                caveats: [
                  { type: 'note', value: 'gho_abcdefghijklmnopqrstuvwxyz0123456789' },
                ],
              }),
            ],
            nextCursor: null,
            hasMore: false,
          }),
          { status: 200 },
        ),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_connection_list', {});
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(callText(result), /token-leak guard/);
    await client.close();
  });
});
