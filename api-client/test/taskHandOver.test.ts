import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, isHeldTaskCreate } from '../src/http/TaskClient.js';

const creds = { operatorKey: 'test-key', agentId: 'front-desk' };

// A task asked from a run that cannot reach its agreement waits on
// the agent's owner. That is an answer, not a malformed response.
test('a task kept waiting for the owner comes back as held, not as an error', async t => {
  const held = {
    status: 'pending_approval',
    handOver: { agreementId: 'ACARD01', approverId: 'user-yoav' },
    message: 'Not made yet.',
  };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(held), { status: 201 }));
  const result = await createTask({ agreementId: 'AWORK01', assigneeId: 'roeto-onboarding', description: 'New client' }, creds);
  assert.ok(isHeldTaskCreate(result));
  assert.deepEqual(result, held);
});

test('a made task still comes back as the task', async t => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ status: 'created', task: { taskId: 'T1', agreementId: 'AWORK01', state: 'active' } }), { status: 201 }));
  const result = await createTask({ agreementId: 'AWORK01', description: 'Do it' }, creds);
  assert.equal(isHeldTaskCreate(result), false);
  assert.equal((result as { taskId: string }).taskId, 'T1');
});
