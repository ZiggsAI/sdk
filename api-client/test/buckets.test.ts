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
  bucketJoinCapability,
  bucketListCapability,
  bucketMoveCapability,
  bucketSendCapability,
  bucketReadCapability,
  bucketRemoveMemberCapability,
} from '../src/capabilities/buckets.js';
import { mcpDescription } from '../src/capabilities/mcpBriefs.js';
import { describeOperationError } from '../src/shared/operationError.js';
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
    await assert.rejects(bucketMoveCapability.handler({ bucketId: 'bkt_1', items: [{ kind: 'task', id: 't1' }] }, env), /Give to/);
  });

  it('never sends the selected run when changing a bucket', async () => {
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

  it('moves into a new bucket when given a name: a split', async () => {
    const calls = record({});
    await bucketMoveCapability.handler(
      { bucketId: 'bkt_1', name: 'For Scout', audience: ['scout'], items: [{ kind: 'message', id: 'm1' }] },
      env,
    );
    assert.match(calls[0]?.url ?? '', /\/buckets\/bkt_1\/split$/);
    assert.deepEqual(calls[0]?.body, { items: [{ kind: 'message', id: 'm1' }], name: 'For Scout', audience: ['scout'] });
    await assert.rejects(
      bucketMoveCapability.handler({ bucketId: 'bkt_1', to: 'bkt_2', name: 'X', items: [{ kind: 'task', id: 't1' }] }, env),
      /not both/,
    );
  });

  it('adds members with a share-or-split choice, and removes one', async () => {
    const calls = record({});
    await bucketAddMembersCapability.handler({ bucketId: 'bkt_1', principalIds: ['ben'] }, env);
    await bucketAddMembersCapability.handler({ bucketId: 'bkt_1', principalIds: ['acme'], onMisfit: 'share' }, env);
    await bucketAddMembersCapability.handler({ bucketId: 'bkt_1', principalIds: ['zoe'], onMisfit: 'split' }, env);
    await bucketRemoveMemberCapability.handler({ bucketId: 'bkt_1', principalId: 'ben' }, env);
    assert.match(calls[0]?.url ?? '', /\/buckets\/bkt_1\/members$/);
    assert.deepEqual(calls[0]?.body, { principalIds: ['ben'] });
    assert.deepEqual(calls[1]?.body, { principalIds: ['acme'], onMisfit: 'share' });
    assert.deepEqual(calls[2]?.body, { principalIds: ['zoe'], onMisfit: 'split' });
    assert.equal(calls[3]?.method, 'DELETE');
    assert.match(calls[3]?.url ?? '', /\/buckets\/bkt_1\/members\/ben$/);
    await assert.rejects(
      bucketAddMembersCapability.handler({ bucketId: 'bkt_1', principalIds: ['ben'], onMisfit: 'narrow' }, env),
      /share or split/,
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

  it('joins another bucket in, sharing only when asked', async () => {
    const calls = record({});
    await bucketJoinCapability.handler({ bucketId: 'bkt_1', from: 'bkt_2' }, env);
    await bucketJoinCapability.handler({ bucketId: 'bkt_1', from: 'bkt_2', onMisfit: 'share' }, env);
    assert.match(calls[0]?.url ?? '', /\/buckets\/bkt_1\/join$/);
    assert.deepEqual(calls.map((c) => c.body), [{ from: 'bkt_2' }, { from: 'bkt_2', onMisfit: 'share' }]);
    await assert.rejects(bucketJoinCapability.handler({ bucketId: 'bkt_1', from: 'bkt_2', onMisfit: 'split' }, env), /onMisfit is share/);
    await assert.rejects(bucketJoinCapability.handler({ bucketId: 'bkt_1' }, env), /from is required/);
  });

  it('sends inside a bucket under the selected run, with no audience', async () => {
    const calls = record({ outcome: 'created', message: { messageId: 'msg_1' } });
    await withAssistantRequest({ executionContextId: 'xec_1' }, () =>
      bucketSendCapability.handler(
        { bucketId: 'bkt_1', text: 'Numbers are in', recipients: ['ben'], intent: 'request', replyTo: 'msg_0', operationId: 'op-1' },
        env,
      ),
    );
    assert.match(calls[0]?.url ?? '', /\/buckets\/bkt_1\/send$/);
    assert.equal(calls[0]?.headers['X-Ziggs-Execution'], 'xec_1');
    assert.deepEqual(calls[0]?.body, {
      operationId: 'op-1',
      content: { text: 'Numbers are in' },
      deliveries: { kind: 'explicit', principalIds: ['ben'] },
      intent: 'request',
      relationships: { replyToMessageId: 'msg_0' },
    });
    await bucketSendCapability.handler({ bucketId: 'bkt_1', text: 'FYI' }, env);
    const fyi = calls[1]?.body as Record<string, unknown>;
    assert.match(String(fyi['operationId']), /^bucket-send-/);
    assert.equal(fyi['intent'], 'fyi');
    assert.ok(!('audience' in fyi));
    await assert.rejects(bucketSendCapability.handler({ bucketId: 'bkt_1', text: ' ' }, env), /text is required/);
  });

  it('lists the buckets you are in', async () => {
    const calls = record({ buckets: [] });
    await bucketListCapability.handler({}, env);
    assert.match(calls[0]?.url ?? '', /\/buckets$/);
  });

  it('refuses a malformed item before calling the server', async () => {
    const calls = record({});
    await assert.rejects(
      bucketInsertCapability.handler({ bucketId: 'bkt_1', items: [{ kind: 'room', id: 'r' }] }, env),
      /kind one of message, artifact, task$/,
    );
    // An agreement is not an item: it brings people in, it does not go in.
    await assert.rejects(
      bucketInsertCapability.handler({ bucketId: 'bkt_1', items: [{ kind: 'agreement', id: 'agr_1' }] }, env),
      /kind one of message, artifact, task$/,
    );
    await assert.rejects(bucketInsertCapability.handler({ bucketId: 'bkt_1', items: [] }, env), /non-empty/);
    assert.equal(calls.length, 0);
  });

  it('a refused add lists the misfits and the choices left, on both surfaces', async () => {
    // The body the server sends when someone being added cannot read an item.
    const misfit = { item: { kind: 'message', id: 'msg_1' }, reason: 'members-cannot-read', memberIds: ['ben'] };
    const refusal = {
      error: 'Someone being added cannot read everything in this bucket.',
      code: 'BUCKET_MEMBERS_CANNOT_READ',
      choices: ['share', 'split'],
      impact: { misfits: [misfit], shared: [] },
    };
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(refusal), { status: 409 }));
    const thrown = await bucketAddMembersCapability.handler({ bucketId: 'bkt_1', principalIds: ['ben'] }, env).then(
      () => assert.fail('expected a refusal'),
      (error: unknown) => error,
    );
    for (const surface of ['sdk', 'mcp'] as const) {
      assert.deepEqual(describeOperationError(thrown, surface), {
        code: 'BUCKET_MEMBERS_CANNOT_READ',
        message: 'bucket_add_members: Someone being added cannot read everything in this bucket.',
        choices: ['share', 'split'],
        impact: { misfits: [misfit], shared: [] },
      });
    }
  });
});
