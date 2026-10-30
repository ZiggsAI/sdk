const WAKE_LANE_HEADER = 'X-Ziggs-Lane';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureApiClient } from '@ziggs-ai/api-client';
import { PLAN_TOOLS, taskReplacePlanTool } from '../src/index.js';
import { ToolManager } from '../src/tools/ToolManager.js';

const CTX = { operatorKey: 'op_test', agentId: 'sales_inventory', chatId: 'chat_hire' };
const CONFIRM = { ok: true, taskId: 'tsk_1', state: 'in_progress', stepCount: 2 };

test('the public SDK exports a callable task plan replacement tool', async () => {
  assert.deepEqual(PLAN_TOOLS, [taskReplacePlanTool]);
  const manager = new ToolManager();
  manager.registerAll(PLAN_TOOLS);
  assert.equal(manager.getTool('task_replace_plan'), taskReplacePlanTool);
});

test('plan replacement persists approval ids and completed progress with the host credential and wake lane', async (t) => {
  configureApiClient({ httpUrl: 'https://api.example.test' });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(CONFIRM));
  });
  const steps = [
    {
      stepId: 'approval', description: 'Request buyer approval', order: 0,
      status: 'completed', result: { agreementId: 'agr_approval', notifiedAt: '2026-09-15T07:22:40Z' },
    },
    { stepId: 'handoff', description: 'Confirm approval and hand off', status: 'pending' },
  ];
  const manager = new ToolManager();
  manager.registerAll(PLAN_TOOLS);
  const result = await manager.executeTool('task_replace_plan', { taskId: 'tsk_1', steps }, CTX);
  assert.deepEqual(result, CONFIRM);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/tasks/tsk_1/plan');
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { steps });
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('Authorization'), 'Bearer op_test');
  assert.equal(headers.get('X-Agent-Id'), CTX.agentId);
  assert.equal(headers.get(WAKE_LANE_HEADER), null);
});

test('a synthetic agreement wake retains its lane when replacing a plan', async (t) => {
  let headers = new Headers();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    headers = new Headers(init.headers);
    return new Response(JSON.stringify(CONFIRM));
  });
  await taskReplacePlanTool.handler(
    { taskId: 'tsk_1', steps: [] },
    { ...CTX, chatId: undefined, sessionId: 'agrn-agr_hire' },
  );
  assert.equal(headers.get(WAKE_LANE_HEADER), null);
});

test('invalid plan input is refused before a request can replace existing steps', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(CONFIRM)));
  const manager = new ToolManager();
  manager.registerAll(PLAN_TOOLS);
  for (const args of [
    { taskId: 'tsk_1' },
    { taskId: 'tsk_1', steps: 'not a plan' },
    { taskId: 'tsk_1', steps: [{}] },
    { taskId: 'tsk_1', steps: [{ description: '   ' }] },
    { taskId: 'tsk_1', steps: [{ description: 'Approval', status: 'done' }] },
    { taskId: 'tsk_1', steps: [{ description: 'Approval', result: 'agr_approval' }] },
    { taskId: '   ', steps: [] },
  ]) {
    await assert.rejects(manager.executeTool('task_replace_plan', args, CTX), /Invalid args/);
  }
  await assert.rejects(taskReplacePlanTool.handler({ taskId: {}, steps: [] }, CTX), /taskId is required/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('plan replacement requires an acting agent credential and propagates backend refusal', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify({ message: 'Only the task assignee may replace its plan' }), { status: 403 },
  ));
  const args = { taskId: 'tsk_1', steps: [{ description: 'Approval' }] };
  await assert.rejects(taskReplacePlanTool.handler(args, {}), /operatorKey missing/);
  await assert.rejects(taskReplacePlanTool.handler(args, { operatorKey: 'op_test' }), /agentId missing/);
  assert.equal(fetchMock.mock.callCount(), 0);
  await assert.rejects(taskReplacePlanTool.handler(args, CTX), /Only the task assignee/);
  assert.equal(fetchMock.mock.callCount(), 1);
});
