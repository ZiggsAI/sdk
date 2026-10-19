import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

/**
 * ZIG-569 — ziggs_connection_proxy lets an agent use a stored connection via the
 * backend proxy (grant check + vault decrypt happen server-side); the agent
 * never sees the credential, and the MCP layer mirrors the backend leak-guard.
 *
 * ZIG-1368 — and it is reachable only on a connection the caller configured
 * themselves with an operator key, not on the listed surface a connected
 * assistant gets (a token the OAuth consent flow minted).
 */
async function connectedClient(
  cfg: Partial<ZiggsMcpConfig> = { directConnection: true },
): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    cfg as ZiggsMcpConfig,
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

describe('ziggs_connection_proxy (ZIG-569)', () => {
  afterEach(() => mock.restoreAll());

  it('exposes the tool with a credential-safety description', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const tool = tools.find((t) => t.name === 'ziggs_connection_proxy');
    assert.ok(tool, 'ziggs_connection_proxy should be registered');
    assert.match(tool.description ?? '', /without seeing the credential/);
    await client.close();
  });

  // ZIG-1368 — a reviewer of the listed surface cannot tell what a freeform
  // action-plus-payload tool does, cannot cite the API it calls, and its one
  // write annotation cannot describe a surface whose behaviour changes with its
  // arguments. So it is not on that surface at all — not merely undocumented.
  it('is absent from the listed surface the connector directory advertises', async () => {
    const client = await connectedClient({ directConnection: false });
    const names = (await surfaceTools(client)).map((t) => t.name);
    assert.equal(
      names.includes('ziggs_connection_proxy'),
      false,
      'the directory surface must carry no freeform action-plus-payload tool',
    );
    // The rest of the rail that uses or asks for a connection is off this
    // surface with it: the brokered-MCP pair is the same freeform shape, and a
    // request for a grant the caller could never use here is a trap for the
    // person asked to approve it. Only the read-only lister stays.
    for (const gone of [
      'ziggs_connection_request',
      'ziggs_mcp_tools_list',
      'ziggs_mcp_tool_call',
    ]) {
      assert.equal(names.includes(gone), false, `${gone} must be off the listed surface`);
    }
    assert.ok(
      names.includes('ziggs_connection_list'),
      'the lister stays, so a caller can still see what exists',
    );
    await client.close();
  });

  it('a self-configured connection keeps the whole rail', async () => {
    const client = await connectedClient({ directConnection: true });
    const names = (await surfaceTools(client)).map((t) => t.name);
    for (const kept of [
      'ziggs_connection_proxy',
      'ziggs_connection_list',
      'ziggs_connection_request',
      'ziggs_mcp_tools_list',
      'ziggs_mcp_tool_call',
    ]) {
      assert.ok(names.includes(kept), `${kept} should be on a self-configured connection`);
    }
    await client.close();
  });

  it('tells a listed-surface caller that named connectors are a different rail', async () => {
    const client = await connectedClient({ directConnection: false });
    const list = (await surfaceTools(client)).find(
      (t) => t.name === 'ziggs_connection_list',
    );
    assert.ok(list);
    // It still SHOWS the github/jira rows — hiding them would leave a caller
    // unable to ask for what it cannot see. It just says they are not callable.
    assert.match(list!.description ?? '', /not callable over this connection/);
    assert.doesNotMatch(list!.description ?? '', /ziggs_connection_proxy/);
    assert.doesNotMatch(list!.description ?? '', /ziggs_mcp_tool_call/);
    await client.close();
  });

  it('impersonates the agent and returns the provider result', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ result: { full_name: 'octo/repo' } }), {
        status: 200,
      });
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_connection_proxy', {
        connectionId: 'conn-1',
        grantId: 'grant-1',
        action: 'repo:read',
        payload: { owner: 'octo', repo: 'repo' },
      });

    assert.ok(captured);
    assert.match(captured!.url, /\/connections\/conn-1\/proxy$/);
    assert.equal(captured!.init.method, 'POST');
    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers['X-Agent-Id'], 'agent-1');
    assert.equal(headers['Authorization'], 'Bearer op');
    const sent = JSON.parse(captured!.init.body as string);
    assert.deepEqual(sent, {
      grantId: 'grant-1',
      action: 'repo:read',
      payload: { owner: 'octo', repo: 'repo' },
    });

    const text = callText(result);
    assert.match(text, /octo\/repo/);
    assert.doesNotMatch(text, /isError/);
    await client.close();
  });

  it('surfaces a backend error (e.g. invalid grant) as a tool error', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () => new Response('{"message":"Grant invalid"}', { status: 403 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_connection_proxy', { connectionId: 'conn-1', grantId: 'bad', action: 'repo:read' });
    assert.equal((result as { isError?: boolean }).isError, true);
    // ZIG-667: errors are typed — a 403 surfaces as NOT_AUTHORIZED with the
    // backend's reason, not a raw status passthrough.
    assert.match(callText(result), /NOT_AUTHORIZED/);
    assert.match(callText(result), /Grant invalid/);
    await client.close();
  });

  it('withholds a response that looks like it leaked a token', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ result: { token: 'gho_abcdefghijklmnopqrstuvwxyz0123456789' } }),
          { status: 200 },
        ),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_connection_proxy', { connectionId: 'conn-1', grantId: 'grant-1', action: 'repo:read' });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(callText(result), /token-leak guard/);
    await client.close();
  });
});
