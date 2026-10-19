import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

async function connectedClient(agentId = 'agent-1'): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId } as unknown as Creds,
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

const ORGS = [
  { orgId: 'org_personal_1', name: 'Ido', kind: 'personal', role: 'owner' },
  { orgId: 'org_team_abc', name: 'rpg', kind: 'team', role: 'admin' },
];

function mockOrgFetch(): void {
  mock.method(globalThis, 'fetch', async (url: string) => {
    const u = String(url);
    if (u.endsWith('/orgs/me')) {
      return new Response(JSON.stringify({ orgs: ORGS }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

describe('ziggs_org_list (ZIG-739)', () => {
  afterEach(() => mock.restoreAll());

  it('returns the operator full membership from GET /orgs/me', async () => {
    mockOrgFetch();
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_org_list', {});
    const parsed = JSON.parse(callText(result));
    assert.equal(parsed.count, 2);
    assert.equal(parsed.orgs[1].name, 'rpg');
    await client.close();
  });
});

describe('ziggs_switch_org removed (ZIG-902)', () => {
  it('is no longer registered — org is chosen at OAuth consent, verified via ziggs_auth_status', async () => {
    const client = await connectedClient();
    const names = (await surfaceTools(client)).map((t) => t.name);
    assert.equal(names.includes('ziggs_switch_org'), false);
    // The real org flows the stub pointed at survive its removal.
    assert.ok(names.includes('ziggs_auth_status'));
    assert.ok(names.includes('ziggs_org_list'));
    await client.close();
  });
});
