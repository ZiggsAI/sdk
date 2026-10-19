import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentTaskOutcome } from '@ziggs-ai/api-client';

const mockArgs = (m: { mock: { calls: unknown[] } }) =>
  (m.mock.calls as Array<{ arguments: unknown[] }>)[0].arguments;

const expect_ = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`expected ${what}`);
};

const FAKE_TASK   = { taskId: 'tsk_test', state: 'active', agreementId: 'agr_test' };
const FAKE_RESULT = { acquired: true, task: FAKE_TASK };
const CREDS       = { operatorKey: 'opk.test', agentId: 'agent-test' };

test('TaskService', async (t) => {
  const mockCreateTask           = t.mock.fn(async () => FAKE_TASK);
  const mockGetTask              = t.mock.fn(async () => FAKE_TASK);
  const mockGetActiveForAgent    = t.mock.fn(async () => [FAKE_TASK]);
  const mockGetActiveForChat     = t.mock.fn(async () => [FAKE_TASK]);
  const mockGetSubtasks          = t.mock.fn(async () => [FAKE_TASK]);
  const mockUpdateTaskState  = t.mock.fn(async () => FAKE_TASK);
  const mockUpdatePlanStep   = t.mock.fn(async () => FAKE_TASK);
  const mockUpdatePlanSteps  = t.mock.fn(async () => FAKE_TASK);
  const mockCancelTask       = t.mock.fn(async () => FAKE_TASK);
  const mockReportTask       = t.mock.fn(async () => FAKE_TASK);
  const mockSetSatisfaction  = t.mock.fn(async () => FAKE_TASK);
  const mockCountTasks       = t.mock.fn(async () => 7);

  t.mock.module('@ziggs-ai/api-client', {
    namedExports: {
      createTask:              mockCreateTask,
      getTask:                 mockGetTask,
      getActiveTasksForAgent:  mockGetActiveForAgent,
      getActiveTasksForChat:   mockGetActiveForChat,
      getSubtasks:             mockGetSubtasks,
      updateTaskState:     mockUpdateTaskState,
      updateTaskPlanStep:  mockUpdatePlanStep,
      // ZIG-1885: the bare waiting-on write goes through the patches call.
      updateTaskPlanSteps: mockUpdatePlanSteps,
      cancelTask:          mockCancelTask,
      acknowledgeTaskControl: t.mock.fn(async () => FAKE_TASK),
      reportTask:          mockReportTask,
      setTaskSatisfaction: mockSetSatisfaction,
      countTasks:          mockCountTasks,
      // ZIG-1879: the shared presenter — the SDK and MCP surfaces report a
      // finished task through the same one, so it is real here, not stubbed.
      presentTaskOutcome:  presentTaskOutcome,
      runtimeLog: { debug() {}, info() {}, warn() {}, error() {} },
      resetRuntimeLogLevelCache() {},
    },
  });

  const { TaskService } = await import('../src/platform/tasks/TaskService.js');

  // ── Constructor ─────────────────────────────────────────────────────────────

  await t.test('throws when operatorKey is missing', () => {
    assert.throws(
      () => new TaskService(null as unknown as string, 'agent-test'),
      /operatorKey is required/,
    );
  });

  await t.test('throws when agentId is missing', () => {
    assert.throws(
      () => new TaskService('opk.test', null as unknown as string),
      /agentId is required/,
    );
  });

  await t.test('stores creds with operatorKey and agentId', () => {
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);
    assert.deepEqual((svc as any).creds, CREDS);
  });

  // ── getTask ─────────────────────────────────────────────────────────────────

  await t.test('getTask forwards taskId and creds', async () => {
    mockGetTask.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.getTask('tsk_test');

    const [id, creds] = mockArgs(mockGetTask);
    assert.equal(id, 'tsk_test');
    assert.deepEqual(creds, CREDS);
    assert.deepEqual(result, FAKE_TASK);
  });

  // ── getActiveTasksForAgent / getActiveTasksForChat ──────────────────────────

  await t.test('getActiveTasksForAgent forwards agentId and creds', async () => {
    mockGetActiveForAgent.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.getActiveTasksForAgent('agent-filter');

    const [agentId, creds] = mockArgs(mockGetActiveForAgent);
    assert.equal(agentId, 'agent-filter');
    assert.deepEqual(creds, CREDS);
    assert.deepEqual(result, [FAKE_TASK]);
  });

  await t.test('getActiveTasksForChat forwards chatId and creds', async () => {
    mockGetActiveForChat.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.getActiveTasksForChat('chat-1');

    const [chatId, creds] = mockArgs(mockGetActiveForChat);
    assert.equal(chatId, 'chat-1');
    assert.deepEqual(creds, CREDS);
    assert.deepEqual(result, [FAKE_TASK]);
  });

  // ── getSubtasks ─────────────────────────────────────────────────────────────

  await t.test('getSubtasks forwards parentTaskId and creds', async () => {
    mockGetSubtasks.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    await svc.getSubtasks('tsk_parent');

    const [parentId, creds] = mockArgs(mockGetSubtasks);
    assert.equal(parentId, 'tsk_parent');
    assert.deepEqual(creds, CREDS);
  });

  // ── spawnUnderAgreement ─────────────────────────────────────────────────────

  await t.test('spawnUnderAgreement throws when agreementId is missing', async () => {
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);
    await assert.rejects(
      () => svc.spawnUnderAgreement(null as unknown as string, { description: 'test' }),
      /agreementId is required/,
    );
  });

  await t.test('spawnUnderAgreement merges agreementId into taskData and calls createTask', async () => {
    mockCreateTask.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);
    const taskData = { description: 'do work' };

    const result = await svc.spawnUnderAgreement('agr_test', taskData);

    const [payload, creds] = mockArgs(mockCreateTask);
    assert.deepEqual(payload, { ...taskData, agreementId: 'agr_test' });
    assert.deepEqual(creds, CREDS);
    assert.deepEqual(result, FAKE_TASK);
  });

  await t.test('spawnUnderAgreement forwards assigneeId (ZIG-586)', async () => {
    mockCreateTask.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);
    const taskData = { description: 'do work', assigneeId: 'agent-2' };

    await svc.spawnUnderAgreement('agr_test', taskData);

    const [payload] = mockArgs(mockCreateTask);
    assert.deepEqual(payload, { ...taskData, agreementId: 'agr_test' });
  });

  await t.test('spawnUnderAgreement forwards the wake-derived idempotencyKey (delivery law)', async () => {
    mockCreateTask.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);
    const taskData = { description: 'do work', idempotencyKey: 'wk_wake_s_1234' };

    await svc.spawnUnderAgreement('agr_test', taskData);

    // createTask lifts idempotencyKey out of the body into the Idempotency-Key
    // header — spawnUnderAgreement's job is only to pass it through intact.
    const [payload] = mockArgs(mockCreateTask);
    assert.deepEqual(payload, { ...taskData, agreementId: 'agr_test' });
  });

  // ── updateState ─────────────────────────────────────────────────────────────

  await t.test('updateState forwards taskId, state, and creds', async () => {
    mockUpdateTaskState.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    await svc.updateState('tsk_test', 'completed', 'done');

    const [id, state, , creds] = mockArgs(mockUpdateTaskState);
    assert.equal(id, 'tsk_test');
    assert.equal(state, 'completed');
    assert.deepEqual(creds, CREDS);
  });

  await t.test('ZIG-1879: updateState reports the outcome facts apart', async () => {
    mockUpdateTaskState.mock.resetCalls();
    mockUpdateTaskState.mock.mockImplementationOnce(async () => ({
      ok: true,
      taskId: 'tsk_test',
      state: 'completed',
      resultRecorded: true,
      effects: {
        resultRecorded: true,
        notified: ['user-buyer'],
        settlement: { metered: true, settled: false, reason: 'wallet_missing' },
        agreement: {
          agreementId: 'agr_test',
          billing: 'per_task',
          status: 'active',
          fulfilledNow: false,
        },
      },
    }));
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    const out = await svc.updateState('tsk_test', 'completed', { value: 42 });

    // The wake is queued, not read; the money did not move; the hire stands.
    assert.match((out as { handoff: string }).handoff, /Queued is not read/);
    assert.match((out as { metering: string }).metering, /No payment moved/);
    assert.match(
      (out as { agreement: string }).agreement,
      /does not end a hire/,
    );
    // The hosted surface lists its own work; ziggs_task_get is the MCP read.
    assert.equal((out as { next: Array<{ tool: string }> }).next[0].tool, 'task_list');
  });

  await t.test('ZIG-1885: a bare waiting-on needs no step to tick', async () => {
    mockUpdatePlanSteps.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    await svc.setWaitingOn('tsk_test', { kind: 'user', id: 'user-dana' });

    const [taskId, patches, creds, waitingOn] = mockArgs(mockUpdatePlanSteps);
    expect_(taskId === 'tsk_test', 'taskId');
    expect_(Array.isArray(patches) && (patches as unknown[]).length === 0, 'no steps');
    expect_(JSON.stringify(creds) === JSON.stringify(CREDS), 'creds');
    expect_(JSON.stringify(waitingOn) === JSON.stringify({ kind: 'user', id: 'user-dana' }), 'waitingOn');
  });

  await t.test('ZIG-1885: a tick carries the waiting-on in the same write', async () => {
    mockUpdatePlanStep.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    await svc.updatePlanStep('tsk_test', 's1', 'in_progress', undefined, {
      kind: 'user',
      id: 'user-dana',
    });

    // One write: the server clears waitingOn on progress that does not
    // restate it, so a second call would set it and immediately drop it.
    const args = mockArgs(mockUpdatePlanStep);
    expect_(args.length >= 6, 'waitingOn rides the same call');
    expect_(
      JSON.stringify(args[5]) === JSON.stringify({ kind: 'user', id: 'user-dana' }),
      'waitingOn value',
    );
  });

  await t.test('a result and a step tick carry what they drew on', async () => {
    mockUpdateTaskState.mock.resetCalls();
    mockUpdatePlanStep.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);
    const sources = [{ kind: 'artifact' as const, id: 'art_1' }];

    await svc.updateState('tsk_test', 'completed', { summary: 'done' }, 'k1', sources);
    await svc.updatePlanStep('tsk_test', 's1', 'completed', undefined, undefined, sources);

    const [, , data] = mockArgs(mockUpdateTaskState);
    expect_(
      JSON.stringify((data as { sources?: unknown }).sources) === JSON.stringify(sources),
      'the result write carries the sources',
    );
    expect_(
      JSON.stringify(mockArgs(mockUpdatePlanStep)[6]) === JSON.stringify(sources),
      'the step tick carries the sources',
    );
  });

  await t.test('updateState serializes object result to JSON string', async () => {
    mockUpdateTaskState.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);
    const obj = { value: 42 };

    await svc.updateState('tsk_test', 'completed', obj);

    const [, , data] = mockArgs(mockUpdateTaskState);
    assert.equal((data as Record<string, unknown>).result, JSON.stringify(obj, null, 2));
  });

  await t.test('updateState passes string result through unchanged', async () => {
    mockUpdateTaskState.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    await svc.updateState('tsk_test', 'completed', 'plain text');

    const [, , data] = mockArgs(mockUpdateTaskState);
    assert.equal((data as Record<string, unknown>).result, 'plain text');
  });

  await t.test('updateState omits result field when result is undefined', async () => {
    mockUpdateTaskState.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    await svc.updateState('tsk_test', 'failed');

    const [, , data] = mockArgs(mockUpdateTaskState);
    assert.deepEqual(data, {});
  });

  await t.test('updateState passes null result through as null', async () => {
    mockUpdateTaskState.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    await svc.updateState('tsk_test', 'completed', null);

    const [, , data] = mockArgs(mockUpdateTaskState);
    assert.equal((data as Record<string, unknown>).result, null);
  });

  // ── updatePlanStep ──────────────────────────────────────────────────────────

  await t.test('updatePlanStep forwards taskId, stepId, status, result, and creds', async () => {
    mockUpdatePlanStep.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.updatePlanStep('tsk_test', 'step-1', 'completed', 'shipped');

    const [id, stepId, status, res, creds] = mockArgs(mockUpdatePlanStep);
    assert.equal(id, 'tsk_test');
    assert.equal(stepId, 'step-1');
    assert.equal(status, 'completed');
    assert.equal(res, 'shipped');
    assert.deepEqual(creds, CREDS);
    assert.deepEqual(result, FAKE_TASK);
  });

  await t.test('updatePlanStep passes result through as undefined when omitted', async () => {
    mockUpdatePlanStep.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    await svc.updatePlanStep('tsk_test', 'step-2', 'in_progress');

    const [, , , res] = mockArgs(mockUpdatePlanStep);
    assert.equal(res, undefined);
  });

  // ── cancel ──────────────────────────────────────────────────────────────────

  await t.test('cancel forwards taskId and creds', async () => {
    mockCancelTask.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.cancel('tsk_test');

    const [id, creds] = mockArgs(mockCancelTask);
    assert.equal(id, 'tsk_test');
    assert.deepEqual(creds, CREDS);
    assert.deepEqual(result, FAKE_TASK);
  });

  // ── report ─────────────────────────────────────────────────────────────────

  await t.test('report forwards taskId, message, and creds', async () => {
    mockReportTask.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.report('tsk_test', 'stuck');

    const [id, msg, creds] = mockArgs(mockReportTask);
    assert.equal(id, 'tsk_test');
    assert.equal(msg, 'stuck');
    assert.deepEqual(creds, CREDS);
    assert.deepEqual(result, FAKE_TASK);
  });

  await t.test('report defaults message to empty string', async () => {
    mockReportTask.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    await svc.report('tsk_test');

    assert.equal(mockArgs(mockReportTask)[1], '');
  });

  // ── setSatisfaction ────────────────────────────────────────────────────────

  await t.test('setSatisfaction forwards taskId, satisfaction, and creds', async () => {
    mockSetSatisfaction.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.setSatisfaction('tsk_test', 'positive');

    const [id, sat, creds] = mockArgs(mockSetSatisfaction);
    assert.equal(id, 'tsk_test');
    assert.equal(sat, 'positive');
    assert.deepEqual(creds, CREDS);
    assert.deepEqual(result, FAKE_TASK);
  });

  // ── count ──────────────────────────────────────────────────────────────────

  await t.test('count forwards filters and creds', async () => {
    mockCountTasks.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);
    const filters = { state: 'active' };

    const result = await svc.count(filters);

    assert.deepEqual(mockArgs(mockCountTasks), [filters, CREDS]);
    assert.equal(result, 7);
  });

  await t.test('count defaults filters to empty object', async () => {
    mockCountTasks.mock.resetCalls();
    const svc = new TaskService(CREDS.operatorKey, CREDS.agentId);

    await svc.count();

    assert.deepEqual(mockArgs(mockCountTasks)[0], {});
  });
});
