import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '@ziggs-ai/api-client';
import { ExecutionController, asWorkTool, executionControllers } from '../src/runtime/executionController.js';
import { defineTool, toolName } from '../src/tools/defineTool.js';
import { ToolManager } from '../src/tools/ToolManager.js';
import { createZiggsEffectHandler } from '../src/platform/ZiggsEffectHandler.js';

const research = asWorkTool(defineTool('research', { q: 'string' }, async () => 'research result'));
const heldTask = (overrides: Partial<Task> = {}): Task => ({
  taskId: 'task-a', agreementId: 'agreement-a', assigneeId: 'worker', state: 'active', description: 'Research', ...overrides,
} as Task);

function fixture() {
  let agreement: Record<string, unknown> | null = { agreementId: 'agreement-a', status: 'active', engagementKind: 'hire', parties: { provider: { actor: 'worker' } } };
  const tasks = new Map<string, Task>([['task-a', heldTask()]]);
  let readError: Error | undefined;
  const reads = { tasks: 0, agreements: 0 };
  const bound: string[] = [];
  const abort = new AbortController();
  const controller = new ExecutionController({
    agentId: 'worker', signal: abort.signal, onTaskBound: id => bound.push(id),
    readTask: async id => { reads.tasks++; if (readError) throw readError; const t = tasks.get(id); if (!t) throw new Error(`task ${id} unavailable`); return t; },
    readAgreement: async id => { reads.agreements++; if (readError) throw readError; return agreement?.agreementId === id ? agreement : null; },
  });
  return {
    controller, abort, bound, reads,
    setAgreement: (value: Record<string, unknown> | null) => { agreement = value; },
    setTask: (id: string, patch: Partial<Task>) => { tasks.set(id, { ...(tasks.get(id) ?? heldTask({ taskId: id })), ...patch }); },
    failReads: () => { readError = new Error('backend unavailable'); },
  };
}

test('agreeing, managing, reading and talking run without a task; nothing is read for them', async () => {
  const f = fixture();
  for (const name of ['context_snapshot', 'context_read', 'open', 'access_explain', 'agreement_propose', 'agreement_counter',
    'agreement_respond', 'agreement_claim', 'agreement_get', 'agreement_subcontract', 'agreement_fulfill', 'agreement_revoke',
    'task_create', 'task_list', 'task_cancel', 'chat_send', 'chat_open', 'wake_at', 'artifact_list', 'artifact_find',
    'artifact_share', 'artifact_attach', 'marketplace_view']) {
    const r = await f.controller.beforeTool(defineTool(name, {}, async () => ({})), { to: 'anyone', chatId: 'other-room', parentAgreementId: 'other' });
    assert.equal(r.binding, undefined, name);
  }
  assert.deepEqual(f.reads, { tasks: 0, agreements: 0 });
});

test('a custom tool is work: with no task to name it is refused and nothing is read or created', async () => {
  const f = fixture();
  await assert.rejects(f.controller.beforeTool(research, { q: 'companies' }), /TASK_REQUIRED/);
  assert.deepEqual(f.reads, { tasks: 0, agreements: 0 });
  assert.equal(f.controller.currentTaskId, null);
});

test('the agent names the task it holds; the handler never sees the name', async () => {
  const f = fixture();
  const properties = (research.schema.function.parameters as { properties: Record<string, unknown> }).properties;
  assert.ok('taskId' in properties);
  assert.equal(research.workTaskParam, true);
  const r = await f.controller.beforeTool(research, { q: 'companies', taskId: 'task-a' });
  assert.deepEqual(r.binding, { agreementId: 'agreement-a', taskId: 'task-a' });
  assert.deepEqual(r.args, { q: 'companies' });
  assert.deepEqual(f.bound, ['task-a']);
});

test('later calls keep working under the task last named, and every call re-reads it', async () => {
  const f = fixture();
  await f.controller.beforeTool(research, { q: 'a', taskId: 'task-a' });
  const r = await f.controller.beforeTool(research, { q: 'b' });
  assert.equal(r.binding?.taskId, 'task-a');
  assert.deepEqual(f.reads, { tasks: 2, agreements: 2 });
  assert.deepEqual(f.bound, ['task-a']);
});

test('a task from an earlier wake is never a default: each wake names the task, and a named task is verified, not trusted', async () => {
  const earlier = fixture();
  await earlier.controller.beforeTool(research, { q: 'a', taskId: 'task-a' });
  assert.equal(earlier.controller.currentTaskId, 'task-a');
  const next = fixture();
  await assert.rejects(next.controller.beforeTool(research, { q: 'a' }), /TASK_REQUIRED/);
  assert.equal((await next.controller.beforeTool(research, { q: 'a', taskId: 'task-a' })).binding?.taskId, 'task-a');
  const other = fixture();
  other.setTask('task-x', { assigneeId: 'someone-else' });
  await assert.rejects(other.controller.beforeTool(research, { q: 'a', taskId: 'task-x' }), /TASK_NOT_HELD/);
});

