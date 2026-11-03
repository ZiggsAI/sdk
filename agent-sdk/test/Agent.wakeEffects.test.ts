import {command,message} from './fixtures/message.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Agent } from '../src/Agent.js';
import { WakeEffects, workScopeFromWake } from '../src/runtime/wakeEffects.js';
import { messageSendTool } from '../src/brain/claudeSdkTools.js';
import { defineTool } from '../src/tools/defineTool.js';
import { StateTimers, type TimerEvent } from '../src/platform/StateTimers.js';
import type { TickInput, TickOutput } from '../src/brain/ZiggsBrain.js';
import { RequiredContextUnavailable } from '../src/runtime/requiredContext.js';

const completedTick = (): TickOutput => ({ ctx: {}, state: 'idle', parked: true, stateTimeoutUnhandled: false,
  metrics: { llmCalls: 1, tokens: { total: 12, input: 10, output: 2 } } });
function hostFor(t: TestContext, tick: (input: TickInput) => Promise<TickOutput>) {
  const sent: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (String(url).endsWith('/messages')) {sent.push(body); return roomlessCreated(body);}
    return new Response(JSON.stringify({ success: true, ok: true, artifactId: 'art_test', history: [], agents: [], users: [], agreements: [] }));
  });
  const metrics: Array<{ sessionId: string; agreementId?: string; taskId?: string }> = [];
  const outcomes: Array<{ sessionId: string; kind: string; reason?: string }> = [];
  const host = new Agent({ agentId: 'agent-test', operatorKey: 'test-key', anthropicKey: 'test-key',
    initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } }, taskTools: 'none',
    tools: [messageSendTool], inboxCatchUp: false, telemetryIngest: false, metricsTap: info => { metrics.push(info); } });
  host.brain = { workflow: { id: 'test', initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } } }, tick } as Agent['brain'];
  const internal = host as any;
  internal.taskService = { getTask: async (taskId: string) => ({ taskId, assigneeId: 'agent-test', state: 'active' }) };
  internal.recordWakeOutcome = (session: { sessionId: string }, outcome: { kind: string; reason?: string }) => outcomes.push({ sessionId: session.sessionId, ...outcome });
  // A shared-room message carries its address, as handleMessage puts it on
  // every frame. The lane name is never read as one.
  const addressed = (event: unknown, room: string): unknown => {
    const frame = event as { type?: string; addressId?: string; events?: unknown[] };
    if (frame?.type === 'batch' && Array.isArray(frame.events)) return { ...frame, events: frame.events.map(e => addressed(e, room)) };
    return frame?.type === 'message' && !('addressId' in frame) ? { ...frame, addressId: room } : event;
  };
  const process = async (event: unknown, room = 'room-a', lane: Record<string, unknown> = {}) => {
    const laneKey = `agent-test:${room}`;
    if (!internal.sessions.has(laneKey)) internal.sessions.set(laneKey, { sessionId: room, ownAgentId: 'agent-test', state: 'idle', ...lane });
    const shared = !/^(agrn|msgn)-/.test(room) && !lane.roomlessAgreementId && !lane.executionContext;
    await internal._processEvent(shared ? addressed(event, room) : event, laneKey);
  };
  t.after(() => host.disconnect());
  return { host, internal, process, sent, metrics, outcomes };
}

const tool = (name: string, sessionId: string, args: unknown = {}) => ({ kind: 'tool-call' as const, name, sessionId, args });

test('a required input failure propagates to delivery without sending an unscoped apology', async t => {
  const h = hostFor(t, async () => { throw new RequiredContextUnavailable(); });
  await assert.rejects(h.process({ type: 'message', messageId: 'input', text: 'Please help', senderId: 'user', senderType: 'USER' }),
    { code: 'REQUIRED_CONTEXT_UNAVAILABLE' });
  assert.deepEqual(h.sent, []);
});

const roomlessWrite = (url: unknown, init?: RequestInit) =>
  init?.method === 'POST' && /\/messaging\/messages$/.test(String(url));
const roomlessCreated = (body: Record<string, unknown>) =>
  Response.json({outcome:'created',message:message(`msg_${body.operationId}`, String((body.content as {text:string}).text))});

