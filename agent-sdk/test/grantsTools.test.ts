import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  listGrantsTool,
  GRANTS_TOOLS,
} from '../src/platform/tools/tier2/grantsTools.js';

type FetchCall = { url: string; opts: { method?: string; headers?: Record<string, string>; body?: string } };

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

/** A JWT-shaped operator key carrying `scopes` so unreadableRails can decode. */
function keyWithScopes(scopes: string[]): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ type: 'operator', scopes })}.sig`;
}

const ALL_RAILS = keyWithScopes(['context:read', 'connections:read', 'payments:read']);
const CTX = { operatorKey: ALL_RAILS, agentId: 'agent_7' };

test('GRANTS_TOOLS exposes a single always-available grant_list tool', () => {
  const names = GRANTS_TOOLS.map((tool) => tool.schema.function['name']);
  assert.deepEqual(names, ['grant_list']);
  assert.equal(listGrantsTool.isGenericFallback, true);
});

test('grant_list requires operatorKey and agentId', async () => {
  await assert.rejects(() => listGrantsTool.handler({}, {}), /operatorKey missing/);
  await assert.rejects(
    () => listGrantsTool.handler({}, { operatorKey: ALL_RAILS }),
    /agentId missing/,
  );
});

test('grant_list lists every rail via GET /grants, default health=active, no rail filter', async (t) => {
  const grants = [
    { grantId: 'xgr_1', scope: { kind: 'chat', id: 'c1' }, caveats: [], expiresAt: null, health: 'active' },
    { grantId: 'pg_1', scope: { kind: 'wallet', id: 'w1' }, caveats: [], expiresAt: null, health: 'active' },
  ];
  const calls = stubFetch(t, { items: grants, nextCursor: 'next_1', hasMore: true });

  const res = await listGrantsTool.handler({ cursor: 'cur0', limit: 10 }, CTX);

  // Full-scope key sees all rails, so no unreadableRails note.
  assert.deepEqual(res, { count: 2, grants, nextCursor: 'next_1' });
  const { url, opts } = calls[0];
  assert.match(url, /\/grants\?/);
  assert.doesNotMatch(url, /scopeKind=/);
  assert.match(url, /health=active/);
  assert.match(url, /cursor=cur0/);
  assert.match(url, /limit=10/);
  assert.equal(opts.headers?.['Authorization'], `Bearer ${ALL_RAILS}`);
  assert.equal(opts.headers?.['X-Agent-Id'], 'agent_7');
});

test('grant_list passes scopeKind (repeatable) and an explicit health', async (t) => {
  const calls = stubFetch(t, { items: [], nextCursor: null, hasMore: false });

  await listGrantsTool.handler(
    { scopeKind: ['chat', 'wallet'], health: 'revoked' },
    CTX,
  );

  const { url } = calls[0];
  assert.match(url, /scopeKind=chat/);
  assert.match(url, /scopeKind=wallet/);
  assert.match(url, /health=revoked/);
});

test('grant_list names rails the key cannot read instead of dropping them silently', async (t) => {
  // ZIG-956: the backend names the unreadable rails on GET /grants; the tool
  // passes them through instead of mirroring the scope table client-side.
  stubFetch(t, {
    items: [],
    nextCursor: null,
    hasMore: false,
    unreadableRails: [
      { rail: 'connection', requiredScope: 'connections:read' },
      { rail: 'wallet', requiredScope: 'payments:read' },
    ],
  });
  const contextOnly = keyWithScopes(['context:read']);

  const res = (await listGrantsTool.handler(
    {},
    { operatorKey: contextOnly, agentId: 'agent_7' },
  )) as { unreadableRails?: Array<{ rail: string; requiredScope: string }> };

  assert.deepEqual(res.unreadableRails, [
    { rail: 'connection', requiredScope: 'connections:read' },
    { rail: 'wallet', requiredScope: 'payments:read' },
  ]);
});

test('grant_list omits unreadableRails when the backend reports none', async (t) => {
  stubFetch(t, { items: [], nextCursor: null, hasMore: false });
  const contextOnly = keyWithScopes(['context:read']);

  const res = (await listGrantsTool.handler(
    { scopeKind: ['chat'] },
    { operatorKey: contextOnly, agentId: 'agent_7' },
  )) as { unreadableRails?: unknown };

  // Every requested rail was readable (or the backend predates ZIG-956).
  assert.equal('unreadableRails' in res, false);
});

test('grant_list validates scopeKind and health before the wire', async (t) => {
  const calls = stubFetch(t, {});
  await assert.rejects(
    () => listGrantsTool.handler({ scopeKind: ['bogus'] }, CTX),
    /scopeKind must be one of/,
  );
  await assert.rejects(
    () => listGrantsTool.handler({ health: 'zombie' }, CTX),
    /health must be one of/,
  );
  assert.equal(calls.length, 0);
});