test('a task the agent opens for itself is the one it works under next; a task opened for someone else is not', async () => {
  const f = fixture();
  f.controller.observeTool('task_create', { task: heldTask({ taskId: 'task-other', assigneeId: 'someone-else' }) });
  await assert.rejects(f.controller.beforeTool(research, { q: 'a' }), /TASK_REQUIRED/);
  f.setTask('task-new', {});
  f.controller.observeTool('task_create', heldTask({ taskId: 'task-new' }));
  assert.equal(f.controller.currentTaskId, 'task-new');
  assert.equal((await f.controller.beforeTool(research, { q: 'a' })).binding?.taskId, 'task-new');
});

test('a task that is not held, closed or stopped cannot be worked', async () => {
  for (const [patch, code] of [
    [{ assigneeId: 'someone-else' }, /TASK_NOT_HELD/], [{ taskId: 'task-b' }, /TASK_NOT_HELD/],
    [{ state: 'completed' }, /TASK_NOT_RUNNABLE/], [{ state: 'failed' }, /TASK_NOT_RUNNABLE/], [{ state: 'cancelled' }, /TASK_NOT_RUNNABLE/],
    [{ control: { action: 'stop' } }, /TASK_NOT_RUNNABLE/],
  ] as Array<[Partial<Task>, RegExp]>) {
    const f = fixture();
    f.setTask('task-a', patch);
    await assert.rejects(f.controller.beforeTool(research, { q: 'a', taskId: 'task-a' }), code);
  }
});

test('a paused or held task refuses work but still takes its plan and its result', async () => {
  const setResult = defineTool('task_set_result', { taskId: 'string', state: 'string' }, async () => ({}));
  const planStep = defineTool('task_update_plan_step', { taskId: 'string' }, async () => ({}));
  for (const patch of [{ control: { action: 'pause' } }, { heldByDeps: true }, { heldByParentReview: true }, { closesBy: 'children' },
    { planReview: { executionAckStatus: 'pending' } }, { planReview: { midWorkAckStatus: 'pending' } }, { runIf: { outcome: 'held' } }, { state: 'pending' }] as Partial<Task>[]) {
    const f = fixture();
    f.setTask('task-a', patch);
    await assert.rejects(f.controller.beforeTool(research, { q: 'a', taskId: 'task-a' }), /TASK_NOT_RUNNABLE/);
    assert.equal((await f.controller.beforeTool(setResult, { taskId: 'task-a', state: 'failed' })).args.taskId, 'task-a');
    assert.equal((await f.controller.beforeTool(planStep, { taskId: 'task-a' })).binding?.taskId, 'task-a');
  }
});

test('inactive agreements, conversation links and store listings cannot authorize work', async () => {
  for (const patch of [{ status: 'draft' }, { status: 'cancelled' }, { status: 'fulfilled' }, { engagementKind: 'link' },
    { parties: { payer: { principal: 'everyone' } } }, null]) {
    const f = fixture();
    f.setAgreement(patch === null ? null : { agreementId: 'agreement-a', status: 'active', ...patch });
    await assert.rejects(f.controller.beforeTool(research, { q: 'a', taskId: 'task-a' }), /AGREEMENT_INACTIVE/);
  }
});

test('revocation and unavailable reads stop the next work call', async () => {
  const f = fixture();
  await f.controller.beforeTool(research, { q: 'a', taskId: 'task-a' });
  f.setAgreement({ agreementId: 'agreement-a', status: 'cancelled' });
  await assert.rejects(f.controller.beforeTool(research, { q: 'a' }), /AGREEMENT_INACTIVE/);
  f.failReads();
  await assert.rejects(f.controller.beforeTool(research, { q: 'a' }), /unavailable/);
});

test("a tool argument cannot borrow another agreement's authority while working a task", async () => {
  const f = fixture();
  for (const key of ['underAgreementId', 'mandateAgreementId', 'onBehalfOfAgreementId', 'parentAgreementId']) {
    await assert.rejects(f.controller.beforeTool(research, { q: 'a', taskId: 'task-a', [key]: 'other' }), /AGREEMENT_SCOPE_MISMATCH/);
    assert.equal((await f.controller.beforeTool(research, { q: 'a', taskId: 'task-a', [key]: 'agreement-a' })).binding?.agreementId, 'agreement-a');
  }
});

test('setting the result closes the binding; the next work call needs a task again', async () => {
  const f = fixture();
  await f.controller.beforeTool(research, { q: 'a', taskId: 'task-a' });
  f.controller.observeTool('task_set_result', { task: { taskId: 'task-a', state: 'completed' } });
  assert.equal(f.controller.currentTaskId, null);
  assert.equal(f.controller.closedTask, 'task-a');
  f.setTask('task-a', { state: 'completed' });
  await assert.rejects(f.controller.beforeTool(research, { q: 'a' }), /TASK_NOT_RUNNABLE/);
});

