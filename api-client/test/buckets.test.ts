import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { withAssistantRequest } from '../src/http/operatorHeaders.js';
import {
  BUCKET_CAPABILITIES,
  bucketAddMembersCapability,
  bucketCreateCapability,
  bucketDeleteCapability,
  bucketRenameCapability,
  bucketDuplicateCapability,
  bucketInsertCapability,
  bucketMoveCapability,
  bucketReadCapability,
  bucketRemoveMemberCapability,
  bucketSplitCapability,
} from '../src/capabilities/buckets.js';
import { mcpDescription } from '../src/capabilities/mcpBriefs.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';

const env: CapabilityEnv = {
  creds: { operatorKey: 'op_test', agentId: 'agent-a' },
  surface: 'mcp',
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function record(answer: unknown = {}): Call[] {
  const calls: Call[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  return calls;
}

describe('bucket tools', () => {
  afterEach(() => mock.restoreAll());

  it('every bucket tool has an MCP description', () => {
    for (const cap of BUCKET_CAPABILITIES) {
      assert.ok(mcpDescription(cap.names.mcp, cap.annotation).length <= 250, cap.names.mcp);
    }
  });

  it('creates a bucket with a name and audience, as the agent', async () => {
    const calls = record({ bucket: { bucketId: 'bkt_1' } });
    await bucketCreateCapability.handler({ name: 'Q3', audience: ['mia'] }, env);
    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.url ?? '', /\/buckets$/);
    assert.deepEqual(calls[0]?.body, { name: 'Q3', audience: ['mia'] });
    assert.equal(calls[0]?.headers['X-Agent-Id'], 'agent-a');
  });

  it('creates a bucket with items, and shares only when asked', async () => {
    const calls = record({});
    await bucketCreateCapability.handler(
      { name: 'Job', items: [{ kind: 'artifact', id: 'brief' }], share: true },
      env,
    );
    await bucketInsertCapability.handler({ bucketId: 'bkt_1', items: [{ kind: 'artifact', id: 'a1' }] }, env);
    assert.deepEqual(calls[0]?.body, { name: 'Job', items: [{ kind: 'artifact', id: 'brief' }], share: true });
    assert.deepEqual(calls[1]?.body, { items: [{ kind: 'artifact', id: 'a1' }] });
  });

  it('moves items into another bucket', async () => {
    const calls = record({});
    await bucketMoveCapability.handler({ bucketId: 'bkt_1', to: 'bkt_2', items: [{ kind: 'task', id: 't1' }] }, env);
    assert.match(calls[0]?.url ?? '', /\/buckets\/bkt_1\/move$/);
    assert.deepEqual(calls[0]?.body, { to: 'bkt_2', items: [{ kind: 'task', id: 't1' }] });
    await assert.rejects(bucketMoveCapability.handler({ bucketId: 'bkt_1', items: [{ kind: 'task', id: 't1' }] }, env), /to is/);
  });

  it('never sends the selected run: buckets are not part of a run yet', async () => {
    const calls = record({ inserted: [] });
    await withAssistantRequest({ executionContextId: 'xec_1' }, () =>
      bucketInsertCapability.handler({ bucketId: 'bkt_1', items: [{ kind: 'artifact', id: 'a1' }] }, env),
    );
    assert.equal(calls[0]?.headers['X-Ziggs-Execution'], undefined);
    assert.match(calls[0]?.url ?? '', /\/buckets\/bkt_1\/insert$/);
    assert.deepEqual(calls[0]?.body, { items: [{ kind: 'artifact', id: 'a1' }] });
  });

  it('reads the bucket and a page of its items in one call', async () => {
    const calls = record({ bucketId: 'bkt_1', items: [], nextCursor: null });
    const result = (await bucketReadCapability.handler({ bucketId: 'bkt_1', limit: 10 }, env)) as Record<string, unknown>;
    const urls = calls.map((c) => c.url).sort();
    assert.match(urls[0] ?? '', /\/buckets\/bkt_1$/);
    assert.match(urls[1] ?? '', /\/buckets\/bkt_1\/items\?limit=10$/);
    assert.ok('bucket' in result && 'items' in result && 'nextCursor' in result);
  });

  it('splits with a name and an optional audience', async () => {
    const calls = record({});
    await bucketSplitCapability.handler(
      { bucketId: 'bkt_1', name: 'For Scout', items: [{ kind: 'message', id: 'm1' }] },
      env,
    );
    assert.deepEqual(calls[0]?.body, { items: [{ kind: 'message', id: 'm1' }], name: 'For Scout' });
  });

  it('adds members with a share-or-narrow choice, and removes one', async () => {
    const calls = record({});
    await bucketAddMembersCapability.handler({ bucketId: 'bkt_1', principalIds: ['ben'] }, env);
    await bucketAddMembersCapability.handler({ bucketId: 'bkt_1', principalIds: ['acme'], onMisfit: 'share' }, env);
    await bucketRemoveMemberCapability.handler({ bucketId: 'bkt_1', principalId: 'ben' }, env);
    assert.match(calls[0]?.url ?? '', /\/buckets\/bkt_1\/members$/);
    assert.deepEqual(calls[0]?.body, { principalIds: ['ben'] });
    assert.deepEqual(calls[1]?.body, { principalIds: ['acme'], onMisfit: 'share' });
    assert.equal(calls[2]?.method, 'DELETE');
    assert.match(calls[2]?.url ?? '', /\/buckets\/bkt_1\/members\/ben$/);
    await assert.rejects(
      bucketAddMembersCapability.handler({ bucketId: 'bkt_1', principalIds: ['ben'], onMisfit: 'grant' }, env),
      /share or narrow/,
    );
  });

  it('duplicates, renames and deletes by their routes', async () => {
    const calls = record({});
    await bucketDuplicateCapability.handler({ bucketId: 'bkt_1', name: 'For Scout', audience: ['scout'] }, env);
    await bucketRenameCapability.handler({ bucketId: 'bkt_1', name: 'New' }, env);
    await bucketDeleteCapability.handler({ bucketId: 'bkt_1' }, env);
    assert.deepEqual(
      calls.map((c) => [c.method, c.url.replace(/^.*\/buckets/, '/buckets'), c.body]),
      [
        ['POST', '/buckets/bkt_1/duplicate', { name: 'For Scout', audience: ['scout'] }],
        ['PATCH', '/buckets/bkt_1', { name: 'New' }],
        ['DELETE', '/buckets/bkt_1', undefined],
      ],
    );
  });

  it('refuses a malformed item before calling the server', async () => {
    const calls = record({});
    await assert.rejects(
      bucketInsertCapability.handler({ bucketId: 'bkt_1', items: [{ kind: 'room', id: 'r' }] }, env),
      /kind one of message, artifact, task, agreement/,
    );
    await assert.rejects(bucketInsertCapability.handler({ bucketId: 'bkt_1', items: [] }, env), /non-empty/);
    assert.equal(calls.length, 0);
  });
});
