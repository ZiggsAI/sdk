import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { withAssistantRequest } from '../src/http/operatorHeaders.js';
import {
  BUCKET_CAPABILITIES,
  bucketAddMembersCapability,
  bucketCreateCapability,
  bucketInsertCapability,
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
    const calls = record({ bucketId: 'bkt_1' });
    await bucketCreateCapability.handler({ name: 'Q3', audience: ['mia'] }, env);
    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.url ?? '', /\/buckets$/);
    assert.deepEqual(calls[0]?.body, { name: 'Q3', audience: ['mia'] });
    assert.equal(calls[0]?.headers['X-Agent-Id'], 'agent-a');
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

  it('adds members and removes one by the member routes', async () => {
    const calls = record({});
    await bucketAddMembersCapability.handler({ bucketId: 'bkt_1', principalIds: ['ben'] }, env);
    await bucketRemoveMemberCapability.handler({ bucketId: 'bkt_1', principalId: 'ben' }, env);
    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.url ?? '', /\/buckets\/bkt_1\/members$/);
    assert.deepEqual(calls[0]?.body, { principalIds: ['ben'] });
    assert.equal(calls[1]?.method, 'DELETE');
    assert.match(calls[1]?.url ?? '', /\/buckets\/bkt_1\/members\/ben$/);
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
