import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceToolNames, surfaceTools } from './support/surface.js';

/**
 * One verb per shape, replacing `ziggs_agreement_propose`.
 *
 * The point of these is capability preservation: the old tool could reach nine
 * shapes through combinations of `proposedTo`, `providerId`, `parentAgreementId`
 * and `engagementKind`, and every one of them still has a verb. What each verb
 * sends on the wire is asserted here, because the whole claim of the split is
 * that the direction of work is now in the name rather than in a param the
 * caller had to work out.
 */

const SELF = 'agent-1';

async function connectedClient(agentId = SELF): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId } as unknown as Creds,
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

/** Capture the proposal body, and answer any read the verb makes on the way. */
function mockAgreementFetch(parent?: Record<string, unknown>): {
  capturedBody: () => Record<string, unknown> | null;
  capturedUrl: () => string;
} {
  let captured: Record<string, unknown> | null = null;
  let capturedUrl = '';
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/agreements/proposals') || u.includes('/offers/publish')) {
      captured = JSON.parse(String(init?.body ?? '{}'));
      capturedUrl = u;
      return new Response(
        JSON.stringify({ agreement: { agreementId: 'agr-1' }, offer: { agreementId: 'agr-1' } }),
        { status: 200 },
      );
    }
    if (parent && /\/agreements\/[^/]+$/.test(u)) {
      return new Response(JSON.stringify({ agreement: parent }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return { capturedBody: () => captured, capturedUrl: () => capturedUrl };
}

const TERMS = { description: 'please do work' };

describe('agreement verbs carry the direction of work in the name', () => {
  afterEach(() => mock.restoreAll());

  it('commission: the counterparty provides', async () => {
    const { capturedBody } = mockAgreementFetch();
    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_agreement_buy', { counterparty: 'agent-recipient', chatId: 'chat-abc', ...TERMS });
    assert.equal(capturedBody()?.providerId, 'agent-recipient');
    assert.equal(capturedBody()?.proposedTo, 'agent-recipient');
    await client.close();
  });

  it('bid: you provide, without naming yourself', async () => {
    const { capturedBody } = mockAgreementFetch();
    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_agreement_bid', { counterparty: 'agent-customer', chatId: 'chat-abc', ...TERMS });
    assert.equal(capturedBody()?.providerId, SELF, 'the caller is the provider');
    assert.equal(capturedBody()?.proposedTo, 'agent-customer');
    await client.close();
  });

  it('broker: a third party provides, and is the one thing you must name', async () => {
    const { capturedBody } = mockAgreementFetch();
    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_agreement_broker', {
        counterparty: 'agent-customer',
        provider: 'agent-worker',
        chatId: 'chat-abc',
        ...TERMS,
      });
    assert.equal(capturedBody()?.providerId, 'agent-worker');
    assert.equal(capturedBody()?.proposedTo, 'agent-customer');
    await client.close();
  });

  it('request: broadcast with nobody providing but the claimer', async () => {
    const { capturedBody } = mockAgreementFetch();
    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_agreement_request', { audience: 'everyone', ...TERMS });
    assert.equal(capturedBody()?.providerId, undefined, 'a request names no provider');
    await client.close();
  });

  it('a standing listing is not a verb on this surface (ZIG-1979)', async () => {
    const client = await connectedClient();
    const names = await surfaceToolNames(client);
    assert.equal(names.includes('ziggs_agreement_offer'), false);
    assert.equal(names.includes('ziggs_listing_pause'), false);
    assert.equal(names.includes('ziggs_listing_resume'), false);
    await client.close();
  });

  it('handoff: the provider comes from the parent hire, not from the caller', async () => {
    // The old tool made the caller pass providerId here, which meant looking the
    // parent up first, and that read masks a third-party agent to a persona face.
    // The server resolves the hire's provider itself.
    const { capturedBody } = mockAgreementFetch({
      agreementId: 'agr-parent',
      description: 'the original hire',
      publishedService: false,
      parties: { provider: { actor: 'agent-hired' }, creator: { actor: SELF } },
    });
    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_agreement_handoff', { parentAgreementId: 'agr-parent', to: 'agent-beneficiary' });
    assert.equal(capturedBody()?.useParentProvider, true);
    assert.equal(capturedBody()?.providerId, undefined);
    assert.equal(capturedBody()?.parentAgreementId, 'agr-parent');
    await client.close();
  });
});

describe('the verbs no longer ask for what the name already says', () => {
  afterEach(() => mock.restoreAll());

  it('only broker exposes a provider param', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const byName = new Map(tools.map((t) => [t.name, t]));

    const withProvider = [
      'ziggs_agreement_buy',
      'ziggs_agreement_bid',
      'ziggs_agreement_request',
      'ziggs_agreement_handoff',
    ].filter((n) => {
      const props = (byName.get(n)?.inputSchema as { properties?: Record<string, unknown> })
        ?.properties;
      return props && ('providerId' in props || 'provider' in props);
    });

    assert.deepEqual(withProvider, [], 'only ziggs_agreement_broker names a provider');

    const brokerProps = (
      byName.get('ziggs_agreement_broker')?.inputSchema as {
        properties?: Record<string, unknown>;
      }
    )?.properties;
    assert.ok(brokerProps && 'provider' in brokerProps);
    await client.close();
  });

  it('the propose dispatch table is gone from the surface', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const names = tools.map((t) => t.name);
    assert.equal(
      names.includes('ziggs_agreement_propose'),
      false,
      'the single propose verb was replaced, not kept alongside',
    );
    await client.close();
  });
});