test('nested message_send marks the wake replied even when it sends into a different room', async t => {
  const h = hostFor(t, async ({ eff }) => {
    await eff(tool('message_send', 'room-a', {command:command('Hello','person','operation')}));
    return completedTick();
  });
  await h.process({ type: 'message' });
  assert.equal(h.sent[0].deliveries.principalIds[0], 'person');
  assert.equal(h.sent[0].addressId, undefined);
  assert.equal(h.outcomes[0].kind, 'replied');
});

test('HTTP-success refusals do not claim delivery or suppress subsequent room messages', async t => {
  for (const direct of [false, true]) {
    const h = hostFor(t, async ({ eff }) => {
      await eff(tool('message_send', 'room-a', {command:command('Hello','person','declined')}));
      return completedTick();
    });
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ success: false, addressId: 'room-a' })));
    await h.process({ type: 'message' });
    assert.equal(h.outcomes[0].kind, 'no-op');
    await h.process({ type: 'message', messageId: 'msg_declined' });
    assert.equal(h.metrics.length, 2);
  }
});

test('a task read or unsuccessful write does not claim progress, including stale context outcomes', async t => {
  const h = hostFor(t, async ({ eff }) => {
    await eff(tool('task_list', 'room-a'));
    await eff(tool('task_set_result', 'room-a'));
    const out = completedTick();
    out.ctx.lastOutcome = { kind: 'task-completed' } as any;
    return out;
  });
  h.host.registerTool(defineTool('task_list', {}, async () => ({ tasks: [] })));
  h.host.registerTool(defineTool('task_set_result', {}, async () => ({ ok: false, error: 'refused' })));
  await h.process({ type: 'message' });
  assert.equal(h.outcomes[0].kind, 'no-op');
});

test('a successful plan write counts as progress', async t => {
  const h = hostFor(t, async ({ eff }) => { await eff(tool('task_replace_plan', 'room-a')); return completedTick(); });
  h.host.registerTool(defineTool('task_replace_plan', {}, async () => ({ ok: true, taskId: 'task-a' })));
  await h.process({ type: 'message' });
  assert.equal(h.outcomes[0].kind, 'task-progress');
});

test('a failed send does not count as a reply and is not remembered as our echo', async t => {
  const h = hostFor(t, async ({ eff }) => {
    await eff(tool('message_send', 'room-a', {command:command('Hello','person','failed')}));
    return completedTick();
  });
  t.mock.method(globalThis, 'fetch', async (url: unknown) => new Response('{}', { status: String(url).endsWith('/messages') ? 403 : 200 }));
  await h.process({ type: 'message' });
  assert.equal(h.outcomes[0].kind, 'no-op');
  await h.process({ type: 'message', messageId: 'msg_failed' });
  assert.equal(h.metrics.length, 2, 'an unsuccessful send cannot suppress a later message');
});

test('confirmed message ids suppress stand-in echoes despite presentation aliases, but retain new human input and other rooms', async t => {
  let calls = 0;
  const h = hostFor(t, async ({ eff }) => {
    if (++calls === 1) await eff(tool('message_send', 'room-a', {command:command('Stand-in reply','person','reply')}));
    return completedTick();
  });
  await h.process({ type: 'message' });
  await h.process({ type: 'message', senderId: 'rpb-human-binding', messageId: 'msg_reply' });
  assert.equal(calls, 1);
  assert.equal(h.outcomes[1].reason, 'own_message_echo');
  await h.process({ type: 'batch', events: [
    { type: 'message', messageId: 'msg_reply' },
    { type: 'message', senderId: 'rpb-human-binding', messageId: 'new-human-message' },
  ] });
  assert.equal(calls, 2);
  await h.process({ type: 'message', messageId: 'msg_reply' }, 'different-room');
  assert.equal(calls, 2, 'canonical identity stays the same in another view');
});

