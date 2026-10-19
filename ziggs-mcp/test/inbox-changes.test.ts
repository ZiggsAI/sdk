import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InboxClient, AssistantConnectionClient, type Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

afterEach(() => mock.restoreAll());
const cursor = 'ibxo1_01234567-1234-1234-1234-012345678901';
const delta = { asOf: '2026-10-17T00:00:00Z', cursor, expiresAt: '2026-10-18T00:00:00Z', deliveries: [], hasMore: false };
for (const connection of [false, true]) {
  it(`observation uses only the ${connection ? 'connection' : 'agent'} delta endpoint, without a lease or ack`, async () => {
    const claims = connection ? { connectionClientId: 'client', keyId: 'key' } : { boundAgentId: 'agent' };
    const creds: Creds = { operatorKey: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`, agentId: 'agent' };
    const seen: URL[] = [];
    mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input); seen.push(url);
      if (url.pathname === '/oauth/connection-notices') return Response.json({ notices: [] });
      assert.equal(init?.method ?? 'GET', 'GET');
      assert.equal(url.pathname, connection ? '/oauth/inbox/changes' : '/inbox/changes');
      assert.equal(url.searchParams.get('cursor'), cursor);
      assert.equal(url.searchParams.get('wait'), '55');
      return Response.json(delta);
    });
    const server = createZiggsMcpServer(creds, { directConnection: !connection });
    const client = new Client({ name: 'delta-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const tool = (await surfaceTools(client)).find(item => item.name === 'ziggs_inbox_changes');
      assert.ok(tool);
      assert.equal(tool.annotations?.readOnlyHint, true);
      const result = await callZiggsTool(client, 'ziggs_inbox_changes', { cursor, waitSeconds: 55 });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.deepEqual(JSON.parse((result.content as Array<{text: string}>)[0].text), delta);
      assert.equal(seen.filter(url => url.pathname.endsWith('/inbox/changes')).length, 1);
    } finally { await client.close(); await server.close(); }
  });
}
it('both HTTP clients forward cancellation and preserve an expired-cursor error', async () => {
  const abort = new AbortController();
  mock.method(globalThis, 'fetch', async (_input: string, init?: RequestInit) => {
    assert.equal(init?.signal, abort.signal);
    return Response.json({ code: 'INBOX_OBSERVATION_EXPIRED', message: 'Start a new scan' }, { status: 410 });
  });
  const direct = new InboxClient('key', 'agent');
  const connection = new AssistantConnectionClient({ operatorKey: 'key', agentId: 'agent' });
  for (const client of [direct, connection])
    await assert.rejects(client.getChanges({ cursor, signal: abort.signal }), error => {
      assert.equal((error as { status: number }).status, 410);
      return true;
    });
});

it('notification status is a read-only connection tool with explicit workspace and no subscription side effects', async () => {
  const claims = { connectionClientId: 'client', keyId: 'key' };
  const creds: Creds = { operatorKey: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`, agentId: '' };
  const health = { enabled: true, orgId: 'workspace/a', subscriptions: [{ state: 'expired', lastAcceptedAt: null }], truncated: false };
  const calls: URL[] = [];
  mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input); calls.push(url);
    if (url.pathname === '/oauth/connection-notices') return Response.json({ notices: [] });
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(url.pathname, '/oauth/events/status');
    assert.equal(url.searchParams.get('orgId'), 'workspace/a');
    return Response.json(health);
  });
  const server = createZiggsMcpServer(creds, {});
  const client = new Client({ name: 'status-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const tool = (await surfaceTools(client)).find(t => t.name === 'ziggs_notification_status');
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.ok((tool.inputSchema.required as string[]).includes('orgId'));
    const result = await callZiggsTool(client, 'ziggs_notification_status', { orgId: 'workspace/a' });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.deepEqual(JSON.parse((result.content as Array<{text: string}>)[0].text), health);
    assert.equal(calls.filter(u => u.pathname === '/oauth/events/status').length, 1);
  } finally { await client.close(); await server.close(); }
});

it('connection observation and notification tools preserve backend error codes', async () => {
  const claims = { connectionClientId: 'client', keyId: 'key' };
  const creds: Creds = { operatorKey: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`, agentId: '' };
  mock.method(globalThis, 'fetch', async (input: string | URL) => {
    if (new URL(input).pathname === '/oauth/connection-notices') return Response.json({ notices: [] });
    return Response.json({ code: 'INBOX_OBSERVATION_BUSY', message: 'Retry with the same cursor' }, { status: 429 });
  });
  const server = createZiggsMcpServer(creds, {});
  const client = new Client({ name: 'error-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    for (const [tool, args] of [['ziggs_inbox_changes', { cursor }], ['ziggs_notification_status', { orgId: 'one' }]] as const) {
      const result = await callZiggsTool(client, tool, args);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /INBOX_OBSERVATION_BUSY/);
    }
  } finally { await client.close(); await server.close(); }
});

for (const connection of [false, true]) {
  it(`preserves the stream-limit recovery cursor on the ${connection ? 'connection' : 'agent'} tool`, async () => {
    const claims = connection ? { connectionClientId: 'client', keyId: 'key' } : { boundAgentId: 'agent' };
    const creds: Creds = { operatorKey: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`, agentId: 'agent' };
    mock.method(globalThis, 'fetch', async (input: string | URL) => {
      if (new URL(input).pathname === '/oauth/connection-notices') return Response.json({ notices: [] });
      return Response.json({ code: 'INBOX_OBSERVATION_LIMIT', message: 'Reuse your cursor', recoveryCursor: cursor }, { status: 429 });
    });
    const server = createZiggsMcpServer(creds, { directConnection: !connection });
    const client = new Client({ name: 'recovery-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const result = await callZiggsTool(client, 'ziggs_inbox_changes', {});
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { error: { code: 'INBOX_OBSERVATION_LIMIT', message: 'Reuse your cursor', recoveryCursor: cursor } });
    } finally { await client.close(); await server.close(); }
  });
}
