import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callJson, callZiggsTool } from './support/surface.js';

const deviceKey = `header.${Buffer.from(JSON.stringify({
  type: 'operator', keyId: 'key', ownerId: 'owner',
  boundAgentId: 'assistant', issuedVia: 'device_code',
})).toString('base64url')}.test`;

for (const host of ['ChatGPT', 'Claude', 'compact']) {
  test(`${host} sees broadcast guidance before and after a send`, async (t) => {
    const server = createZiggsMcpServer(
      { operatorKey: host === 'compact' ? 'op' : deviceKey, agentId: 'assistant' },
      { directConnection: host === 'compact', debugTools: false } as ZiggsMcpConfig,
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: host, version: 'test' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    t.after(async () => { mock.restoreAll(); await client.close(); });
    const { tools } = await client.listTools();
    const send = tools.find((tool) => tool.name === 'ziggs_chat_send');
    assert.ok(send);
    const properties = send.inputSchema.properties as Record<string, { description: string }>;
    assert.match(properties.receiverId.description, /does not wake assistants or stand-ins/);
    const message = 'Message posted to the people in this room as a human-only broadcast. Existing conversation permissions still apply.';
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify({
        success: true, message, messageId: body.messageId, chatId: 'original-room',
        delivery: {
          accepted: true, broadcast: true, to: { id: 'human', type: 'human-broadcast' },
          assignee: null, reachable: 'no', reason: 'No assistant is assigned', lastRead: null,
        },
      }));
    });
    const result = await callZiggsTool(client, 'ziggs_chat_send', {
      chatId: 'original-room', receiverId: 'human', text: 'Status update', idempotencyKey: 'broadcast',
    });
    assert.notEqual((result as { isError?: boolean }).isError, true);
    const out = callJson<{ message: string; delivered: string; chatId: string }>(result);
    assert.equal(out.message, message);
    assert.equal(out.chatId, 'original-room');
    assert.match(out.delivered, /does not wake assistants or stand-ins/);
    assert.match(out.delivered, /same chat.*returned participant id.*fresh message id/);
    assert.doesNotMatch(out.delivered, /routing is unconfirmed|Assigned to nobody/);
    assert.equal(calls.length, 1, 'guidance does not resend or add an assistant');
    assert.ok(calls[0].url.endsWith('/chats/original-room/messages'));
    assert.deepEqual(calls[0].body.receiver, { id: 'human' });
    assert.equal(calls[0].body.messageId, 'mcp_idem_broadcast');
  });
}
