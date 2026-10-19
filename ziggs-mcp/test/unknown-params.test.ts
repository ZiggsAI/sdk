import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

/**
 * ZIG-1215 — an unknown param used to be dropped silently, so `nweChat` for
 * `newChat` reused the existing chat and reported success: the opposite of
 * what was asked, with no signal to self-correct against.
 */
async function connectedClient(
  cfg: Partial<ZiggsMcpConfig> = {},
): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    { debugTools: false, ...cfg } as ZiggsMcpConfig,
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

/** Any outbound call means the handler ran on a request it should have refused. */
function failOnFetch(): void {
  mock.method(globalThis, 'fetch', async (url: string) => {
    throw new Error(`handler ran despite invalid params: fetch ${String(url)}`);
  });
}

describe('unknown tool params are rejected, not dropped (ZIG-1215)', () => {
  afterEach(() => mock.restoreAll());

  it('every registered tool refuses unknown keys', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    assert.ok(tools.length > 10, 'expected the full tool surface');
    const permissive = tools
      .filter(
        (t) =>
          (t.inputSchema as { additionalProperties?: unknown })
            .additionalProperties !== false,
      )
      .map((t) => t.name);
    assert.deepEqual(
      permissive,
      [],
      `tools that silently drop unknown params: ${permissive.join(', ')}`,
    );
    await client.close();
  });

  it('a misspelled param fails the call instead of inverting it', async () => {
    failOnFetch();
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_chat_open', { participantId: 'agent-2', nweChat: true });
    assert.equal((result as { isError?: boolean }).isError, true);
    const text = callText(result);
    // Names the typo, and the menu it should have been picked from.
    assert.match(text, /nweChat/);
    assert.match(text, /newChat/);
    assert.match(text, /ziggs_chat_open/);
    await client.close();
  });

  it('read paths refuse them too — a bogus filter is not a silent no-op', async () => {
    failOnFetch();
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_artifact_list', { totallyBogusParam: 'x' });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(callText(result), /totallyBogusParam/);
    await client.close();
  });

  it('still accepts the params a tool does declare', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      assert.match(String(url), /\/orgs\/me$/);
      return new Response(JSON.stringify({ orgs: [] }), { status: 200 });
    });
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_org_list', {});
    assert.notEqual((result as { isError?: boolean }).isError, true);
    await client.close();
  });
});
