import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import type { TickInput, TickOutput } from '../src/brain/ZiggsBrain.js';
import type { TaskControl } from '@ziggs-ai/api-client';
import { currentWorkExecution, withWorkExecution } from '@ziggs-ai/api-client';

const request = (action: TaskControl['action'], requestId = 'request-1'): TaskControl => ({
  requestId, action, status: 'requested', requestedAt: new Date().toISOString(), acknowledgedAt: null,
});
const output = (): TickOutput => ({ ctx: { tasks: {} } as TickOutput['ctx'], state: 'idle', parked: true,
  stateTimeoutUnhandled: false, metrics: { llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } } });
function fixture(t: TestContext, tick: (input: TickInput) => Promise<TickOutput>) {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Task-control tests must not access the network'); });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const host = new Agent({ agentId: 'worker', operatorKey: 'test-key', anthropicKey: 'test-key',
    initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } }, taskTools: 'none', inboxCatchUp: false, telemetryIngest: false });
  host.brain = { workflow: { id: 'test', initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } } }, tick } as Agent['brain'];
  // Host seams only: no network, real _processEvent and real effect wrapper.
  const internal = host as any;
  let task: { assigneeId: string; state: string; control: TaskControl | null } = { assigneeId: 'worker', state: 'active', control: null };
  const acks: Array<{ id: string; toolsFinished: boolean }> = [];
  let toolsFinished = true;
  internal.taskService = {
    getTask: async () => task,
    acknowledgeControl: async (_taskId: string, id: string) => { acks.push({ id, toolsFinished }); },
  };
  internal.agreementService = {
    get: async (agreementId: string) => ({ agreementId, status: 'active', terms: {} }),
  };
  internal.wakeSuppression = async () => null;
  internal.dropStaleCancelledAgreementSession = async () => {};
  internal.sessions.set('worker:agrn-agr-1', { sessionId: 'agrn-agr-1', ownAgentId: 'worker', state: 'idle' });
  const run = (room = 'agrn-agr-1') => {
    const lane = `worker:${room}`;
    if (!internal.sessions.has(lane)) internal.sessions.set(lane, { sessionId: room, ownAgentId: 'worker', state: 'idle' });
    return internal._processEvent({ type: 'resource_changed', taskId: 't1', agreementId: 'agr-1', resource: { kind: 'task-state', taskId: 't1' } }, lane);
  };
  t.after(() => {
    host.disconnect();
    assert.equal(network.mock.callCount(), 0, 'task-control fixtures must stay offline');
  });
  return { internal, acks, run, setTask: (next: Partial<typeof task>) => { task = { ...task, ...next }; now += 1001; }, setToolsFinished: (value: boolean) => { toolsFinished = value; } };
}

test('a paused task remains paused after a cold start and does not call the model', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return output(); });
  f.setTask({ control: request('pause') });
  await f.run();
  assert.equal(calls, 0);
  assert.deepEqual(f.acks, [{ id: 'request-1', toolsFinished: true }]);
});

test('host control observation does not use the stopped work execution or expose task content', async t => {
  const f = fixture(t, async () => { assert.fail('host observation must not wake the model'); });
  f.internal.taskService.getTask = async () => {
    assert.equal(currentWorkExecution(), undefined);
    return { assigneeId: 'worker', state: 'active', control: request('pause'), description: 'private work' };
  };
  const context = { contextId: 'stopped-task' } as Parameters<typeof withWorkExecution>[0];
  await withWorkExecution(context, async () => {
    const result = await f.internal.taskExecutionControl('t1');
    assert.equal(result.blocked, true);
    assert.equal(result.control.requestId, 'request-1');
    assert.equal(result.description, undefined);
    assert.equal(currentWorkExecution()?.contextId, 'stopped-task');
  });
});

