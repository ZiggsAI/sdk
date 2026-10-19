import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

/**
 * ZIG-895 — an MCP delegate could propose/approve/reject/revoke but could not
 * counter with new terms, mark its own provided side fulfilled, or fetch one
 * agent by id. These mirror the SDK's agreement_counter /
 * agreement_fulfill / agent_get, same base capability, reusing api-client.
 */
async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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

describe('ziggs_agreement_counter / ziggs_agreement_fulfill / ziggs_agent_get (ZIG-895)', () => {
  afterEach(() => mock.restoreAll());

  it('registers all three tools', async () => {
    const client = await connectedClient();
    const names = (await surfaceTools(client)).map((t) => t.name);
    assert.ok(names.includes('ziggs_agreement_counter'));
    assert.ok(names.includes('ziggs_agreement_fulfill'));
    assert.ok(names.includes('ziggs_agent_get'));
    await client.close();
  });

  it('counter POSTs /agreements/:id/counter with only the changed terms', async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') });
      return new Response(
        JSON.stringify({ agreement: { agreementId: 'agr_1', proposalStatus: 'pending', price: 500 } }),
        { status: 200 },
      );
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_counter', { agreementId: 'agr_1', price: 500, agreementDescription: 'revised' });

    const parsed = JSON.parse(callText(result)) as {
      status?: string;
      agreementId?: string;
      agreement?: { price?: number };
    };
    assert.equal(parsed.status, 'countered');
    assert.equal(parsed.agreementId, 'agr_1');
    assert.equal(parsed.agreement?.price, 500);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.url ?? '', /\/agreements\/agr_1\/counter$/);
    const sent = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    assert.equal(sent['price'], 500);
    assert.equal(sent['agreementDescription'], 'revised');
    // agreementId is the path param, not part of the counter body.
    assert.equal('agreementId' in sent, false);
    await client.close();
  });

  it('fulfill POSTs /agreements/:id/fulfill and reports fulfilled', async () => {
    const calls: { url: string; method: string }[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return new Response(
        JSON.stringify({ ok: true, agreement: { agreementId: 'agr_2', status: 'fulfilled' } }),
        { status: 200 },
      );
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_fulfill', { agreementId: 'agr_2' });

    const parsed = JSON.parse(callText(result)) as { status?: string; agreementId?: string };
    assert.equal(parsed.status, 'fulfilled');
    assert.equal(parsed.agreementId, 'agr_2');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.url ?? '', /\/agreements\/agr_2\/fulfill$/);
    await client.close();
  });

  it('get_agent GETs /agents/:id and returns the profile', async () => {
    const calls: { url: string; method: string }[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return new Response(
        JSON.stringify({ agentId: 'agent_9', name: 'Scout', reachability: 'published' }),
        { status: 200 },
      );
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agent_get', { agentId: 'agent_9' });

    const parsed = JSON.parse(callText(result)) as {
      agent?: { agentId?: string; name?: string; success?: unknown };
    };
    assert.equal(parsed.agent?.agentId, 'agent_9');
    assert.equal(parsed.agent?.name, 'Scout');
    // The internal success flag is stripped from the surfaced profile.
    assert.equal('success' in (parsed.agent ?? {}), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'GET');
    assert.match(calls[0]?.url ?? '', /\/agents\/agent_9$/);
    await client.close();
  });

  it('get_agent surfaces a 404 as a tool error', async () => {
    mock.method(globalThis, 'fetch', async () => new Response('not found', { status: 404 }));
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agent_get', { agentId: 'agent_missing' });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(callText(result), /not found/i);
    await client.close();
  });

  it('counter surfaces a backend error as a tool error', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () => new Response('{"message":"not a party to this agreement"}', { status: 403 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_counter', { agreementId: 'agr_x', price: 1 });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(callText(result), /not a party/);
    await client.close();
  });
});
