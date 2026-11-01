import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callText, callZiggsTool, surfaceTools } from './support/surface.js';

/**
 * ziggs_session_hold names an execution as its subject. Every other tool takes
 * `executionContextId` as the work it runs inside, so the wrapper must leave
 * this tool's own param alone: not swallow it, not send it as the selected
 * execution, not replace its schema.
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

describe('ziggs_session_hold', () => {
  afterEach(() => mock.restoreAll());

  it('posts its own executionContextId as the body and selects no execution with it', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/sessions/hold')) {
        return new Response(JSON.stringify({ success: true, executionContextId: XEC, sessionId: 'window-1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ notices: [] }), { status: 200 });
    });
    const client = await connectedClient();
    try {
      const result = await callZiggsTool(client, 'ziggs_session_hold', { executionContextId: XEC });
      assert.doesNotMatch(callText(result), /required|isError/);
      const hold = calls.find((c) => c.url.includes('/agents/agent-1/sessions/hold'));
      assert.ok(hold, 'the hold route was called');
      assert.deepEqual(JSON.parse(String(hold!.init.body)), { executionContextId: XEC });
      const headers = hold!.init.headers as Record<string, string>;
      assert.equal(headers['X-Ziggs-Execution'], undefined);
      assert.equal(headers['X-Ziggs-Session'], 'window-1');
    } finally {
      await client.close();
    }
  });

  it('keeps the tool its own required, described param', async () => {
    const client = await connectedClient();
    try {
      const tool = (await surfaceTools(client)).find((t) => t.name === 'ziggs_session_hold');
      assert.ok(tool);
      const schema = tool!.inputSchema as { properties: Record<string, { description?: string; minLength?: number }>; required?: string[] };
      assert.deepEqual(schema.required, ['executionContextId']);
      assert.match(schema.properties.executionContextId.description ?? '', /hold in this window/);
      assert.equal(schema.properties.executionContextId.minLength, 1);
    } finally {
      await client.close();
    }
  });

  it('other tools still read executionContextId as the selected execution', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    });
    const client = await connectedClient();
    try {
      await callZiggsTool(client, 'ziggs_session_list', { executionContextId: XEC });
      const list = calls.find((c) => c.url.includes('/sessions'));
      assert.equal((list!.init.headers as Record<string, string>)['X-Ziggs-Execution'], XEC);
    } finally {
      await client.close();
    }
  });
});
