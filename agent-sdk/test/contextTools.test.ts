import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  contextReadTool,
  openTool,
  contextDelegateTool,
  contextExpandReachTool,
  contextDiscoverGrantableTool,
  CONTEXT_TOOLS,
} from '../src/platform/tools/tier2/contextTools.js';

type FetchCall = { url: string; opts: { method?: string; headers?: Record<string, string>; body?: string } };

/** Stub globalThis.fetch, capture calls, return a canned JSON body. */
function stubFetch(t: { after: (fn: () => void) => void }, body: unknown, ok = true, status = 200): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (url: unknown, opts: unknown) => {
    calls.push({ url: String(url), opts: (opts || {}) as FetchCall['opts'] });
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

const CTX = { operatorKey: 'opk.abc', agentId: 'agent_7' };

test('CONTEXT_TOOLS bundles read, open, access_explain, delegate, expand_reach, discover_grantable (grant listing moved to grant_list, ZIG-893; negative-space added ZIG-754)', () => {
  const names = CONTEXT_TOOLS.map((tool) => tool.schema.function['name']);
  assert.deepEqual(names, [
    'context_read',
    'open',
    'access_explain',
    'access_request',
    'context_delegate',
    'context_expand_reach',
    'context_discover_grantable',
  ]);
});

test('context_read schema mirrors ziggs_context_read contract', () => {
  const fn = contextReadTool.schema.function;
  const params = fn['parameters'] as { properties: Record<string, { enum?: string[] }>; required: string[] };
  assert.deepEqual(params.required, ['type', 'via']);
  assert.deepEqual(params.properties['type'].enum, ['messages', 'artifacts', 'agreements', 'tasks']);
  assert.deepEqual(params.properties['direction'].enum, ['forward', 'backward']);
  for (const p of ['cursor', 'after', 'direction', 'limit', 'state', 'contextGrantId']) {
    assert.ok(params.properties[p], `missing param ${p}`);
  }
});

test('context tools require operatorKey and agentId', async () => {
  await assert.rejects(() => contextReadTool.handler({ type: 'messages', via: 'chat:c1' }, {}), /operatorKey missing/);
  await assert.rejects(
    () => contextReadTool.handler({ type: 'messages', via: 'chat:c1' }, { operatorKey: 'opk.abc' }),
    /agentId missing/,
  );
  await assert.rejects(() => contextExpandReachTool.handler({ grantId: 'x' }, {}), /operatorKey missing/);
  // ZIG-956: the capability adapter checks creds before the handler validates params.
  await assert.rejects(() => contextDelegateTool.handler({}, {}), /operatorKey missing/);
});

test('context_read GETs /context/read/:type with via, paging, and grant-pin headers', async (t) => {
  const envelope = { type: 'messages', via: { kind: 'chat', id: 'c1' }, items: [{ id: 'm1' }], hasMore: false, nextCursor: null };
  const calls = stubFetch(t, envelope);

  const res = await contextReadTool.handler(
    { type: 'messages', via: 'chat:c1', limit: 5, cursor: 'cur1', contextGrantId: 'xgr_9' },
    CTX,
  );

  assert.deepEqual(res, envelope);
  const { url, opts } = calls[0];
  assert.match(url, /\/context\/read\/messages\?/);
  assert.match(url, /via=chat%3Ac1/);
  assert.match(url, /limit=5/);
  assert.match(url, /cursor=cur1/);
  assert.match(url, /contextGrantId=xgr_9/);
  assert.equal(opts.headers?.['Authorization'], 'Bearer opk.abc');
  assert.equal(opts.headers?.['X-Agent-Id'], 'agent_7');
  assert.equal(opts.headers?.['X-Context-Grant-Id'], 'xgr_9');
});

test('context_read rejects unknown type and bad direction before hitting the wire', async (t) => {
  const calls = stubFetch(t, {});
  await assert.rejects(() => contextReadTool.handler({ type: 'bogus', via: 'chat:c1' }, CTX), /type must be one of/);
  await assert.rejects(
    () => contextReadTool.handler({ type: 'messages', via: 'chat:c1', direction: 'sideways' }, CTX),
    /direction must be "forward" or "backward"/,
  );
  assert.equal(calls.length, 0);
});

// ZIG-1075 — the `via` grammar was stated three times (backend regex, client
// type, tool prose) and kept in step by nothing. One list now feeds all three,
// which means the tool can refuse a wrong pairing HERE, with the reason, instead
// of the caller learning it as a bare 400 a round-trip away.
test('context_read refuses a via kind the type cannot read, naming what it accepts', async (t) => {
  const calls = stubFetch(t, {});

  await assert.rejects(
    () => contextReadTool.handler({ type: 'messages', via: 'task:tsk_1' }, CTX),
    /messages reads accept via=chat:<id> — not task:<id>/,
  );
  await assert.rejects(
    () => contextReadTool.handler({ type: 'artifacts', via: 'wallet:wal_1' }, CTX),
    /via must be <kind>:<id>/,
  );
  await assert.rejects(
    () => contextReadTool.handler({ type: 'messages', via: 'chat:' }, CTX),
    /via must be <kind>:<id>/,
  );

  assert.equal(calls.length, 0, 'refused before the wire, every time');
});

// The pairing an agent is TOLD about has to be the pairing the call accepts —
// hand-written prose is how those two came apart in the first place.
test('context_read describes the same via pairings it enforces', () => {
  const description = String(contextReadTool.schema.function['description']);
  assert.match(description, /messages via chat:<id>/);
  assert.match(description, /artifacts via chat:<id>, agreement:<id>, task:<id>, artifact:<id>/);
  assert.match(description, /tasks via agreement:<id>, task:<id>/);
});

test('context_delegate POSTs the delegate endpoint and returns granted result', async (t) => {
  const grant = { grantId: 'xgr_child', scope: { kind: 'chat', id: 'c1' }, caveats: [] };
  const calls = stubFetch(t, { grant });

  const res = await contextDelegateTool.handler(
    { parentGrantId: 'xgr_parent', holderId: 'agent_9', scopeKind: 'chat', scopeId: 'c1', temporal: 'from-now' },
    CTX,
  );

  // ZIG-956: shaped like the MCP twin — delegated + parent + human-readable bounds.
  assert.deepEqual(res, {
    status: 'delegated',
    outcome: 'ok',
    parentGrantId: 'xgr_parent',
    grant,
    bounds: { temporal: undefined, watermarkAt: undefined, expiresAt: undefined },
  });
  assert.match(calls[0].url, /\/context\/grants\/xgr_parent\/delegate$/);
  assert.equal(calls[0].opts.method, 'POST');
  const sent = JSON.parse(calls[0].opts.body as string);
  assert.deepEqual(sent.scope, { kind: 'chat', id: 'c1' });
  assert.equal(sent.temporal, 'from-now');
});

test('context_delegate surfaces pending_approval instead of dropping it', async (t) => {
  stubFetch(t, { status: 'pending_approval', agreementId: 'agr_1', ownerId: 'user_1' });

  const res = await contextDelegateTool.handler(
    { parentGrantId: 'xgr_parent', holderId: 'agent_9', scopeKind: 'agreement', scopeId: 'a1', temporal: 'from-start' },
    CTX,
  );

  assert.deepEqual(res, {
    status: 'pending_approval',
    state: 'requested',
    outcome: 'pending',
    recoverable: true,
    message:
      "Requested, not granted — this grant's original owner must approve. Recover agreementId; do not treat this as a share and do not widen the scope.",
    parentGrantId: 'xgr_parent',
    agreementId: 'agr_1',
    ownerId: 'user_1',
  });
});

test('context_expand_reach GETs /context/grants/:id/reach and returns the reach map', async (t) => {
  const reach = {
    grantId: 'xgr_org',
    scope: { kind: 'org', id: 'org_acme' },
    chats: [{ id: 'c1', label: 'Chat c1' }],
    agreements: [{ id: 'a1', label: 'Ship it' }],
    truncatedChats: 3,
    truncatedAgreements: 0,
  };
  const calls = stubFetch(t, reach);

  const res = await contextExpandReachTool.handler({ grantId: 'xgr_org' }, CTX);

  assert.deepEqual(res, reach);
  const { url, opts } = calls[0];
  assert.match(url, /\/context\/grants\/xgr_org\/reach$/);
  assert.equal(opts.method ?? 'GET', 'GET');
  assert.equal(opts.headers?.['Authorization'], 'Bearer opk.abc');
  assert.equal(opts.headers?.['X-Agent-Id'], 'agent_7');
});

test('context_expand_reach requires grantId and creds before the wire', async (t) => {
  const calls = stubFetch(t, {});
  await assert.rejects(() => contextExpandReachTool.handler({}, CTX), /grantId is required/);
  await assert.rejects(
    () => contextExpandReachTool.handler({ grantId: 'x' }, {}),
    /operatorKey missing/,
  );
  assert.equal(calls.length, 0);
});

test('context_discover_grantable GETs /context/discovery/available and returns labels-only items (ZIG-754)', async (t) => {
  const items = [
    { type: 'chat', label: 'Acme — org chat', scopeRef: { kind: 'chat', id: 'c9' }, orgId: 'org_acme' },
  ];
  const calls = stubFetch(t, { items });

  const res = await contextDiscoverGrantableTool.handler({}, CTX);

  assert.deepEqual(res, { count: 1, items: items.map(item => ({ ...item, actions: [{ kind: 'request_access', tool: 'access_request', args: { scopeKind: 'chat', scopeId: 'c9' }, requiredInput: ['reason', 'recipientId'], effect: 'request_only', requiresApproval: true }] })) });
  const { url, opts } = calls[0];
  assert.match(url, /\/context\/discovery\/available$/);
  assert.equal(opts.method ?? 'GET', 'GET');
  assert.equal(opts.headers?.['Authorization'], 'Bearer opk.abc');
  assert.equal(opts.headers?.['X-Agent-Id'], 'agent_7');
});

test('context_discover_grantable requires creds before the wire (ZIG-754)', async (t) => {
  const calls = stubFetch(t, { items: [] });
  await assert.rejects(() => contextDiscoverGrantableTool.handler({}, {}), /operatorKey missing/);
  assert.equal(calls.length, 0);
});

test('context_delegate validates temporal and scopeKind', async (t) => {
  const calls = stubFetch(t, {});
  await assert.rejects(
    () => contextDelegateTool.handler({ temporal: 'whenever', scopeKind: 'chat', scopeId: 'c1', parentGrantId: 'p', holderId: 'h' }, CTX),
    /temporal must be/,
  );
  await assert.rejects(
    () => contextDelegateTool.handler({ temporal: 'from-now', scopeKind: 'planet', scopeId: 'c1', parentGrantId: 'p', holderId: 'h' }, CTX),
    /scopeKind must be/,
  );
  assert.equal(calls.length, 0);
});

test('open POSTs /context/open with a ref (ZIG-1874, ZIG-2179)', async (t) => {
  const body = {
    outcome: 'ok',
    ref: { kind: 'artifact', id: 'art_1' },
    access: {
      summary: 'You can read this.',
    },
    workContext: { laneId: null },
    actions: [],
  };
  const calls = stubFetch(t, body);
  const res = await openTool.handler({ ref: 'art_1' }, CTX);
  assert.equal((res as { outcome: string }).outcome, 'ok');
  assert.match(calls[0].url, /\/context\/open$/);
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body ?? '{}'), { ref: 'art_1' });
});


