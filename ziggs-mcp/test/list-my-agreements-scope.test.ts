import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

/**
 * ZIG-942 kept a caller-is-party filter. ZIG-2240 makes reachable the
 * default, because a person's hires are grants they can read and are not
 * always agreements the assistant itself is a party to. scope=mine is that
 * filter.
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

function mockFetchCapturingUrl(): { urls: string[] } {
  const captured: { urls: string[] } = { urls: [] };
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    captured.urls.push(String(input));
    return new Response(JSON.stringify({ agreements: [] }), { status: 200 });
  });
  return captured;
}

describe('ziggs_agreement_list scope (ZIG-942)', () => {
  afterEach(() => mock.restoreAll());

  it('defaults to the agreements the caller can reach, including hires (ZIG-2240)', async () => {
    const captured = mockFetchCapturingUrl();
    const client = await connectedClient();
    const listed = await client.listTools();
    const tool = listed.tools.find((t) => t.name === 'ziggs_agreement_list');
    assert.match(tool?.description ?? '', /including hires/);
    assert.match(tool?.description ?? '', /scope mine/);
    const result = await callZiggsTool(client, 'ziggs_agreement_list', {});
    assert.notEqual((result as { isError?: boolean }).isError, true);
    const url = new URL(captured.urls[0]);
    assert.equal(url.searchParams.get('scope'), 'mine');
    assert.equal(url.searchParams.get('partyOnly'), null);
    const parsed = JSON.parse(callText(result)) as { scope?: string };
    assert.equal(parsed.scope, 'reachable');
    await client.close();
  });

  it('scope=mine is the caller-is-party filter (partyOnly=true)', async () => {
    const captured = mockFetchCapturingUrl();
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_list', { scope: 'mine' });
    assert.notEqual((result as { isError?: boolean }).isError, true);
    const url = new URL(captured.urls[0]);
    assert.equal(url.searchParams.get('scope'), 'mine');
    assert.equal(url.searchParams.get('partyOnly'), 'true');
    const parsed = JSON.parse(callText(result)) as { scope?: string };
    assert.equal(parsed.scope, 'mine');
    await client.close();
  });

  it('fields keeps only the named keys on each row (ZIG-1444)', async () => {
    mock.method(globalThis, 'fetch', async () => {
      return new Response(
        JSON.stringify({
          agreements: [
            {
              agreementId: 'agr_1',
              status: 'active',
              terms: { description: 'fat' },
              parties: { payer: {}, provider: {} },
              money: { price: 0 },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_list', {
      fields: ['agreementId', 'status'],
    });
    assert.notEqual((result as { isError?: boolean }).isError, true);
    const parsed = JSON.parse(callText(result)) as {
      count: number;
      agreements: Array<Record<string, unknown>>;
    };
    assert.equal(parsed.count, 1);
    assert.deepEqual(parsed.agreements[0], {
      agreementId: 'agr_1',
      status: 'active',
    });
    await client.close();
  });
});