test('only a successfully handled exact own plan version suppresses task poll repeats', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const h = hostFor(t, async ({ eff }) => {
    if (++calls === 1) {
      await eff(tool('task_replace_plan', 'room-a', { taskId: 'task-a' }));
      await eff(tool('wake_at', 'room-a', { at: '1970-01-01T00:05:00Z' }));
    }
    return completedTick();
  });
  h.host.registerTool(defineTool('task_replace_plan', { taskId: 'string' }, async () => ({ ok: true, taskId: 'task-a', updatedAt: '2026-09-15T08:38:14.111Z' })));
  await h.process({ type: 'message' });
  const snapshot = { type: 'task_result', source: 'active-task-snapshot', result: { taskId: 'task-a', assigneeId: 'agent-test', state: 'active', updatedAt: '2026-09-15T08:38:14.111Z' } };
  await h.process(snapshot);
  assert.equal(calls, 1);
  assert.equal(h.outcomes[1].reason, 'own_plan_snapshot');
  await h.process({ ...snapshot, result: { ...snapshot.result, updatedAt: '2026-09-15T08:39:14.111Z' } });
  assert.equal(calls, 2, 'a human or backend change has a new server version');
  await h.process({ ...snapshot, source: undefined });
  assert.equal(calls, 3, 'manual task recovery still runs for the same version');
  await h.process({ ...snapshot, result: { ...snapshot.result, state: 'completed' } });
  assert.equal(calls, 4, 'terminal task results are never snapshot noise');
});

test('failed wakes do not acknowledge a plan version that could recover the work', async t => {
  let calls = 0;
  const h = hostFor(t, async ({ eff }) => {
    if (++calls === 1) { await eff(tool('task_replace_plan', 'room-a', { taskId: 'task-a' })); throw new Error('interrupted'); }
    return completedTick();
  });
  h.host.registerTool(defineTool('task_replace_plan', { taskId: 'string' }, async () => ({ ok: true, taskId: 'task-a', updatedAt: 'version-1' })));
  await assert.rejects(h.process({ type: 'message' }), /interrupted/);
  await h.process({ type: 'task_result', source: 'active-task-snapshot', result: { taskId: 'task-a', updatedAt: 'version-1', state: 'active', assigneeId: 'agent-test' } });
  assert.equal(calls, 2);
});

test('inbox task delivery uses snapshot dedupe while an explicit assignment replay still runs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const h = hostFor(t, async ({ eff }) => {
    if (++calls === 1) {
      await eff(tool('task_replace_plan', 'agrn-agr_task', { taskId: 'task-a' }));
      await eff(tool('wake_at', 'agrn-agr_task', { at: '1970-01-01T00:05:00Z' }));
    }
    return completedTick();
  });
  h.host.registerTool(defineTool('task_replace_plan', { taskId: 'string' }, async () => ({ ok: true, taskId: 'task-a', updatedAt: 'version-1' })));
  h.internal.taskService = { getTask: async () => ({
    taskId: 'task-a', updatedAt: 'version-1', state: 'active', assigneeId: 'agent-test', agreementId: 'agr_task', originChatId: 'old-origin',
  }) };
  await h.process({ type: 'message', agreementId: 'agr_task' }, 'agrn-agr_task');
  await h.host.wakeTaskAssignment('task-a', { fromInbox: true });
  assert.equal(calls, 1);
  await h.host.wakeTaskAssignment('task-a');
  assert.equal(calls, 2);
  await h.host.wakeTaskAssignment('task-a', { fromInbox: true, inputs: [{ kind: 'message', id: 'new-input', eventId: 'message:new-input' }] });
  assert.equal(calls, 3, 'a new input cannot be suppressed by an unchanged task snapshot');
});

test('a successful partial plan write without a scheduled continuation is recoverable by its task poll', async t => {
  let calls = 0;
  const h = hostFor(t, async ({ eff }) => {
    if (++calls === 1) await eff(tool('task_replace_plan', 'room-a', { taskId: 'task-a' }));
    return completedTick();
  });
  h.host.registerTool(defineTool('task_replace_plan', { taskId: 'string' }, async () => ({ ok: true, taskId: 'task-a', updatedAt: 'version-1' })));
  await h.process({ type: 'message' });
  await h.process({ type: 'task_result', source: 'active-task-snapshot', result: {
    taskId: 'task-a', state: 'active', assigneeId: 'agent-test', updatedAt: 'version-1',
  } });
  assert.equal(calls, 2);
});

