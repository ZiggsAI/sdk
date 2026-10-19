import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { surfaceToolNames } from './support/surface.js';

/**
 * ZIG-1979 — a person or the deploy publishes, pauses, and resumes a listing.
 * Those three verbs are not on the agent surface. Revoke stays: ending an
 * agreement you are a party to is not the listing door.
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

describe('listing publish, pause, and resume are not agent verbs', () => {
  afterEach(() => {});

  it('the three verbs are absent and revoke stays', async () => {
    const client = await connectedClient();
    const names = await surfaceToolNames(client);
    assert.equal(names.includes('ziggs_agreement_offer'), false);
    assert.equal(names.includes('ziggs_listing_pause'), false);
    assert.equal(names.includes('ziggs_listing_resume'), false);
    assert.ok(names.includes('ziggs_agreement_revoke'));
    await client.close();
  });
});
