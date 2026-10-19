import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

/**
 * Who a hire of a listing is for: `workspace` reaches the server, and a claim
 * that leaves it out sends nothing, so the server's default (the person) holds.
 */
async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('ziggs_agreement_claim hireFor', () => {
  afterEach(() => mock.restoreAll());

  it('sends workspace when asked, and nothing when left out', async () => {
    const bodies: Record<string, unknown>[] = [];
    mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
      if (String(url).endsWith('/claim')) bodies.push(JSON.parse(String(init.body ?? '{}')));
      return new Response(
        JSON.stringify({
          ok: true,
          kind: 'hand-off',
          agreement: { agreementId: 'agr-child', status: 'active', parties: {} },
        }),
        { status: 200 },
      );
    });
    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_agreement_claim', {
      agreementId: 'agr-listing',
      hireFor: 'workspace',
    });
    await callZiggsTool(client, 'ziggs_agreement_claim', { agreementId: 'agr-listing' });
    assert.equal(bodies[0]['hireFor'], 'workspace');
    assert.equal('hireFor' in bodies[1], false);
    await client.close();
  });
});
