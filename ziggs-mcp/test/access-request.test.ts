import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { accessRequestCapability, openCapability, CONTEXT_CAPABILITIES } from '@ziggs-ai/api-client';
const env = { surface: 'mcp' as const, creds: { operatorKey: 'op', agentId: 'current-agent', laneId: 'original-room' }, baseUrl: 'http://localhost:3999' };
test('generic access request preserves identity, lane, exact permissions and original continuation', async () => {
  let sent: { url: string; init: RequestInit } | undefined;
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    sent = { url, init };
    return new Response(JSON.stringify({ status: 'pending_approval', agreementId: 'request', accessGranted: false }), { status: 201 });
  });
  try {
    const result = await accessRequestCapability.handler({ scopeKind: 'chat', scopeId: 'original-room', reason: 'Reply to Itay for Ido', permission: 'reply', temporal: 'from-start', durationHours: 2, idempotencyKey: 'same', recipientId: 'psn_ido' }, env) as Record<string, unknown>;
    assert.equal(sent?.url, 'http://localhost:3999/context/access/requests');
    assert.deepEqual(JSON.parse(String(sent?.init.body)), { scopeKind: 'chat', scopeId: 'original-room', reason: 'Reply to Itay for Ido', permission: 'reply', temporal: 'from-start', durationHours: 2, recipientId: 'psn_ido' });
    const headers = sent?.init.headers as Record<string, string>;
    assert.equal(headers['X-Agent-Id'], 'current-agent');
    assert.equal(headers['X-Ziggs-Lane'], undefined);
    assert.equal(headers['Idempotency-Key'], 'same');
    assert.equal(result.accessGranted, false);
    assert.equal(result.outcome, 'pending');
    assert.deepEqual(result.resumeAfterApproval, { tool: 'ziggs_open', args: { ref: 'original-room' } });
    assert.ok(CONTEXT_CAPABILITIES.includes(accessRequestCapability));
  } finally { fetchMock.mock.restore(); }
});
test('rejects wider permission and invalid lifetimes before making an HTTP call', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
  try {
    await assert.rejects(accessRequestCapability.handler({ scopeKind: 'agreement', scopeId: 'id', reason: 'read', permission: 'reply', recipientId: 'psn_ido' }, env), /Only chat/);
    await assert.rejects(accessRequestCapability.handler({ scopeKind: 'task', scopeId: 'id', reason: 'work', permission: 'work', recipientId: 'psn_ido' }, env), /Only agreement/);
    await assert.rejects(accessRequestCapability.handler({ scopeKind: 'chat', scopeId: 'id', reason: 'read', durationHours: 169, recipientId: 'psn_ido' }, env), /1 and 168/);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally { fetchMock.mock.restore(); }
});
test('open exposes request-only recovery and a separate original-scope resume after approval', async () => {
  let payload: unknown = { outcome: 'unreadable', ref: { kind: 'chat', id: 'original-room' }, access: { continuation: { request: { scopeKind: 'chat', scopeId: 'original-room', permission: 'read', temporal: 'from-start', durationHours: 24 } } } };
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload)));
  try {
    const result = await openCapability.handler({ ref: 'original-room' }, env) as { actions: Array<Record<string, unknown>> };
    assert.equal(result.actions[0].tool, 'ziggs_access_request');
    assert.equal(result.actions[0].effect, 'request_only');
    assert.deepEqual(result.actions[0].requiredInput, ['reason', 'recipientId']);
    payload = { outcome: 'ok', ref: { kind: 'agreement', id: 'request' }, access: {}, page: { items: [{ status: 'active', grantRequest: { primitive: 'context', kind: 'access-request', holderId: 'current-agent', scope: { kind: 'chat', id: 'original-room' } } }] } };
    const approved = await openCapability.handler({ ref: 'request' }, env) as { actions: Array<Record<string, unknown>> };
    assert.deepEqual(approved.actions[0].args, { ref: 'original-room' });
    assert.equal(approved.actions[0].tool, 'ziggs_open');
    assert.equal(fetchMock.mock.callCount(), 2);
  } finally { fetchMock.mock.restore(); }
});
test('work on an agreement is sent as permission=work', async () => {
  let body: unknown;
  const fetchMock = mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ status: 'pending_approval', agreementId: 'request', accessGranted: false, scope: { kind: 'agreement', id: 'hire' } }), { status: 201 });
  });
  try {
    await accessRequestCapability.handler({ scopeKind: 'agreement', scopeId: 'hire', reason: 'Start the trial', permission: 'work', recipientId: 'usr_ido' }, env);
    assert.deepEqual(body, { scopeKind: 'agreement', scopeId: 'hire', reason: 'Start the trial', permission: 'work', durationHours: 24, recipientId: 'usr_ido' });
  } finally { fetchMock.mock.restore(); }
});

