import { delegateTask, returnTaskResult, refreshTaskReadiness } from '../src/http/TaskClient.js';
import { ArtifactsClient } from '../src/http/ArtifactsClient.js';
import { ContextGrantsClient } from '../src/http/ContextGrantsClient.js';
import { it, mock, afterEach } from 'node:test';
import { validateWorkExecution } from '../src/http/ExecutionContextClient.js';
import assert from 'node:assert/strict';
import { withWorkExecution, currentWorkExecution, buildOperatorHeaders } from '../src/http/operatorHeaders.js';
import { planInboxAck, planPartialInboxAck } from '../src/inboxAck.js';
import type { WorkExecutionContext } from '@ziggs-ai/contracts';

const context = (id: string): WorkExecutionContext => ({ contextId: id, actorId: 'agent', principalId: 'person', agreementId: 'agreement', position: 'provider', chatId: 'room', audienceRevision: 'revision', audienceIds: ['person'] });
it('carries execution through HTTP clients without mixing concurrent calls', async () => {
  await Promise.all(['one', 'two'].map(id => withWorkExecution(context(id), async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(currentWorkExecution()?.contextId, id);
    assert.equal(buildOperatorHeaders('key', 'agent')['X-Ziggs-Execution'], id);
  })));
  assert.equal(currentWorkExecution(), undefined);
  assert.equal(buildOperatorHeaders('key', 'agent')['X-Ziggs-Execution'], undefined);
});
it('keeps two responsibilities for one record in acknowledgements', () => {
  const deliveries = ['payer', 'provider'].map(id => ({ responsibilityId: id, resourceId: 'message', assigneeId: 'agent', ts: '2026-10-29T00:00:00Z', ackTo: 'token' }));
  const envelope = { ackTo: 'token', deliveries };
  assert.deepEqual(planInboxAck(envelope, { ownAgentId: 'agent' }), { allowed: true, handledDeliveryIds: ['payer', 'provider'] });
  assert.deepEqual(planPartialInboxAck(envelope, new Set(['payer']), { ownAgentId: 'agent' })?.handledDeliveryIds, ['payer']);
  assert.equal(planPartialInboxAck(envelope, new Set(['message']), { ownAgentId: 'agent' }), null);
  assert.deepEqual(planPartialInboxAck(envelope, new Set(['payer', 'provider']), { ownAgentId: 'agent' })?.handledDeliveryIds, ['payer', 'provider']);
});

afterEach(() => mock.restoreAll());
it('refuses to resume retained state after the server invalidates its context', async () => {
  mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>)['X-Ziggs-Execution'], 'old');
    return Response.json({ error: 'Audience changed', code: 'EXECUTION_CONTEXT_CHANGED' }, { status: 403 });
  });
  await assert.rejects(validateWorkExecution(context('old'), 'key', 'http://test'), { code: 'EXECUTION_CONTEXT_CHANGED' });
});

it('keeps the source execution on contribution review, approval requests and delivery', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>)['X-Ziggs-Execution'], 'source');
    calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ artifactId: 'output', agreementId: 'destination', outcome: 'created', status: 'pending_approval', accessGranted: false });
  });
  await withWorkExecution(context('source'), async () => {
    const artifacts = new ArtifactsClient('key', 'agent');
    await artifacts.reviewContribution('output', 'destination');
    await new ContextGrantsClient('key', 'agent').requestAccess({ scopeKind: 'artifact', scopeId: 'output', reason: 'Review this result', contributionTo: { kind: 'agreement', id: 'destination' }, releaseSource: { kind: 'artifact', id: 'private-input' } });
    await artifacts.contribute('output', 'destination');
  });
  assert.match(calls[0].url, /artifacts\/output\/contribution-review\?agreementId=destination$/);
  assert.deepEqual(calls[1].body.releaseSource, { kind: 'artifact', id: 'private-input' });
  assert.match(calls[2].url, /agreements\/destination\/contributions$/);
  assert.deepEqual(calls[2].body, { artifactId: 'output' });
});

it('keeps the selected execution and stable key through recursive task operations', async () => {
  const calls: Array<{ url: string; body: any; key?: string }> = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['X-Ziggs-Execution'], 'parent');
    calls.push({ url: String(url), body: JSON.parse(String(init.body)), key: headers['Idempotency-Key'] });
    return Response.json({ taskId: 'child', parentTaskId: 'parent', outcome: 'created' });
  });
  await withWorkExecution(context('parent'), async () => {
    const creds = { operatorKey: 'key', agentId: 'agent' };
    await delegateTask('parent', { agreementId: 'target', assigneeId: 'agent', instructionArtifactId: 'instructions', idempotencyKey: 'one-child' }, creds);
    await returnTaskResult('child', 'output', creds);
    await refreshTaskReadiness('parent', creds);
  });
  assert.match(calls[0].url, /tasks\/parent\/delegations$/);
  assert.equal(calls[0].key, 'one-child');
  assert.equal(calls[0].body.idempotencyKey, undefined);
  assert.deepEqual(calls[1].body, { artifactId: 'output' });
  assert.match(calls[2].url, /tasks\/parent\/readiness$/);
});
