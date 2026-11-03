import { it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import { InMemoryStore } from '../src/memory/MemoryStore.js';
import { currentWorkExecution } from '@ziggs-ai/api-client';
import type { WorkExecutionContext } from '@ziggs-ai/contracts';
import type { TickInput } from '../src/brain/ZiggsBrain.js';

afterEach(() => mock.restoreAll());
for (const kind of ['message', 'task'] as const) it(`the supported host isolates equal audiences for ${kind} actions, resumes across interfaces, and refuses revoked memory`, async () => {
  const memory = new InMemoryStore();
  const host = new Agent({ agentId: 'agent', operatorKey: 'key', anthropicKey: 'test', inboxCatchUp: false,
    initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } }, memory });
  const c = (id: string): WorkExecutionContext => ({ contextId: id, actorId: 'agent', principalId: 'person', agreementId: kind === 'task' ? 'deal' : null,
    position: kind === 'task' ? 'provider' : 'participant', taskId: kind === 'task' ? id : null, action: kind === 'task' ? { kind: 'task', id } : { kind: 'message', id }, audienceIds: ['person'], audienceRevision: 'current' });
  const contexts = new Map(['a', 'b'].map(id => [id, c(id)]));
  let revoked = false; let completeOnTick = false; let ticks = 0; const calls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const selected = new Headers(init?.headers).get('X-Ziggs-Execution');
    calls.push(`${String(url).split('/').pop()}:${selected}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(url).endsWith('/execution/attempt') && body.operation === 'finish') return Response.json({ ok: true });
    if (revoked) return Response.json({ code: 'EXECUTION_CONTEXT_CHANGED', message: 'Used input grant revoked' }, { status: 403 });
    if (String(url).endsWith('/execution/attempt')) return Response.json({ ...contexts.get(selected!), attemptId: 'attempt' });
    if (String(url).endsWith('/execution/context')) return Response.json(contexts.get(selected!));
    if (String(url).includes('/tasks/')) return Response.json({ task: { taskId: String(url).split('/').pop(), agreementId: 'deal', assigneeId: 'agent', state: 'active' } });
    return Response.json({});
  });
  const internals = host as any;
  host.brain = { workflow: { id: 'test', initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } } },
    async tick({ memory, ctx }: TickInput) {
      ticks++; const existing = await memory!.get('note');
      await memory!.put('note', currentWorkExecution()!.contextId);
      if (completeOnTick) revoked = true; // The owner accepted this turn's answer/outcome.
      return { ctx: { ...ctx, lastRead: existing }, state: 'idle', parked: true, stateTimeoutUnhandled: false,
        metrics: { llmCalls: 0, tokens: { input: 0, output: 0, total: 0 } } };
    } } as Agent['brain'];
  const handover = (id: string, navigation: string) => kind === 'task'
    ? host.handleResourceEvent({ kind: 'task-state', resourceId: id, taskId: id, agreementId: 'deal', addressId: navigation, executionContext: c(id) })
    : host.handleMessage('input', { messageId: `input-${ticks}`, sender: { id: 'person', type: 'user' }, addressId: navigation, executionContext: c(id) });
  for (const [id, navigation] of [['a', 'chat'], ['b', 'chat'], ['a', 'page']]) await handover(id, navigation);
  const state = (id: string) => [...internals.sessions.values()].find((session: any) => session.executionContext?.contextId === id) as any;
  assert.equal(state('b').ctx.lastRead, undefined);
  assert.equal(state('a').ctx.lastRead, 'a');
  assert.equal(ticks, 3);
  completeOnTick = true;
  await handover('a', 'page'); // Completing its own action must not turn a successful callback into failure.
  assert.equal(ticks, 4);
  await assert.rejects(handover('a', 'another-page'), /revoked/);
  assert.equal(ticks, 4);
  assert.equal(await memory.get('agent:note'), undefined);
  assert.equal(calls.at(-1), 'attempt:a');
});
