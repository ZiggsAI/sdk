import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callText, callZiggsTool, surfaceTools } from './support/surface.js';

/**
 * ziggs_session_hold names a conversation by any message in it. Like every
 * other tool it may also carry `executionContextId`, which is the work the
 * call runs inside and never part of what it sends.
 */
async function connectedClient(creds: Record<string, unknown> = {}): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1', clientSessionId: 'window-1', ...creds } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const XEC = `xec_${'a'.repeat(64)}`;
const MSG = `msg_${'b'.repeat(64)}`;

describe('ziggs_session_hold', () => {
  afterEach(() => mock.restoreAll());

  it('posts the message that names the conversation, from this window', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/sessions/hold')) {
        return new Response(JSON.stringify({ success: true, rootMessageId: MSG, sessionId: 'ses_1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ notices: [] }), { status: 200 });
    });
    const client = await connectedClient();
    try {
      const result = await callZiggsTool(client, 'ziggs_session_hold', { messageId: MSG });
      assert.doesNotMatch(callText(result), /required|isError/);
      const hold = calls.find((c) => c.url.includes('/agents/agent-1/sessions/hold'));
      assert.ok(hold, 'the hold route was called');
      assert.deepEqual(JSON.parse(String(hold!.init.body)), { messageId: MSG });
      const headers = hold!.init.headers as Record<string, string>;
      assert.equal(headers['X-Ziggs-Execution'], undefined);
      assert.equal(headers['X-Ziggs-Session'], 'window-1');
    } finally {
      await client.close();
    }
  });

  it('requires the message and says what it is', async () => {
    const client = await connectedClient();
    try {
      const tool = (await surfaceTools(client)).find((t) => t.name === 'ziggs_session_hold');
      assert.ok(tool);
      const schema = tool!.inputSchema as { properties: Record<string, { description?: string; minLength?: number }>; required?: string[] };
      assert.deepEqual(schema.required, ['messageId']);
      assert.match(schema.properties.messageId.description ?? '', /hold in this window/);
      assert.equal(schema.properties.messageId.minLength, 1);
    } finally {
      await client.close();
    }
  });

  it('reads executionContextId as the selected execution, like every other tool', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ success: true, rootMessageId: MSG, sessionId: 'ses_1', sessions: [] }), { status: 200 });
    });
    const client = await connectedClient();
    try {
      await callZiggsTool(client, 'ziggs_session_hold', { messageId: MSG, executionContextId: XEC });
      const hold = calls.find((c) => c.url.includes('/sessions/hold'));
      assert.deepEqual(JSON.parse(String(hold!.init.body)), { messageId: MSG });
      assert.equal((hold!.init.headers as Record<string, string>)['X-Ziggs-Execution'], XEC);
    } finally {
      await client.close();
    }
  });
});
