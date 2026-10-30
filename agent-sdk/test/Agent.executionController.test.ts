import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import { claudeBrain } from '../src/brain/index.js';
import { defineTool, toolName } from '../src/tools/defineTool.js';
import { ARTIFACT_TOOLS } from '../src/platform/tools/tier2/artifactTools.js';
import type { TickInput, TickOutput } from '../src/brain/ZiggsBrain.js';

function host(t: TestContext, executionControl?: boolean) {
  const calls: Array<{ args: Record<string, unknown>; context: Record<string, unknown> }> = [];
  const results: Array<Record<string, unknown>> = [];
  const network: Array<{ url: string; method?: string; headers: Headers }> = [];
  const task = { taskId: 'task-a', agreementId: 'agreement-a', assigneeId: 'worker', state: 'active', description: 'Research' };
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    network.push({ url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    let response: unknown = { ok: true, artifactId: 'artifact-a' };
    if (path.endsWith('/agreements/agreement-a')) response = { agreement: { agreementId: 'agreement-a', status: 'active', engagementKind: 'hire', parties: { provider: { actor: 'worker' } }, terms: {} } };
    if (path.endsWith('/tasks/task-a')) response = { task };
    return new Response(JSON.stringify(response));
  });
  const agent = new Agent({
    agentId: 'worker', operatorKey: 'test-key', brain: claudeBrain({ anthropicKey: 'test-key' }),
    initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } },
    executionControl, inboxCatchUp: false, telemetryIngest: false,
    tools: [
      ...ARTIFACT_TOOLS.filter((tool) => ['artifact_list', 'artifact_record'].includes(toolName(tool) ?? '')),
      defineTool('research', { q: 'string' }, async (args, context) => { calls.push({ args, context }); return 'done'; }),
    ],
  });
  let plan: Array<Record<string, unknown>> = [{ q: 'companies' }];
  agent.brain = { workflow: agent.brain.workflow, tick: async ({ eff }: TickInput): Promise<TickOutput> => {
    for (const args of plan) results.push(await eff({ kind: 'tool-call', sessionId: 'room-a', name: 'research', args }) as Record<string, unknown>);
    return { ctx: {}, state: 'idle', parked: true, stateTimeoutUnhandled: false };
  } } as Agent['brain'];
  const internal = agent as unknown as {
    wakeSuppression: unknown; dropStaleCancelledAgreementSession: unknown;
    sessions: Map<string, Record<string, unknown>>; _processEvent(event: unknown, laneKey: string): Promise<void>;
    toolManager: { getTool(name: string): { workTaskParam?: boolean; schema: { function: { parameters: { properties: Record<string, unknown> } } } } | null };
  };
  internal.wakeSuppression = async () => null;
  internal.dropStaleCancelledAgreementSession = async () => {};
  internal.sessions.set('worker:room-a', { sessionId: 'room-a', ownAgentId: 'worker', state: 'idle' });
  t.after(() => agent.disconnect());
  return { agent, internal, results, network, calls,
    setPlan: (next: Array<Record<string, unknown>>) => { plan = next; },
    run: (event: unknown) => internal._processEvent(event, 'worker:room-a') };
}

test('Claude agents mount execution control by default on live and replay paths, and the host opens no task', async t => {
  const f = host(t);
  await f.run({ type: 'message', messageId: 'message-a', agreementId: 'agreement-a', text: 'Do work' });
  await f.agent.replayWake({ sessionId: 'room-a', event: { type: 'message', messageId: 'message-b', agreementId: 'agreement-a' } } as never);
  assert.equal(f.results.length, 2);
  for (const result of f.results) {
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'TASK_REQUIRED');
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.network.filter(r => r.method === 'POST' && new URL(r.url).pathname.endsWith('/tasks')).length, 0);
});

test('the host can explicitly retain unmanaged execution', async t => {
  const f = host(t, false);
  await f.run({ type: 'message', messageId: 'message-a' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.results[0].ok, true);
  assert.equal(f.internal.toolManager.getTool('research')?.workTaskParam, undefined);
});

test('platform tools handed in through tools keep the platform classification', async t => {
  const f = host(t);
  assert.equal(f.internal.toolManager.getTool('artifact_list')?.workTaskParam, undefined);
  assert.equal(f.internal.toolManager.getTool('artifact_record')?.workTaskParam, undefined);
  f.setPlan([]);
  await f.run({ type: 'message', messageId: 'message-a' });
  const listed = await f.agent.eff({ kind: 'tool-call', sessionId: 'room-a', name: 'artifact_list', args: {} }) as Record<string, unknown>;
  assert.notEqual(listed.errorCode, 'TASK_REQUIRED');
});

test('a custom tool names the task it holds; the host verifies it in this lane, and the next wake names it again', async t => {
  const f = host(t);
  const tool = f.internal.toolManager.getTool('research');
  assert.equal(tool?.workTaskParam, true);
  assert.ok(tool && 'taskId' in tool.schema.function.parameters.properties);
  f.setPlan([{ q: 'companies', taskId: 'task-a' }]);
  await f.run({ type: 'message', messageId: 'message-a', text: 'Research companies' });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, { q: 'companies' });
  assert.equal(f.calls[0].context.executionTaskId, 'task-a');
  assert.deepEqual(f.results[0].execution, { agreementId: 'agreement-a', taskId: 'task-a' });
  const reads = f.network.filter(r => r.method === 'GET').map(r => new URL(r.url).pathname);
  assert.ok(reads.some(p => p.endsWith('/tasks/task-a')));
  assert.ok(reads.some(p => p.endsWith('/agreements/agreement-a')));
  // The host's own control read of a named task carries no lane; the controller's verification read does.
  assert.ok(f.network.some(r => new URL(r.url).pathname.endsWith('/tasks/task-a') && r.headers.get('x-ziggs-lane') === null));
  const ctx = f.internal.sessions.get('worker:room-a')!.ctx as { activeTaskId: string; tasks: Record<string, { agreementId: string }> };
  assert.equal(ctx.activeTaskId, 'task-a');
  assert.equal(ctx.tasks['task-a'].agreementId, 'agreement-a');
  // The saved task is information for the model, not the next wake's default.
  f.setPlan([{ q: 'founders' }]);
  await f.run({ type: 'message', messageId: 'message-b', text: 'And their founders' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.results[1].errorCode, 'TASK_REQUIRED');
  f.setPlan([{ q: 'founders', taskId: 'task-a' }]);
  await f.run({ type: 'message', messageId: 'message-c', text: 'And their founders' });
  assert.equal(f.calls.length, 2);
  assert.equal(f.results[2].ok, true);
  assert.equal(f.network.filter(r => r.method === 'POST' && new URL(r.url).pathname.endsWith('/tasks')).length, 0);
});