test('an own plan snapshot resumes work once its previously armed continuation is gone', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const h = hostFor(t, async ({ eff }) => {
    if (++calls === 1) {
      await eff(tool('task_replace_plan', 'room-a', { taskId: 'task-a' }));
      await eff(tool('wake_at', 'room-a', { at: '1970-01-01T00:05:00Z' }));
    }
    return completedTick();
  });
  h.host.registerTool(defineTool('task_replace_plan', { taskId: 'string' }, async () => ({ ok: true, taskId: 'task-a', updatedAt: 'version-1' })));
  const snapshot = { type: 'task_result', source: 'active-task-snapshot', result: {
    taskId: 'task-a', state: 'active', assigneeId: 'agent-test', updatedAt: 'version-1',
  } };
  await h.process({ type: 'message' });
  await h.process(snapshot);
  assert.equal(calls, 1);
  h.internal.stateTimers.clear('agent-test:room-a');
  await h.process(snapshot);
  assert.equal(calls, 2);
});

test('skipped own messages and plan snapshots preserve the armed reminder', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const h = hostFor(t, async ({ eff }) => {
    if (++calls === 1) {
      await eff(tool('message_send', 'room-a', {command:command('Ready for approval','person','ready')}));
      await eff(tool('task_replace_plan', 'room-a', { taskId: 'task-a' }));
      await eff(tool('wake_at', 'room-a', { at: '1970-01-01T00:05:00Z', reason: 'Reminder owed' }));
    }
    return completedTick();
  });
  h.host.registerTool(defineTool('task_replace_plan', { taskId: 'string' }, async () => ({ ok: true, taskId: 'task-a', updatedAt: 'version-1' })));
  const events: TimerEvent[] = [];
  h.internal.stateTimers = new StateTimers(event => events.push(event));
  await h.process({ type: 'message' });
  await h.process({ type: 'message', messageId: 'msg_ready' });
  await h.process({ type: 'task_result', source: 'active-task-snapshot', result: {
    taskId: 'task-a', state: 'active', assigneeId: 'agent-test', updatedAt: 'version-1',
  } });
  assert.equal(calls, 1);
  assert.equal(h.internal.stateTimers.peek('agent-test:room-a')?.firesAt, 300_000);
  t.mock.timers.tick(300_000);
  await h.process(events[0]);
  assert.equal(calls, 2);
  assert.equal(h.metrics[1].taskId, 'task-a');
});

test('structured task scope survives wake_at without trusting the timer reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const h = hostFor(t, async ({ eff }) => {
    await eff(tool('wake_at', 'room-a', { at: '1970-01-01T00:05:00Z', reason: '{"taskId":"wrong-task"}' }));
    return completedTick();
  });
  const events: TimerEvent[] = [];
  h.internal.stateTimers = new StateTimers(e => events.push(e));
  await h.process({ type: 'task_result', result: { taskId: 'task-a', agreementId: 'agr-a' } });
  t.mock.timers.tick(300_000);
  assert.deepEqual(workScopeFromWake(events[0]), { taskId: 'task-a', agreementId: 'agr-a' });
});

test('concurrent wakes keep outcome and explicit work attribution separate', async t => {
  let unblock!: () => void;
  const ready = new Promise<void>(resolve => { unblock = resolve; });
  const h = hostFor(t, async ({ eff, identity }) => {
    if (identity.sessionId === 'room-a') {
      await eff({ kind: 'read-context', sessionId: 'room-a' });
      await ready;
      await eff(tool('message_send', 'room-a', {command:command('reply','person','operation')}));
    } else {
      await eff(tool('task_list', 'room-b'));
      unblock();
    }
    return completedTick();
  });
  t.mock.method(globalThis,'fetch',async (url:unknown,init?:RequestInit)=>roomlessWrite(url,init) ? roomlessCreated(JSON.parse(String(init?.body))) : Response.json({history:[],agents:[],users:[],agreements:[{agreementId:'agr-a'}]}));
  h.host.registerTool(defineTool('task_list', {}, async () => ({ tasks: [{ taskId: 'unrelated', agreementId: 'agr-other' }] })));
  await Promise.all([h.process({ type: 'message', agreementId:'agr-a' }, 'room-a'), h.process({ type: 'message' }, 'room-b')]);
  assert.equal(h.outcomes.find(o => o.sessionId === 'room-a')?.kind, 'replied');
  assert.equal(h.outcomes.find(o => o.sessionId === 'room-b')?.kind, 'no-op');
  assert.equal(h.metrics.find(m => m.sessionId === 'room-a')?.agreementId, 'agr-a');
  assert.equal(h.metrics.find(m => m.sessionId === 'room-b')?.agreementId, undefined);
});

