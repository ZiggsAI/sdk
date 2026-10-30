const WAKE_LANE_HEADER = 'X-Ziggs-Lane';
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type Creds, withWorkExecutionId } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import {
  resolveMcpGatewayTarget,
  setMcpGatewayRunnerForTests,
} from '../src/mcpConnectionTools.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

/**
 * ZIG-1362 — ziggs_mcp_tools_list / ziggs_mcp_tool_call reach the gateway
 * (`/connections/:id/mcp`), not the named-connector proxy.
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

describe('ziggs_mcp_* connection tools (ZIG-1362)', () => {
  afterEach(() => {
    mock.restoreAll();
    setMcpGatewayRunnerForTests(null);
  });

  it('registers both tools and steers clear of connection_proxy for MCP', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const list = tools.find((t) => t.name === 'ziggs_mcp_tools_list');
    const call = tools.find((t) => t.name === 'ziggs_mcp_tool_call');
    assert.ok(list);
    assert.ok(call);
    assert.match(call!.description ?? '', /ziggs_connection_proxy/);
    assert.match(call!.description ?? '', /Unknown provider: mcp/);
    await client.close();
  });

  it('resolveMcpGatewayTarget points at /connections/:id/mcp with grant header', () => {
    const t = resolveMcpGatewayTarget({
      connectionId: 'con_1',
      grantId: 'cgr_1',
      operatorKey: 'op',
      agentId: 'agent-1',
      baseUrl: 'https://api.example.test',
    });
    assert.equal(
      t.url.toString(),
      'https://api.example.test/connections/con_1/mcp',
    );
    assert.equal(t.headers.authorization, 'Bearer op');
    assert.equal(t.headers['x-agent-id'], 'agent-1');
    assert.equal(t.headers['x-grant-id'], 'cgr_1');
  });

  it('carries the selected execution into the remote MCP gateway', async () => {
    await withWorkExecutionId('xec_work', async () => {
      const target = resolveMcpGatewayTarget({ connectionId: 'con_1', grantId: 'cgr_1', operatorKey: 'op', agentId: 'agent-1', baseUrl: 'https://api.example.test' });
      assert.equal(target.headers['X-Ziggs-Execution'], 'xec_work');
      assert.equal(target.headers[WAKE_LANE_HEADER], undefined);
    });
  });

  it('omits the lane header when the wake has no lane', () => {
    const t = resolveMcpGatewayTarget({
      connectionId: 'con_1',
      grantId: 'cgr_1',
      operatorKey: 'op',
      agentId: 'agent-1',
      baseUrl: 'https://api.example.test',
    });
    assert.ok(!(WAKE_LANE_HEADER in t.headers));
  });

  it('ziggs_mcp_tools_list uses the gateway runner (not /proxy)', async () => {
    let saw: { url: string; grantId: string } | null = null;
    setMcpGatewayRunnerForTests(async (target, run) => {
      saw = { url: target.url.toString(), grantId: target.headers['x-grant-id']! };
      const fake = {
        listTools: async () => ({
          tools: [{ name: 'list_issues', description: 'list' }],
        }),
      };
      return run(fake as unknown as Client);
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_mcp_tools_list', { connectionId: 'con_1', grantId: 'cgr_1' });
    assert.ok(saw);
    assert.match(saw!.url, /\/connections\/con_1\/mcp$/);
    assert.equal(saw!.grantId, 'cgr_1');
    assert.doesNotMatch(saw!.url, /\/proxy/);
    assert.match(callText(result), /list_issues/);
    assert.equal((result as { isError?: boolean }).isError, undefined);
    await client.close();
  });

  it('ziggs_mcp_tool_call forwards tool + args through the gateway', async () => {
    let called: { name: string; arguments: unknown } | null = null;
    setMcpGatewayRunnerForTests(async (_target, run) => {
      const fake = {
        callTool: async (req: { name: string; arguments?: unknown }) => {
          called = req;
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      };
      return run(fake as unknown as Client);
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_mcp_tool_call', {
        tool: 'list_issues',
        args: { team: 'ZIG' },
        connectionId: 'con_1',
        grantId: 'cgr_1',
      });
    assert.deepEqual(called, {
      name: 'list_issues',
      arguments: { team: 'ZIG' },
    });
    assert.match(callText(result), /list_issues/);
    assert.equal((result as { isError?: boolean }).isError, undefined);
    await client.close();
  });

  it('refuses an omitted connection when several grants exist (no silent pick)', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      if (String(url).includes('/grants')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                grantId: 'cgr_a',
                health: 'active',
                scope: { kind: 'connection', id: 'con_a', label: 'mcp' },
              },
              {
                grantId: 'cgr_b',
                health: 'active',
                scope: { kind: 'connection', id: 'con_b', label: 'mcp' },
              },
            ],
            nextCursor: null,
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      return new Response('unexpected', { status: 500 });
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_mcp_tool_call', { tool: 'list_issues' });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(callText(result), /Name the connection/);
    await client.close();
  });
});