test('a blocked delivery acknowledges a resume once no run of the task is live, without waking the model', async t => {
  const f = fixture(t, async () => { assert.fail('host observation must not wake the model'); });
  const run = { abort: new AbortController() };
  f.internal.activeTaskRuns.set('t1', new Set([run]));
  f.setTask({ control: request('resume') });
  await f.internal.observeBlockedTaskControl('t1');
  assert.equal(f.acks.length, 0);
  assert.equal(run.abort.signal.aborted, false);
  f.internal.activeTaskRuns.delete('t1');
  await f.internal.observeBlockedTaskControl('t1');
  assert.deepEqual(f.acks, [{ id: 'request-1', toolsFinished: true }]);
  f.setTask({ control: { ...request('resume'), status: 'acknowledged' } });
  await f.internal.observeBlockedTaskControl('t1');
  f.setTask({ assigneeId: 'other-worker', control: request('resume', 'request-2') });
  await f.internal.observeBlockedTaskControl('t1');
  assert.equal(f.acks.length, 1);
});

test('checks before the next effect, interrupts the brain, and acknowledges after quiescence', async t => {
  let effects = 0;
  let observedSignal: AbortSignal | undefined;
  const f = fixture(t, async ({ eff, signal }) => {
    observedSignal = signal;
    await eff({ kind: 'read-context', sessionId: 'agrn-agr-1' });
    f.setTask({ control: request('pause') });
    await eff({ kind: 'send-message', sessionId: 'agrn-agr-1', receiverId: 'buyer', text: 'Should not send' });
    return output();
  });
  f.internal.eff = async () => { effects++; return {}; };
  await f.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(effects, 1);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(f.acks.length, 1);
});

test('does not acknowledge while an already-started parallel tool is running', async t => {
  let finish!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const toolDone = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(t, async ({ eff }) => {
    const active = eff({ kind: 'read-context', sessionId: 'agrn-agr-1' });
    await startedPromise;
    f.setTask({ control: request('pause') });
    // Simulate a brain ending on interruption while its parallel tool settles.
    void active.catch(() => {});
    await eff({ kind: 'read-context', sessionId: 'agrn-agr-1' });
    return output();
  });
  f.internal.eff = async () => { f.setToolsFinished(false); started(); await toolDone; f.setToolsFinished(true); return {}; };
  const running = f.run();
  await startedPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.acks.length, 0);
  finish();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.acks, [{ id: 'request-1', toolsFinished: true }]);
});

test('resume allows a new tick while another assignee’s pause cannot stop this agent', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return output(); });
  f.setTask({ control: request('resume') });
  await f.run();
  assert.equal(calls, 1);
  assert.equal(f.acks.length, 1);
  f.setTask({ assigneeId: 'other-worker', control: request('pause', 'request-2') });
  await f.run();
  assert.equal(calls, 2);
  assert.equal(f.acks.length, 1);
});

test('a cancelled task acknowledges Stop without another model call', async t => {
  const f = fixture(t, async () => { assert.fail('cancelled task must not run'); });
  f.setTask({ state: 'cancelled', control: request('stop') });
  await f.run();
  assert.equal(f.acks.length, 1);
});

test('a cancelled task leaves the room’s open tasks; a paused one keeps them', async t => {
  const f = fixture(t, async () => { assert.fail('held task must not run'); });
  const lane = () => f.internal.sessions.get('worker:agrn-agr-1');
  const books = () => ({ activeTaskId: 't1', activeAgreementId: 'agr-1', tasks: { t1: { agreementId: 'agr-1' } } });
  lane().ctx = books();
  f.setTask({ control: request('pause') });
  await f.run();
  assert.equal(lane().ctx.activeTaskId, null);
  assert.ok(lane().ctx.tasks.t1, 'a paused task is still open work');
  lane().ctx = books();
  f.setTask({ state: 'cancelled', control: null });
  await f.run();
  assert.equal(lane().ctx.tasks.t1, undefined);
  assert.equal(lane().ctx.activeTaskId, null);
  assert.equal(lane().ctx.activeAgreementId, null);
});

