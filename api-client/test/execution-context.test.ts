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
