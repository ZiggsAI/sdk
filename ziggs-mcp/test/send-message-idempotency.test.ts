import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

/**
 * ZIG-722 (follow-up to ZIG-718): ziggs_chat_send exposes an optional
 * idempotencyKey. When provided it maps to a stable messageId so a retried
 * logical send collapses to one message via the backend {chatId, messageId}
 * dedupe; when omitted each call gets a fresh random id (backward compatible).
 */
async function connectedClient(agentId = 'agent-1'): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
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

function mockSendCapture(): { bodies: Record<string, unknown>[]; urls: string[] } {
  const state = { bodies: [] as Record<string, unknown>[], urls: [] as string[] };
  mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
    state.urls.push(String(url));
    state.bodies.push(JSON.parse(String(init.body ?? '{}')));
    return new Response(
      JSON.stringify({ success: true, message: 'ok', chatId: 'c-1' }),
      { status: 200 },
    );
  });
  return state;
}

describe('ziggs_chat_send idempotencyKey (ZIG-722)', () => {
  afterEach(() => mock.restoreAll());

  it('maps a stable idempotencyKey to a deterministic messageId across calls', async () => {
    const captured = mockSendCapture();
    const client = await connectedClient();

    for (let i = 0; i < 2; i++) {
      await callZiggsTool(client, 'ziggs_chat_send', {
          chatId: 'c-1',
          receiverId: 'u-1',
          text: 'retry me',
          idempotencyKey: 'send-42',
        });
    }

    assert.equal(captured.bodies.length, 2);
    assert.equal(captured.bodies[0]['messageId'], 'mcp_idem_send-42');
    assert.equal(
      captured.bodies[0]['messageId'],
      captured.bodies[1]['messageId'],
      'same idempotencyKey must yield the same messageId so the backend dedupes',
    );
    await client.close();
  });

  it('mints a fresh random messageId when idempotencyKey is omitted (backward compatible)', async () => {
    const captured = mockSendCapture();
    const client = await connectedClient();

    for (let i = 0; i < 2; i++) {
      await callZiggsTool(client, 'ziggs_chat_send', { chatId: 'c-1', receiverId: 'u-1', text: 'hi' });
    }

    assert.equal(captured.bodies.length, 2);
    const id0 = String(captured.bodies[0]['messageId']);
    const id1 = String(captured.bodies[1]['messageId']);
    assert.match(id0, /^mcp_/);
    assert.ok(!id0.startsWith('mcp_idem_'), 'random ids are not namespaced as idem');
    assert.notEqual(id0, id1, 'omitted key → distinct messages');
    await client.close();
  });
});

describe('ziggs_chat_send to an existing participant', () => {
  afterEach(() => mock.restoreAll());

  it('POSTs /chats/messages with to and does not send a chatId', async () => {
    const captured = mockSendCapture();
    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_chat_send', {
      to: 'user-buyer',
      text: 'hi',
    });
    assert.equal(captured.urls.length, 1);
    assert.match(captured.urls[0] ?? '', /\/chats\/messages$/);
    assert.doesNotMatch(captured.urls[0] ?? '', /\/chats\/user-buyer\//);
    assert.equal(captured.bodies[0]?.['to'], 'user-buyer');
    assert.equal(captured.bodies[0]?.['chatId'], undefined);
    await client.close();
  });

  it('lets chatId win when both are passed', async () => {
    const captured = mockSendCapture();
    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_chat_send', {
      chatId: 'c-1',
      to: 'user-buyer',
      text: 'hi',
    });
    assert.match(captured.urls[0] ?? '', /\/chats\/c-1\/messages$/);
    assert.equal(captured.bodies[0]?.['chatId'], 'c-1');
    assert.deepEqual(captured.bodies[0]?.['receiver'], { id: 'user-buyer' });
    await client.close();
  });
});
