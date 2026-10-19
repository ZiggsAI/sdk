import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

/**
 * ZIG-798 — ziggs_connection_request opens a connection-consent agreement as an
 * approvable card in the working chat; the human approves it there like any
 * agreement, and on approval the server is connected (OAuth if needed) and the
 * agent is granted the tools. The old status-poll tool is gone — the agent
 * learns the outcome from ziggs_connection_list.
 */
async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    // Asking for a connection is only on a self-configured connection (an
    // operator key), never on the listed surface a connected assistant gets.
    {
      ZIGGS_WEB_URL: 'https://ziggsai.com',
      directConnection: true,
    } as unknown as ZiggsMcpConfig,
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

describe('ziggs_connection_request (ZIG-798)', () => {
  afterEach(() => mock.restoreAll());

  it('exposes the tool as an in-chat consent, and drops the status poller', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const request = tools.find((t) => t.name === 'ziggs_connection_request');
    assert.ok(request, 'ziggs_connection_request should be registered');
    assert.match(request.description ?? '', /chat/);
    assert.ok(
      !tools.find((t) => t.name === 'ziggs_request_connection_status'),
      'ziggs_request_connection_status should no longer be registered',
    );
    await client.close();
  });

  it('POSTs the request as the agent with the chatId and points the human to the chat', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          agreementId: 'agr-consent-1',
          sentTo: { id: 'psn_ido', name: 'Ido', role: 'customer' },
          approveIn: { kind: 'chat', chatId: 'chat-42' },
          message: 'Sent to Ido. Ido approves it in this room.',
        }),
        { status: 201 },
      );
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_connection_request', {
        chatId: 'chat-42',
        serverUrl: 'https://mcp.example.com/mcp',
        tools: ['search', 'fetch'],
        reason: 'Need web search for the research request',
        recipientId: 'psn_ido',
      });

    assert.ok(captured);
    assert.match(captured!.url, /\/connections\/mcp\/requests$/);
    assert.equal(captured!.init.method, 'POST');
    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers['X-Agent-Id'], 'agent-1');
    assert.equal(headers['Authorization'], 'Bearer op');
    const sent = JSON.parse(String(captured!.init.body));
    assert.equal(sent.serverUrl, 'https://mcp.example.com/mcp');
    assert.deepEqual(sent.tools, ['search', 'fetch']);
    assert.equal(sent.reason, 'Need web search for the research request');
    assert.equal(sent.chatId, 'chat-42');
    assert.equal(sent.recipientId, 'psn_ido');

    const text = callText(result);
    assert.match(text, /agr-consent-1/);
    // ZIG-2011 — who got the card, as the server answered; never "your principal".
    assert.match(text, /Sent to Ido\. Ido approves it in this room\./);
    assert.doesNotMatch(text, /your principal/);
    assert.match(text, /pull-only/);
    await client.close();
  });

  it('surfaces a backend error as a tool error', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () => new Response('{"message":"boom"}', { status: 403 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_connection_request', {
        chatId: 'chat-42',
        serverUrl: 'https://mcp.example.com/mcp',
        tools: ['repo:read'],
        recipientId: 'psn_ido',
      });
    assert.equal((result as { isError?: boolean }).isError, true);
    // ZIG-667: errors are typed — a 403 surfaces as NOT_AUTHORIZED with the
    // backend's reason, not a raw status passthrough.
    assert.match(callText(result), /NOT_AUTHORIZED/);
    assert.match(callText(result), /boom/);
    await client.close();
  });

  it('fast-fails on an empty tools list before hitting the wire (shared validation)', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      calls.push(String(url));
      return new Response('{}', { status: 200 });
    });
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_connection_request', {
        chatId: 'chat-42',
        serverUrl: 'https://mcp.example.com/mcp',
        tools: [],
        recipientId: 'psn_ido',
      });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(callText(result), /non-empty array/);
    assert.equal(calls.length, 0);
    await client.close();
  });
});