// ZIG-2143 — nobody is asked by default (ZIG-2011), and the agent learns who it
// may ask from the server's refusal, which only gets sent if the request does.
test('a request that names nobody reaches the server, and its refusal lists who to ask', async () => {
  let body: Record<string, unknown> | undefined;
  const fetchMock = mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ statusCode: 400, message: 'Name who to ask in recipientId: psn_ido (Ido, the customer of this hire) or psn_min (your operator)' }), { status: 400 });
  });
  try {
    await assert.rejects(
      accessRequestCapability.handler({ scopeKind: 'chat', scopeId: 'room', reason: 'read the brief' }, env),
      /psn_ido.*psn_min/,
    );
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(body && 'recipientId' in body, false);
  } finally { fetchMock.mock.restore(); }
});

// ZIG-2143 — a recovery call is one the agent can run: its args plus the
// inputs it names in `required` pass the tool's own schema and reach the door.
test('the server’s recovery calls, filled with what they name, pass ziggs_access_request', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createZiggsMcpServer } = await import('../src/server.js');
  const server = createZiggsMcpServer({ operatorKey: 'op', agentId: 'current-agent' } as never, { directConnection: true, debugTools: false } as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'recovery', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  const sent: unknown[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/context/access/requests')) sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ status: 'pending_approval', agreementId: 'request', accessGranted: false }), { status: 201 });
  });
  const fill: Record<string, string> = { reason: 'read the brief', recipientId: 'psn_ido', chatId: 'room-with-owner' };
  // As ziggs_open returns them (backend resource-actions / context-open)…
  const recoveries = [
    { args: { scopeKind: 'chat', scopeId: 'room', permission: 'read', temporal: 'from-start', durationHours: 24 }, required: ['reason', 'recipientId'] },
    { args: { scopeKind: 'artifact', scopeId: 'art', permission: 'read', temporal: 'from-start', durationHours: 24 }, required: ['reason', 'recipientId', 'chatId'] },
  ];
  try {
    for (const r of recoveries) {
      const args = { ...r.args, ...Object.fromEntries(r.required.map((k) => [k, fill[k]])) };
      const result = await client.callTool({ name: 'ziggs_tool_write', arguments: { tool: 'ziggs_access_request', args } });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
    }
    assert.equal(sent.length, recoveries.length);
    for (const body of sent) assert.equal((body as { recipientId: string }).recipientId, 'psn_ido');
  } finally {
    fetchMock.mock.restore();
    await client.close();
  }
});


test('contribution requests preserve destination and named readers without granting access', async () => {
  let sent: Record<string, unknown> | undefined;
  const fetchMock = mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ status: 'pending_approval', agreementId: 'consent', accessGranted: false });
  });
  try {
    const contributionTo = { kind: 'chat', id: 'room' };
    const holders = [{ kind: 'agent', id: 'current-agent' }, { kind: 'user', id: 'owner' }];
    await accessRequestCapability.handler({ scopeKind: 'artifact', scopeId: 'result', chatId: 'room', reason: 'Use the approved result with the team', holders, contributionTo }, env);
    assert.deepEqual(sent?.contributionTo, contributionTo);
    assert.deepEqual(sent?.holders, holders);
    await assert.rejects(accessRequestCapability.handler({ scopeKind: 'artifact', scopeId: 'result', chatId: 'room', reason: 'use', contributionTo }, env), /named readers/);
  } finally { fetchMock.mock.restore(); }
});