test('an aborted wake cannot start tools', async () => {
  const f = fixture();
  f.abort.abort();
  await assert.rejects(f.controller.beforeTool(defineTool('context_snapshot', {}, async () => ({})), {}), /EXECUTION_STOPPED/);
  await assert.rejects(f.controller.beforeTool(research, { q: 'a', taskId: 'task-a' }), /EXECUTION_STOPPED/);
});

test('the author can mark a custom tool conversation, or a platform tool work', async () => {
  const f = fixture();
  const explain = asWorkTool(defineTool('explain_service', {}, async () => 'hello', { execution: 'conversation' }));
  assert.equal(explain.workTaskParam, undefined);
  assert.equal((await f.controller.beforeTool(explain, {})).binding, undefined);
  const snapshot = defineTool('context_snapshot', {}, async () => ({}), { execution: 'work' });
  await assert.rejects(f.controller.beforeTool(snapshot, {}), /TASK_REQUIRED/);
});

test('a tool that already takes taskId keeps its own parameter, filled from the binding when omitted', async () => {
  const f = fixture();
  await f.controller.beforeTool(research, { q: 'a', taskId: 'task-a' });
  const fetchTool = asWorkTool(defineTool('fetch_brief', { taskId: 'string' }, async () => ({})));
  assert.equal(fetchTool.workTaskParam, undefined);
  assert.equal(toolName(fetchTool), 'fetch_brief');
  assert.deepEqual((await f.controller.beforeTool(fetchTool, {})).args, { taskId: 'task-a' });
});

function executor() {
  const manager = new ToolManager();
  const writes: Array<Record<string, unknown>> = [];
  const calls: Array<{ args: Record<string, unknown>; context: Record<string, unknown> }> = [];
  manager.register(asWorkTool(defineTool('research', { q: 'string' }, async (args, context) => { calls.push({ args, context }); return 'done'; })));
  const eff = createZiggsEffectHandler({
    toolManager: manager, agentId: 'worker', operatorKey: 'test-key', telemetryIngest: false,
    artifactsClient: { write: async (value: Record<string, unknown>) => { writes.push(value); return {}; } } as never,
    contextReadClient: {} as never, taskService: {} as never, agreementService: {} as never, messageSender: async () => ({}),
  });
  return { manager, writes, calls, eff };
}
const call = { kind: 'tool-call' as const, sessionId: 'room-a', name: 'research', args: { q: 'companies' } };

test('the real shared executor blocks the handler and returns a machine-readable refusal', async () => {
  const f = fixture();
  const e = executor();
  const result = await executionControllers.run(f.controller, () => e.eff(call));
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'TASK_REQUIRED');
  assert.match(result.error!, /TASK_REQUIRED/);
  assert.equal(e.calls.length, 0);
  assert.equal(e.writes.some(w => String(w.text).startsWith('operation_started:')), false);
});

test('the real shared executor hands the handler verified context and records task-scoped operations', async () => {
  const f = fixture();
  const e = executor();
  const result = await executionControllers.run(f.controller, () => e.eff({ ...call, args: { ...call.args, taskId: 'task-a' }, onBehalfOfAgreementId: 'forged' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.execution, { agreementId: 'agreement-a', taskId: 'task-a' });
  assert.deepEqual(e.calls[0].args, { q: 'companies' });
  assert.equal(e.calls[0].context.executionTaskId, 'task-a');
  assert.equal(e.calls[0].context.onBehalfOfAgreementId, 'agreement-a');
  assert.equal(e.calls[0].context.serviceAgreementId, 'agreement-a');
  assert.equal(e.writes.length, 2);
  for (const write of e.writes) {
    assert.equal(write.taskId, 'task-a');
    assert.equal(write.serviceAgreementId, 'agreement-a');
  }
});

test('nested tool calls cannot escape the controller, and unmounted clients are unchanged', async () => {
  const f = fixture();
  const e = executor();
  e.manager.register(defineTool('wrapper', {}, async (_args, context) => (context.eff as typeof e.eff)(call), { execution: 'conversation' }));
  const result = await executionControllers.run(f.controller, () => e.eff({ ...call, name: 'wrapper', args: {} }));
  assert.equal((result.result as { ok: boolean }).ok, false);
  assert.equal(e.calls.length, 0);
  // No controller: the tool runs, and the task name the host added is still kept from the handler.
  assert.equal((await e.eff({ ...call, args: { ...call.args, taskId: 'task-a' } })).ok, true);
  assert.deepEqual(e.calls[0].args, { q: 'companies' });
});

test('concurrent wakes keep separate controllers', async () => {
  const allowed = fixture();
  await allowed.controller.beforeTool(research, { q: 'a', taskId: 'task-a' });
  const refused = fixture();
  const e = executor();
  const results = await Promise.all([
    executionControllers.run(allowed.controller, () => e.eff(call)),
    executionControllers.run(refused.controller, () => e.eff(call)),
  ]);
  assert.deepEqual(results.map(r => r.ok), [true, false]);
  assert.equal(e.calls.length, 1);
});
