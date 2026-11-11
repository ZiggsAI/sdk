import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passTaskOn } from '../src/http/TaskClient.js';
import { passTaskOnCapability } from '../src/capabilities/tasks.js';

const creds = { operatorKey: 'test-key', agentId: 'store-assistant' };

// A store manager's assistant asked the coordinator to approve a repair. She
// has not answered in time, so the assistant makes the operations director the
// assignee; from then on only he can finish it.
test('passing a task on names the new assignee on the task and says who has it', async t => {
  let seen: { url: string; method?: string; body: unknown } | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    seen = { url: String(url), method: init.method, body: JSON.parse(String(init.body)) };
    return new Response(
      JSON.stringify({ success: true, ok: true, status: 'updated', taskId: 'TFRYER1', agreementId: 'AMEMB01', state: 'active', assigneeId: 'director' }),
      { status: 200 },
    );
  });
  const confirm = await passTaskOn('TFRYER1', 'director', creds);
  assert.match(seen!.url, /\/tasks\/TFRYER1\/assignee$/);
  assert.equal(seen!.method, 'PUT');
  assert.deepEqual(seen!.body, { assigneeId: 'director' });
  assert.equal(confirm.taskId, 'TFRYER1');
  assert.equal(confirm.state, 'active');
  assert.equal(confirm.assigneeId, 'director');
});

test("a refused pass keeps the server's reason, so the agent knows who may pass it", async t => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(
      JSON.stringify({ statusCode: 403, message: 'only whoever works this task, or whoever asked for it, can pass it on' }),
      { status: 403 },
    ));
  await assert.rejects(
    passTaskOnCapability.handler({ taskId: 'TFRYER1', assigneeId: 'director' }, { creds, surface: 'sdk' }),
    /task_pass_on: .*only whoever works this task, or whoever asked for it/,
  );
});

test('the tool says what it does, who may call it and who it can go to', () => {
  const text = passTaskOnCapability.descriptions.sdk ?? '';
  assert.equal(passTaskOnCapability.names.mcp, 'ziggs_task_pass_on');
  assert.equal(passTaskOnCapability.annotation, 'destructive');
  assert.match(text, /only they can finish it/);
  assert.match(text, /a task you work or one you opened/);
  assert.match(text, /must be able to work under the task's agreement/);
  assert.deepEqual(
    Object.entries(passTaskOnCapability.params).filter(([, p]) => p.required).map(([k]) => k),
    ['taskId', 'assigneeId'],
  );
});
