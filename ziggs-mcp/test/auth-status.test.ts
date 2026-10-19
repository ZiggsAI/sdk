import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

/**
 * ZIG-503 — ziggs_auth_status (renamed from ziggs_connection_status, which
 * collided with the unrelated "connection" of ziggs_connection_proxy) used to
 * duplicate the session-summary payload under two top-level keys
 * (sessionActions and pendingDecisions, literally the same object). The
 * tool's own description only ever promised "pendingDecisions", so that's
 * the one key that should remain.
 *
 * ZIG-1272 — hosted / fleet impersonation must not call Claude-delegate
 * access (that route reports disconnected / throws even when the key works).
 */

function inboxOk(): Response {
  return new Response(
    JSON.stringify({
      asOf: '2026-07-01T00:00:00.000Z',
      scopes: [],
      truncatedScopes: 0,
      countCap: 100,
      proposalsAwaitingMe: [],
      truncatedProposals: 0,
      connectionRequestsAwaitingMe: [],
      truncatedConnectionRequests: 0,
    }),
    { status: 200 },
  );
}

async function connectedClient(agentId = 'agent-1', operatorKey = 'op'): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey, agentId } as unknown as Creds,
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

describe('ziggs_auth_status (ZIG-503 / ZIG-1272)', () => {
  afterEach(() => mock.restoreAll());

  it('is registered under its new name, not the old connection_status name', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('ziggs_auth_status'));
    assert.equal(names.includes('ziggs_connection_status'), false);
    await client.close();
  });

  it('hosted impersonation reads /orgs/me and reports connected with home org (ZIG-1272)', async () => {
    const hits: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      const u = String(url);
      hits.push(u);
      if (u.includes('/agents/delegate/access')) {
        throw new Error('fetch failed');
      }
      if (u.includes('/orgs/me')) {
        return new Response(
          JSON.stringify({
            activeOrgId: 'org-ziggs',
            orgs: [
              {
                orgId: 'org-ziggs',
                name: 'Ziggs',
                kind: 'team',
                role: 'member',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (u.includes('/inbox')) return inboxOk();
      if (u.includes('/tasks')) {
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const client = await connectedClient('agent-definer');
    const result = await callZiggsTool(client, 'ziggs_auth_status', {});
    const parsed = JSON.parse(callText(result)) as Record<string, unknown>;

    assert.equal(parsed.ok, true);
    assert.equal(parsed.connected, true);
    assert.equal(parsed.actingOrgId, 'org-ziggs');
    assert.equal(parsed.actingOrgName, 'Ziggs');
    assert.equal(parsed.actingOrgKind, 'team');
    assert.equal(parsed.orgBinding, undefined);
    assert.match(String(parsed.orgBindingNote), /acts in/);
    assert.equal(parsed.switchOrgHint, undefined);
    assert.equal(
      hits.some((h) => h.includes('/agents/delegate/access')),
      false,
      'must not call Claude-delegate access for hosted agents',
    );
    await client.close();
  });

  it('never surfaces a raw fetch error in switchOrgHint (ZIG-1272)', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('/orgs/me')) {
        throw new Error('fetch failed');
      }
      if (u.includes('/inbox')) return inboxOk();
      if (u.includes('/tasks')) {
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const client = await connectedClient('agent-definer');
    const result = await callZiggsTool(client, 'ziggs_auth_status', {});
    const parsed = JSON.parse(callText(result)) as Record<string, unknown>;

    assert.equal(parsed.connected, false);
    assert.equal(parsed.actingOrgId, null);
    assert.equal(parsed.switchOrgHint, undefined);
    assert.equal(
      String(parsed.switchOrgHint).includes('fetch failed'),
      false,
      'raw network text must not leak into switchOrgHint',
    );
    await client.close();
  });

  it('Claude OAuth delegates still use /agents/delegate/access', async () => {
    const hits: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      const u = String(url);
      hits.push(u);
      if (u.includes('/agents/delegate/access')) {
        return new Response(
          JSON.stringify({
            connected: true,
            orgId: 'org-team-1',
            orgName: 'Team One',
            orgKind: 'team',
            switchOrgHint: 'reconnect MCP OAuth',
          }),
          { status: 200 },
        );
      }
      if (u.includes('/inbox')) return inboxOk();
      if (u.includes('/tasks')) {
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const agentId = 'assistant-with-any-name';
    const token = `e30.${Buffer.from(JSON.stringify({ boundAgentId: agentId, issuedVia: 'mcp_oauth' })).toString('base64url')}.sig`;
    const client = await connectedClient(agentId, token);
    const result = await callZiggsTool(client, 'ziggs_auth_status', {});
    const parsed = JSON.parse(callText(result)) as Record<string, unknown>;

    assert.equal(parsed.connected, true);
    assert.equal(parsed.actingOrgId, 'org-team-1');
    assert.equal(parsed.actingOrgName, 'Team One');
    assert.ok(hits.some((h) => h.includes('/agents/delegate/access')));
    assert.equal(
      hits.some((h) => h.includes('/orgs/me')),
      false,
      'delegate path should not use hosted /orgs/me reader',
    );
    await client.close();
  });

  // ZIG-1384 #1 — this tool is a binding check and nothing else now. The
  // pending/active counts it used to carry moved to ziggs_inbox, which owns the
  // session start; reporting them here too is what made orienting cost three
  // calls that each said some of the same thing.
  it('answers the binding question only — no counts, and no inbox fetch', async () => {
    const hits: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      const u = String(url);
      hits.push(u);
      if (u.includes('/orgs/me')) {
        return new Response(
          JSON.stringify({
            activeOrgId: 'org-team-1',
            orgs: [
              { orgId: 'org-team-1', name: 'Team One', kind: 'team' },
            ],
          }),
          { status: 200 },
        );
      }
      if (u.includes('/inbox')) return inboxOk();
      if (u.includes('/tasks')) {
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_auth_status', {});
    const parsed = JSON.parse(callText(result)) as Record<string, unknown>;

    assert.equal(parsed.ok, true);
    assert.equal('pendingDecisions' in parsed, false, 'counts belong to ziggs_inbox');
    assert.equal('sessionActions' in parsed, false, 'sessionActions duplicate should be gone');
    assert.equal(parsed.actingOrgId, 'org-team-1');
    assert.equal(parsed.actingOrgName, 'Team One');
    assert.equal(parsed.connected, true);
    assert.match(String(parsed.orgBindingNote), /acts in/);
    // The whole point of the fold: a binding check reads the binding, not mail.
    assert.equal(
      hits.some((u) => u.includes('/inbox') || u.includes('/tasks')),
      false,
      'auth_status should not fetch the inbox or task list',
    );
    await client.close();
  });

  it('orgBindingNote says not connected when Claude-delegate access reports disconnected', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('/agents/delegate/access')) {
        return new Response(
          JSON.stringify({
            connected: false,
            orgId: 'org-personal-1',
            orgName: 'Personal',
            orgKind: 'personal',
          }),
          { status: 200 },
        );
      }
      if (u.includes('/inbox')) return inboxOk();
      if (u.includes('/tasks')) {
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const client = await connectedClient('delegate--user-1');
    const result = await callZiggsTool(client, 'ziggs_auth_status', {});
    const parsed = JSON.parse(callText(result)) as Record<string, unknown>;

    assert.equal(parsed.connected, false);
    assert.match(String(parsed.orgBindingNote), /Not connected/i);
    assert.equal('consentOrgId' in parsed, false, 'dead JWT consentOrgId should be gone');
    await client.close();
  });
});