test('scope uses structured task snapshots and refuses contradictory batches or free-text timer reasons', () => {
  assert.deepEqual(workScopeFromWake({ type: 'task_result', result: { taskId: 'task-a', agreementId: 'agr-a' } }), { taskId: 'task-a', agreementId: 'agr-a' });
  assert.deepEqual(workScopeFromWake({ type: 'wake-at', reason: '{"taskId":"invented"}' }), {});
  assert.deepEqual(workScopeFromWake({ type: 'batch', events: [{ taskId: 'task-a', agreementId: 'agr-a' }, { taskId: 'task-b', agreementId: 'agr-b' }] }), {});
  const observed = new WakeEffects({});
  observed.observe(tool('agreement_get', 'room-a', { agreementId: 'agr-a' }), { ok: true, result: { agreementId: 'agr-a' } });
  observed.observe(tool('agreement_get', 'room-a', { agreementId: 'agr-b' }), { ok: true, result: { agreementId: 'agr-b' } });
  assert.deepEqual(observed.scope, {}, 'arbitrary consulted agreements do not establish room scope');
  observed.observe({ kind: 'read-context', sessionId: 'room-b' }, { agreements: [{ agreementId: 'agr-other' }] });
  assert.deepEqual(observed.scope, {}, 'another room cannot establish this wake scope');
  observed.observe({ kind: 'read-context', sessionId: 'room-a' }, { agreements: [{ agreementId: 'agr-a' }, { agreementId: 'agr-b' }] });
  assert.deepEqual(observed.scope, {}, 'multiple agreements in this room cannot be billed as one');
  const batch = WakeEffects.forWake({ type: 'batch', events: [{ agreementId: 'agr-a' }, { agreementId: 'agr-b' }] }, 'agrn-agr_1');
  batch.observe({ kind: 'read-context', sessionId: 'agrn-agr_1' }, { agreements: [{ agreementId: 'agr-a' }] });
  assert.deepEqual(batch.scope, {}, 'later reads cannot erase an ambiguous batch');
});

test('context reads do not select billing scope; only explicit work or confirmed writes identify it', () => {
  const afterRead = (selected = {}) => {
    const w = new WakeEffects(selected);
    w.observe({kind:'read-context',sessionId:'local-session'}, {agreements:[{agreementId:'unselected'}]});
    return w;
  };
  const onlyRead = afterRead();
  assert.deepEqual(onlyRead.scope, {});
  const written = afterRead();
  written.observe(tool('task_replace_plan', 'local-session', {taskId:'task'}), {ok:true,result:{ok:true,taskId:'task',agreementId:'work',state:'active'}});
  assert.deepEqual(written.scope, {agreementId:'work',taskId:'task'});
  const explicit = afterRead({agreementId:'selected',taskId:'selected-task'});
  explicit.observe(tool('task_replace_plan','local-session',{taskId:'other'}), {ok:true,result:{ok:true,taskId:'other',agreementId:'other-work'}});
  assert.deepEqual(explicit.scope, {agreementId:'selected',taskId:'selected-task'});
  const failed = afterRead();
  failed.observe(tool('task_set_result','local-session',{taskId:'task'}), {ok:true,result:{ok:false,taskId:'task',agreementId:'work'}});
  assert.deepEqual(failed.scope, {});
  const taskOnly = afterRead();
  taskOnly.observe(tool('task_set_result','local-session',{taskId:'task'}), {ok:true,result:{ok:true,taskId:'task'}});
  assert.deepEqual(taskOnly.scope, {taskId:'task'});
});

/**
 * The drop this ticket is about, driven through the host itself: a wake handed
 * a question, a brain that writes its answer as host output, and no send. The
 * classification lives on the live delivery path — `replayWake` deliberately
 * does not record an outcome — so this is where it can be shown without a model.
 */
test('a question answered only in prose is recorded as asked and unanswered', async t => {
  const h = hostFor(t, async () => completedTick());
  await h.process({ type: 'message', intent: 'request', senderId: 'user-buyer', text: 'what is the status?' });
  assert.deepEqual(h.outcomes, [
    {
      sessionId: 'room-a',
      kind: 'no-op',
      reason: 'llm_no_visible_effect',
      reply: { asked: true, sent: false, reason: 'composed_without_sending' },
    },
  ]);
});

