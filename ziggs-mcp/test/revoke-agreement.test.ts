import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

/**
 * ZIG-207 / ZIG-1022 — one revoke verb. DELETE /agreements/:id works on any
 * agreement kind; ziggs_agreement_revoke is the single tool for it (the old
 * link-flavored twin was folded in — link revokes get a kind-aware note).
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

describe('ziggs_agreement_revoke (ZIG-207)', () => {
  afterEach(() => mock.restoreAll());

  it('is the ONLY revoke verb — the link-flavored twin is gone (ZIG-1022)', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('ziggs_agreement_revoke'));
    assert.ok(!names.includes('ziggs_revoke_link'));
    await client.close();
  });

  it('calls DELETE /agreements/:agreementId for a non-link agreement', async () => {
    const calls: { url: string; method: string }[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return new Response(
        JSON.stringify({
          ok: true,
          agreement: { agreementId: 'agr_service_1', engagementKind: 'service' },
        }),
        { status: 200 },
      );
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_revoke', { agreementId: 'agr_service_1' });

    const text = callText(result);
    const parsed = JSON.parse(text) as {
      status?: string;
      agreementId?: string;
      agreement?: { engagementKind?: string };
    };
    assert.equal(parsed.status, 'revoked');
    assert.equal(parsed.agreementId, 'agr_service_1');
    assert.equal(parsed.agreement?.engagementKind, 'service');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'DELETE');
    assert.match(calls[0]?.url ?? '', /\/agreements\/agr_service_1$/);
    assert.doesNotMatch(text, /isError/);
    await client.close();
  });

  it('surfaces a backend error as a tool error', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () => new Response('{"message":"not a party to this agreement"}', { status: 403 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_revoke', { agreementId: 'agr_x' });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(callText(result), /not a party to this agreement/);
    await client.close();
  });
});
