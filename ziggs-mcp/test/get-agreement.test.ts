import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

/**
 * ZIG-698 — ziggs_agreement_get must tell a genuine "not found" (404) apart
 * from a permission denial (403) or an upstream/network failure. Before the
 * fix, api-client's getAgreement swallowed every non-2xx into null and the
 * tool reported "Agreement not found" for all of them.
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

function parseError(result: unknown): { code: string; message: string } {
  const parsed = JSON.parse(callText(result)) as {
    error: { code: string; message: string };
  };
  return parsed.error;
}

describe('ziggs_agreement_get not-found vs error (ZIG-698)', () => {
  afterEach(() => mock.restoreAll());

  it('returns the agreement on 200', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response(
        JSON.stringify({ agreement: { agreementId: 'agr_1', status: 'open' } }),
        { status: 200 },
      ),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_get', { agreementId: 'agr_1' });
    assert.notEqual((result as { isError?: boolean }).isError, true);
    const parsed = JSON.parse(callText(result)) as {
      agreement?: { agreementId?: string };
    };
    assert.equal(parsed.agreement?.agreementId, 'agr_1');
    await client.close();
  });

  it('reports a genuine 404 as not-found', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_get', { agreementId: 'agr_missing' });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(callText(result), /not found/i);
    await client.close();
  });

  it('reports a 403 as NOT_AUTHORIZED — never as not-found', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response('{"error":"not authorized"}', { status: 403 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_get', { agreementId: 'agr_denied' });
    assert.equal((result as { isError?: boolean }).isError, true);
    const err = parseError(result);
    assert.equal(err.code, 'NOT_AUTHORIZED');
    assert.match(err.message, /not authorized/i);
    assert.doesNotMatch(err.message, /not found/i);
    await client.close();
  });

  it('reports a 500 as UPSTREAM_ERROR — never as not-found', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response('upstream exploded', { status: 500 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_get', { agreementId: 'agr_boom' });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.equal(parseError(result).code, 'UPSTREAM_ERROR');
    await client.close();
  });
});
