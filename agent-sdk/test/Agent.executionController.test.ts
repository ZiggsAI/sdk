import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import { claudeBrain } from '../src/brain/index.js';
import { defineTool } from '../src/tools/defineTool.js';
import type { TickInput, TickOutput } from '../src/brain/ZiggsBrain.js';

function host(t: TestContext, executionControl?: boolean) {
  let calls = 0;
  const results: any[] = [];
  const network: Array<{ url: string; method?: string; headers: any; body: any }> = [];
  const task = { taskId: 'task-a', agreementId: 'agreement-a', assigneeId: 'worker', state: 'active', description: 'Research' };
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    network.push({ url: String(url), method: init?.method, headers: init?.headers, body: JSON.parse(String(init?.body ?? '{}')) });
    let response: unknown = { ok: true, artifactId: 'artifact-a' };
    if (path.endsWith('/agreements/agreement-a')) response = { agreement: { agreementId: 'agreement-a', status: 'active', engagementKind: 'hire', parties: { provider: { actor: 'worker' } }, terms: {} } };
    if (path.endsWith('/tasks') || path.endsWith('/tasks/task-a')) response = { task };
    return new Response(JSON.stringify(response));
  });
  const agent = new Agent({
    agentId: 'worker', operatorKey: 'test-key', brain: claudeBrain({ anthropicKey: 'test-key' }),
    initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } },
    executionControl, inboxCatchUp: false, telemetryIngest: false,
    tools: [defineTool('research', {}, async (_args, context) => { calls++; return { taskId: context.executionTaskId }; })],
  });
  agent.brain = { workflow: agent.brain.workflow, tick: async ({ eff }: TickInput): Promise<TickOutput> => {
    results.push(await eff({ kind: 'tool-call', sessionId: 'room-a', name: 'research', args: {} }));
    return { ctx: {}, state: 'idle', parked: true, stateTimeoutUnhandled: false };
  } } as Agent['brain'];
  const internal = agent as any;
  internal.wakeSuppression = async () => null;
  internal.dropStaleCancelledAgreementSession = async () => {};
  internal.sessions.set('worker:room-a', { sessionId: 'room-a', ownAgentId: 'worker', state: 'idle' });
  t.after(() => agent.disconnect());
  return { agent, internal, results, network, calls: () => calls,
    run: (event: unknown) => internal._processEvent(event, 'worker:room-a') };
}

test('Claude agents mount execution control by default on live and replay paths', async t => {
  const f = host(t);
  await f.run({ type: 'message', messageId: 'message-a', text: 'Do work without an agreement' });
  await f.agent.replayWake({ sessionId: 'room-a', event: { type: 'message', messageId: 'message-b' } } as any);
  assert.equal(f.results.length, 2);
  for (const result of f.results) {
    assert.equal(result.ok, false);
    assert.match(result.error, /AGREEMENT_REQUIRED/);
  }
  assert.equal(f.calls(), 0);
});

test('the host can explicitly retain unmanaged execution', async t => {
  const f = host(t, false);
  await f.run({ type: 'message', messageId: 'message-a' });
  assert.equal(f.calls(), 1);
  assert.equal(f.results[0].ok, true);
});

test('live work creates a backend task, carries lane credentials and persists the binding', async t => {
  const f = host(t);
  await f.run({ type: 'message', messageId: 'message-a', agreementId: 'agreement-a', text: 'Research companies' });
  assert.equal(f.calls(), 1);
  assert.equal(f.results[0].execution.taskId, 'task-a');
  const created = f.network.filter(r => r.method === 'POST' && new URL(r.url).pathname.endsWith('/tasks'));
  assert.equal(created.length, 1);
  assert.equal(created[0].body.agreementId, 'agreement-a');
  assert.equal(created[0].body.assigneeId, 'worker');
  const headers = new Headers(created[0].headers);
  assert.ok(headers.get('idempotency-key'));
  assert.ok(headers.get('x-ziggs-lane')?.includes('room-a'));
  const ctx = f.internal.sessions.get('worker:room-a').ctx;
  assert.equal(ctx.activeTaskId, 'task-a');
  assert.equal(ctx.tasks['task-a'].agreementId, 'agreement-a');
});