test('a superseded acknowledgement does not retry an old task wake', async t => {
  const f = fixture(t, async () => { assert.fail('paused task must not run'); });
  f.setTask({ control: request('pause') });
  f.internal.taskService.acknowledgeControl = async () => { throw Object.assign(new Error('superseded'), { status: 409 }); };
  await f.run();
});


test('a control event in another lane waits for the same task’s active tools', async t => {
  let finish!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(t, async ({ eff }) => {
    await eff({ kind: 'read-context', sessionId: 'agrn-agr-1' });
    return output();
  });
  f.internal.eff = async () => { f.setToolsFinished(false); started(); await done; f.setToolsFinished(true); return {}; };
  const running = f.run();
  await startedPromise;
  f.setTask({ control: request('pause') });
  const otherLane = f.run('another-room');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.acks.length, 0);
  finish();
  await Promise.all([running, otherLane]);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.acks.length > 0);
  assert.ok(f.acks.every(ack => ack.toolsFinished));
});


test('does not acknowledge pause until the existing session store has saved progress', async t => {
  let save!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const saved = new Promise<void>(resolve => { save = resolve; });
  const f = fixture(t, async () => { assert.fail('paused task must not run'); });
  f.internal.sessionStore = { load: async () => null, save: async () => { started(); await saved; } };
  f.setTask({ control: request('pause') });
  const running = f.run();
  await startedPromise;
  assert.equal(f.acks.length, 0);
  save();
  await running;
  assert.equal(f.acks.length, 1);
});


test('one paused task in a coalesced lane does not pause another task', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return output(); });
  f.internal.taskService.getTask = async (taskId: string) => ({
    taskId, assigneeId: 'worker', state: 'active', control: taskId === 't1' ? request('pause') : null,
  });
  await f.internal._processEvent({ type: 'batch', events: [
    { type: 'resource_changed', taskId: 't1', agreementId: 'agr-1' },
    { type: 'resource_changed', taskId: 't2', agreementId: 'agr-1' },
  ] }, 'worker:agrn-agr-1');
  assert.equal(calls, 1);
  assert.equal(f.acks.length, 1);
});

test('paused or cancelled focus never suppresses an unscoped room message', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return output(); });
  for (const state of ['active', 'cancelled']) {
    f.setTask({ state, control: request(state === 'active' ? 'pause' : 'stop') });
    f.internal.sessions.get('worker:agrn-agr-1').ctx = { activeTaskId: 't1', tasks: {} };
    f.internal.taskService.getTask = async () => { throw Object.assign(new Error('no access'), { status: 403 }); };
    await f.internal._processEvent({ type: 'message', text: 'Here is a new brief' }, 'worker:agrn-agr-1');
  }
  assert.equal(calls, 2);
});

test('unreadable structured task wakes are consumed and clear stale focus', async t => {
  const f = fixture(t, async () => { assert.fail('unreadable task cannot run'); });
  for (const status of [403, 404]) {
    f.internal.sessions.get('worker:agrn-agr-1').ctx = { activeTaskId: 't1', tasks: {} };
    f.internal.taskService.getTask = async () => { throw Object.assign(new Error('gone'), { status }); };
    await f.run();
    assert.equal(f.internal.sessions.get('worker:agrn-agr-1').ctx.activeTaskId, null);
  }
});

test('ordinary multi-task batches use one brain tick', async t => {
  let calls = 0;
  const f = fixture(t, async ({ event }) => { calls++; assert.equal((event as any).events.length, 2); return output(); });
  await f.internal._processEvent({ type: 'batch', events: [
    { type: 'resource_changed', taskId: 't1', agreementId: 'agr-1' },
    { type: 'resource_changed', taskId: 't2', agreementId: 'agr-1' },
  ] }, 'worker:agrn-agr-1');
  assert.equal(calls, 1);
});

