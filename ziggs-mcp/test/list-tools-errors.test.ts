import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

/**
 * ZIG-699 — the list tools (ziggs_agreement_list, ziggs_chat_list,
 * ziggs_link_list) used to report an HTTP/exception failure as an
 * empty-but-successful list, so an agent wrongly concluded "you have no
 * agreements/chats/links". api-client now throws on failure and the tools
 * return a real toolError; a genuine empty 200 still succeeds with count 0.
 */
async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
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

function callText(result: unknown): string {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content.map((c) => c.text ?? '').join('');
}

function respondJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const LIST_TOOLS: Array<{ name: string; okBody: unknown }> = [
  { name: 'ziggs_agreement_list', okBody: { agreements: [] } },
  { name: 'ziggs_chat_list', okBody: { chats: [] } },
  { name: 'ziggs_link_list', okBody: { agreements: [] } },
];

describe('ziggs list tools surface API errors (ZIG-699)', () => {
  afterEach(() => mock.restoreAll());

  for (const tool of LIST_TOOLS) {
    it(`${tool.name}: empty 200 is a successful empty list, not an error`, async () => {
      mock.method(globalThis, 'fetch', async () => respondJson(tool.okBody));
      const client = await connectedClient();
      const result = await callZiggsTool(client, tool.name, {});
      assert.notEqual((result as { isError?: boolean }).isError, true);
      const parsed = JSON.parse(callText(result)) as { count?: number };
      assert.equal(parsed.count, 0);
      await client.close();
    });

    it(`${tool.name}: 500 becomes a toolError, never an empty success`, async () => {
      mock.method(globalThis, 'fetch', async () =>
        new Response('upstream exploded', { status: 500 }),
      );
      const client = await connectedClient();
      const result = await callZiggsTool(client, tool.name, {});
      assert.equal((result as { isError?: boolean }).isError, true);
      const parsed = JSON.parse(callText(result)) as { error: { code: string } };
      assert.equal(parsed.error.code, 'UPSTREAM_ERROR');
      await client.close();
    });

    it(`${tool.name}: 403 becomes a NOT_AUTHORIZED toolError`, async () => {
      mock.method(globalThis, 'fetch', async () =>
        respondJson({ error: 'not authorized' }, 403),
      );
      const client = await connectedClient();
      const result = await callZiggsTool(client, tool.name, {});
      assert.equal((result as { isError?: boolean }).isError, true);
      const parsed = JSON.parse(callText(result)) as { error: { code: string } };
      assert.equal(parsed.error.code, 'NOT_AUTHORIZED');
      await client.close();
    });
  }
});