test('workspace summary requests use the existing artifact grant and read rails', async t => {
  const tool = CONTEXT_TOOLS.find(tool => tool.schema.function.name === 'access_request')!;
  assert.equal(CONTEXT_TOOLS.some(tool => tool.schema.function.name === 'workspace_read'), false);
  const calls = stubFetch(t, { status: 'pending_approval', agreementId: 'ask-1', accessGranted: false, scope: { kind: 'artifact', id: 'summary-1' } });
  const result = await tool.handler({ scopeKind: 'artifact', agreementId: 'hire-2', chatId: 'customer-chat', recipientId: 'customer', reason: 'Read the workspace summary and its updates', durationHours: 24 }, CTX) as { accessGranted: boolean; resumeAfterApproval: unknown };
  assert.equal(result.accessGranted, false);
  assert.deepEqual(result.resumeAfterApproval, { tool: 'open', args: { ref: 'summary-1' } });
  assert.equal(JSON.parse(calls[0].opts.body!).agreementId, 'hire-2');
  assert.equal(JSON.parse(calls[0].opts.body!).scopeId, undefined);
  await assert.rejects(() => tool.handler({ scopeKind: 'chat', agreementId: 'hire-2', reason: 'test', recipientId: 'customer' }, CTX), /Provide scopeId/);
  assert.equal(calls.length, 1);
});