test('five quick effects share one read and a successful wake has no final read to fail', async t => {
  let reads = 0;
  const f = fixture(t, async ({ eff }) => {
    for (let i = 0; i < 5; i++) await eff({ kind: 'read-context', sessionId: 'agrn-agr-1' });
    return output();
  });
  f.internal.eff = async () => ({});
  f.internal.taskService.getTask = async () => {
    reads++;
    if (reads > 1) throw new Error('network gone after effects');
    return { assigneeId: 'worker', state: 'active' };
  };
  await f.run();
  assert.equal(reads, 1);
});

test('a stuck tool does not extend the tick watchdog or falsely acknowledge a pause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const f = fixture(t, async ({ eff }) => { await eff({ kind: 'read-context', sessionId: 'agrn-agr-1' }); return output(); });
  f.internal.tickTimeoutMs = 20;
  f.internal.eff = async () => { started(); return new Promise(() => {}); };
  const running = f.run();
  await startedPromise;
  f.setTask({ control: request('pause') });
  await f.run('another-room');
  assert.equal(f.acks.length, 0);
  // Fire the watchdog only after the other lane has delivered the pause.
  t.mock.timers.tick(20);
  await running;
  assert.equal(f.acks.length, 0);
  // An unscoped room message can still run after the watchdog.
  f.internal.brain.tick = async () => output();
  await f.internal._processEvent({ type: 'message', text: 'New brief' }, 'worker:agrn-agr-1');
});

test('a tool call naming an unknown task still sends the chat message in the same wake', async t => {
  const sent: string[] = [];
  const f = fixture(t, async ({ eff }) => {
    const tool = await eff({
      kind: 'tool-call', sessionId: 'agrn-agr-1', name: 'task_get', args: { taskId: 'missing' },
    }) as { ok?: boolean; error?: string };
    assert.equal(tool.ok, false);
    assert.match(tool.error ?? '', /cannot be read/);
    await eff({ kind: 'send-message', sessionId: 'agrn-agr-1', receiverId: 'buyer', text: 'still here' });
    return output();
  });
  f.internal.taskService.getTask = async (taskId: string) => {
    if (taskId === 'missing') throw Object.assign(new Error('not found'), { status: 404 });
    return { assigneeId: 'worker', state: 'active', control: null };
  };
  f.internal.eff = async (effect: { kind: string; text?: string }) => {
    if (effect.kind === 'send-message') sent.push(effect.text ?? '');
    return { ok: true };
  };
  await f.internal._processEvent({ type: 'message', text: 'Here is a new brief' }, 'worker:agrn-agr-1');
  assert.deepEqual(sent, ['still here']);
});

test('a tool call naming a paused task of the agent is held and the wake continues', async t => {
  const calls: string[] = [];
  const f = fixture(t, async ({ eff }) => {
    const tool = await eff({
      kind: 'tool-call',
      sessionId: 'agrn-agr-1',
      name: 'task_set_result',
      args: { taskId: 'paused-1' },
    }) as { ok?: boolean; error?: string };
    assert.equal(tool.ok, false);
    assert.match(tool.error ?? '', /paused/);
    await eff({ kind: 'send-message', sessionId: 'agrn-agr-1', receiverId: 'buyer', text: 'continues' });
    return output();
  });
  f.internal.taskService.getTask = async (taskId: string) => (
    taskId === 'paused-1'
      ? { assigneeId: 'worker', state: 'active', control: request('pause') }
      : { assigneeId: 'worker', state: 'active', control: null }
  );
  f.internal.eff = async (effect: { kind: string; name?: string; text?: string }) => {
    calls.push(effect.kind === 'tool-call' ? `tool:${effect.name}` : effect.kind);
    return { ok: true };
  };
  await f.internal._processEvent({ type: 'message', text: 'Here is a new brief' }, 'worker:agrn-agr-1');
  assert.equal(calls.includes('tool:task_set_result'), false);
  assert.ok(calls.includes('send-message'));
});