test('a question answered with a send is recorded as answered', async t => {
  const h = hostFor(t, async ({ eff }) => {
    await eff(tool('message_send', 'room-a', {command:command('the status is green','person','operation')}));
    return completedTick();
  });
  await h.process({ type: 'message', intent: 'request', senderId: 'user-buyer', text: 'what is the status?' });
  assert.deepEqual(h.outcomes, [
    { sessionId: 'room-a', kind: 'replied', reply: { asked: true, sent: true } },
  ]);
});

test('news that nobody answered is not recorded as an unanswered question', async t => {
  const h = hostFor(t, async () => completedTick());
  await h.process({ type: 'notification', senderId: 'ziggs-system', text: 'task completed' });
  assert.deepEqual(h.outcomes, [
    { sessionId: 'room-a', kind: 'no-op', reason: 'llm_no_visible_effect' },
  ]);
});

for (const navigation of [undefined, 'obsolete-chat']) {
  test(`restored work timer ignores navigation ${navigation}`, async t => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const execution = { contextId: 'restored', actorId: 'agent-test', principalId: 'customer', agreementId: 'hire',
      taskId: 'task-1', position: 'provider', addressId: null, audienceIds: ['customer'], audienceRevision: 'rev' } as const;
    const h = hostFor(t, async ({ eff }) => {
      await eff({ kind: 'read-context', sessionId: 'agrn-unrelated' });
      await eff(tool('message_send', 'agrn-unrelated', {command:{...command('Scheduled update','ep_customer'),mandate:{agreementId:'hire',taskId:'task-1'}}}));
      return completedTick();
    });
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url: String(url), body });
      if (String(url).endsWith('/execution/context')) return Response.json(execution);
      if (String(url).endsWith('/execution/attempt')) return Response.json(body.operation === 'claim' ? { ...execution, attemptId: 'attempt' } : { ok: true });
      if (roomlessWrite(url, init)) return roomlessCreated(body);
      return Response.json({ success: true, messages: [], recipients: [], history: [], agents: [], users: [], agreements: [] });
    });
    await h.host.replayWake({ agentId: 'agent-test', sessionId: 'agrn-unrelated', laneKey: 'restored', executionContext: execution, event: { type: 'wake-at', addressId: navigation, reason: 'untrusted agreement other' } });
    const writes = calls.filter(c => c.url.endsWith('/messages'));
    assert.equal(writes.length, 1, JSON.stringify({ calls, outcomes: h.outcomes }));
    assert.ok(writes[0].url.endsWith('/messaging/messages'));
    assert.equal((writes[0].body.mandate as {taskId:string}).taskId, 'task-1');
    assert.equal(h.metrics[0].agreementId, 'hire');
    assert.equal(h.metrics[0].taskId, 'task-1');
  });
}

test('lane names cannot supply work authority', () => {
  assert.deepEqual(workScopeFromWake({ type: 'wake-at', addressId: 'agrn-made-up' }, 'agrn-other'), {});
});


test('mixed unscoped work cannot borrow a prior roomless destination', async t => {
  const h = hostFor(t, async ({ eff }) => {
    const result = await eff(tool('message_send', 'agrn-work', {command:command('Ambiguous','ep_customer','operation')}));
    assert.equal((result as { ok: boolean }).ok, true);
    return completedTick();
  });
  await h.process({ type: 'batch', events: [
    { type: 'notification', agreementId: 'a' }, { type: 'notification', agreementId: 'b' },
  ] }, 'agrn-work', { roomlessAgreementId: 'old-hire' });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].mandate, undefined, 'a selected command cannot borrow stale work');
});

const directExecution = { contextId: 'direct-execution', actorId: 'agent-test', principalId: 'owner',
  position: 'participant', agreementId: null, taskId: null,
  action: { kind: 'message', id: 'incoming' }, audienceIds: ['owner'], audienceRevision: 'current' };

const agreementExecution = { contextId: 'hire-execution', actorId: 'agent-test', principalId: 'customer', agreementId: 'hire',
  taskId: null, position: 'provider', audienceIds: ['customer'], audienceRevision: 'rev' };
