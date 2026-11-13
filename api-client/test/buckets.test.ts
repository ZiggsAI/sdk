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

  it('bucket_add_members with an agreementId invites that agreement, such as your own listing', async () => {
    const calls = record({ invited: true, bucket: { bucketId: 'bkt_1' }, added: [], shared: [], split: null });
    await bucketAddMembersCapability.handler({ bucketId: 'bkt_1', agreementId: ' agr_list ' }, env);
    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.url ?? '', /\/buckets\/bkt_1\/invites$/);
    assert.deepEqual(calls[0]?.body, { agreementId: 'agr_list' });
  });

  it('bucket_add_members takes principalIds or an agreementId, never both and never neither', async () => {
    record();
    for (const args of [{ bucketId: 'bkt_1', principalIds: ['ben'], agreementId: 'agr_1' }, { bucketId: 'bkt_1' }])
      await assert.rejects(bucketAddMembersCapability.handler(args, env));
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

  it('sends a page: saves the HTML and links that exact version, with no share', async () => {
    const calls = record({ artifactId: 'art_page', outcome: 'created', message: { messageId: 'msg_2', rootMessageId: 'msg_1' } });
    const html = '<!DOCTYPE html><html><body>Orders</body></html>';
    const sent = await bucketSendCapability.handler(
      { bucketId: 'bkt_1', text: 'Your order form', page: `  ${html}\n`, pageName: 'Orders', replyTo: 'msg_1', operationId: 'op-2' },
      env,
    ) as { page?: { artifactId: string; address: string } };
    assert.match(calls[0]?.url ?? '', /\/artifacts$/);
    assert.deepEqual(calls[0]?.body, {
      text: html, name: 'Orders', contentType: 'document', visibility: 'address', idempotencyKey: 'page-op-2',
    });
    const { createHash } = await import('node:crypto');
    assert.match(calls[1]?.url ?? '', /\/buckets\/bkt_1\/send$/);
    assert.deepEqual((calls[1]?.body as Record<string, unknown>)['relationships'], { replyToMessageId: 'msg_1' });
    assert.deepEqual((calls[1]?.body as Record<string, unknown>)['page'], {
      kind: 'artifact', id: 'art_page', sha256: createHash('sha256').update(html).digest('hex'),
    });
    assert.deepEqual(sent.page, { artifactId: 'art_page', address: '/pages/msg_1' });
    await assert.rejects(bucketSendCapability.handler({ bucketId: 'bkt_1', text: 'x', page: '<p>hi</p>', pageName: 'P' }, env), /full HTML document/);
    await assert.rejects(bucketSendCapability.handler({ bucketId: 'bkt_1', text: 'x', page: html }, env), /pageName is required/);
  });

  it('keeps the work a send is under: named, else the agreement the wake is under', async () => {
    const calls = record({ outcome: 'created', message: { messageId: 'msg_1' } });
    await bucketSendCapability.handler({ bucketId: 'bkt_1', text: 'Hi' }, { ...env, serviceAgreementId: 'agr_wake' });
    await bucketSendCapability.handler(
      { bucketId: 'bkt_1', text: 'Hi', agreementId: 'agr_named', taskId: 't_1' },
      { ...env, serviceAgreementId: 'agr_wake' },
    );
    await bucketSendCapability.handler({ bucketId: 'bkt_1', text: 'Hi' }, env);
    assert.deepEqual(
      calls.map((c) => (c.body as Record<string, unknown>)['mandate']),
      [{ agreementId: 'agr_wake' }, { agreementId: 'agr_named', taskId: 't_1' }, undefined],
    );
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
      /kind one of message, artifact, task, bucket$/,
    );
    // An agreement is not an item: it brings people in, it does not go in.
    await assert.rejects(
      bucketInsertCapability.handler({ bucketId: 'bkt_1', items: [{ kind: 'agreement', id: 'agr_1' }] }, env),
      /kind one of message, artifact, task, bucket$/,
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
