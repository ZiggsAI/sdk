import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

/**
 * ZIG-957 — link mutations must return linkSummary, not the raw Mongo agreement
 * doc (no money block / approvals array / internal fields).
 */
const LINK_SUMMARY_KEYS = [
  'agreementId',
  'status',
  'proposalStatus',
  'parties',
  'createdAt',
] as const;

const RAW_DOC_LEAK_KEYS = ['_id', '__v', 'money', 'approvals', 'escrow'] as const;

const RAW_LINK_DOC = {
  agreementId: 'agr_link_1',
  engagementKind: 'link',
  status: 'active',
  proposalStatus: 'approved',
  parties: {
    creator: { principal: 'user-1', actor: 'agent-1' },
    provider: { principal: null, actor: 'agent-2' },
    proposedTo: { principal: 'user-2', actor: null },
  },
  description: 'trust link',
  createdAt: '2026-07-01T00:00:00.000Z',
  // Noise that must NOT appear in the tool result agreement payload:
  _id: 'mongo-oid',
  __v: 0,
  money: { amount: 0, currency: 'USD' },
  approvals: [{ partyId: 'user-2', status: 'approved' }],
  escrow: { held: false },
};

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

function callJson(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text?: string }> }).content;
  const text = content.map((c) => c.text ?? '').join('');
  return JSON.parse(text) as Record<string, unknown>;
}

function assertLinkSummary(agreement: unknown, label: string): void {
  assert.ok(agreement && typeof agreement === 'object', `${label}: expected agreement object`);
  const a = agreement as Record<string, unknown>;
  for (const key of LINK_SUMMARY_KEYS) {
    assert.ok(key in a, `${label}: missing linkSummary key ${key}`);
  }
  for (const key of RAW_DOC_LEAK_KEYS) {
    assert.ok(!(key in a), `${label}: leaked raw-doc field ${key}`);
  }
  assert.equal(a['agreementId'], 'agr_link_1');
}

describe('link mutation response shapes (ZIG-957)', () => {
  afterEach(() => mock.restoreAll());

  it('ziggs_agreement_revoke returns linkSummary for a link', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ ok: true, agreement: RAW_LINK_DOC }), { status: 200 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_revoke', { agreementId: 'agr_link_1' });
    const parsed = callJson(result);
    assert.equal(parsed.status, 'revoked');
    assertLinkSummary(parsed.agreement, 'revoke');
    assert.match(String(parsed.note ?? ''), /Link revoked/);
    await client.close();
  });

  /**
   * ZIG-1478 — connecting hands back no agreement at all, so there is no
   * summary to shape.
   *
   * This asserted the propose reply carried a shaped link, plus a note saying
   * approval had been routed to the target agent's owner. Both were the same
   * disclosure problem: an id target learned who owns that agent and that the
   * row exists, while an email target had been carefully written to learn
   * nothing. One answer for both is the only version that is not a way to
   * check who has an account.
   */
  it('ziggs_link_propose returns no agreement to shape, and says nothing about the target', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ ok: true, status: 'sent', shareUrl: null }), { status: 200 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_link_propose', { to: 'agent-2', message: 'trust link' });
    const parsed = callJson(result);
    assert.equal(parsed.status, 'sent');
    assert.equal(parsed.agreement, undefined);
    assert.equal(parsed.shareUrl, null);
    // No owner id, no "already linked", no "already invited".
    assert.equal(String(parsed.message ?? '').includes('user-2'), false);
    await client.close();
  });

  it('ziggs_link_propose with no target returns the share link and still no row', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response(
        JSON.stringify({ ok: true, status: 'sent', shareUrl: 'https://app.test/connect/agr_link_1' }),
        { status: 200 },
      ),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_link_propose', {});
    const parsed = callJson(result);
    assert.equal(parsed.agreement, undefined);
    assert.match(String(parsed.shareUrl), /\/connect\/agr_link_1$/);
    await client.close();
  });

  it('ziggs_agreement_respond returns linkSummary when the agreement is a link', async () => {
    // Direct link proposal: proposedTo = this agent, with a pending approval slot.
    const pendingLink = {
      ...RAW_LINK_DOC,
      status: 'open',
      proposalStatus: 'pending',
      parties: {
        ...RAW_LINK_DOC.parties,
        proposedTo: { principal: null, actor: 'agent-1' },
      },
      approvals: [{ partyId: 'agent-1', status: 'pending' }],
    };
    const approvedLink = {
      ...pendingLink,
      status: 'active',
      proposalStatus: 'approved',
      approvals: [{ partyId: 'agent-1', status: 'approved' }],
    };
    mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const href = String(url);
      if (method === 'GET' && /\/agreements\/agr_link_1/.test(href)) {
        return new Response(JSON.stringify({ agreement: pendingLink }), { status: 200 });
      }
      if (method === 'PUT' && /\/approvals\//.test(href)) {
        return new Response(JSON.stringify({ agreement: approvedLink }), { status: 200 });
      }
      return new Response(JSON.stringify({ agreement: approvedLink }), { status: 200 });
    });
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_agreement_respond', { agreementId: 'agr_link_1', action: 'approve' });
    assert.notEqual((result as { isError?: boolean }).isError, true, callJson(result));
    const parsed = callJson(result);
    assertLinkSummary(parsed.agreement, 'respond');
    await client.close();
  });
});

