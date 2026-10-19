import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Agent } from '../src/Agent.js';
import { WakeEffects, workScopeFromWake } from '../src/runtime/wakeEffects.js';
import { chatSendTool } from '../src/brain/claudeSdkTools.js';
import { defineTool } from '../src/tools/defineTool.js';
import { StateTimers, type TimerEvent } from '../src/platform/StateTimers.js';
import type { TickInput, TickOutput } from '../src/brain/ZiggsBrain.js';

const completedTick = (): TickOutput => ({ ctx: {}, state: 'idle', parked: true, stateTimeoutUnhandled: false,
  metrics: { llmCalls: 1, tokens: { total: 12, input: 10, output: 2 } } });
function hostFor(t: TestContext, tick: (input: TickInput) => Promise<TickOutput>) {
  const sent: Array<{ chatId: string; messageId: string }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (String(url).endsWith('/messages')) sent.push(body);
    return new Response(JSON.stringify({ success: true, ok: true, artifactId: 'art_test', history: [], agents: [], users: [], agreements: [] }));
  });
  const metrics: Array<{ sessionId: string; agreementId?: string; taskId?: string }> = [];
  const outcomes: Array<{ sessionId: string; kind: string; reason?: string }> = [];
  const host = new Agent({ agentId: 'agent-test', operatorKey: 'test-key', anthropicKey: 'test-key',
    initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } }, taskTools: 'none',
    tools: [chatSendTool], inboxCatchUp: false, telemetryIngest: false, metricsTap: info => { metrics.push(info); } });
  host.brain = { workflow: { id: 'test', initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } } }, tick } as Agent['brain'];
  const internal = host as any;
  internal.taskService = { getTask: async (taskId: string) => ({ taskId, assigneeId: 'agent-test', state: 'active' }) };
  internal.recordWakeOutcome = (session: { sessionId: string }, outcome: { kind: string; reason?: string }) => outcomes.push({ sessionId: session.sessionId, ...outcome });
  const process = async (event: unknown, room = 'room-a') => {
    const lane = `agent-test:${room}`;
    if (!internal.sessions.has(lane)) internal.sessions.set(lane, { sessionId: room, ownAgentId: 'agent-test', state: 'idle' });
    await internal._processEvent(event, lane);
  };
  t.after(() => host.disconnect());
  return { host, internal, process, sent, metrics, outcomes };
}

const tool = (name: string, sessionId: string, args: unknown = {}) => ({ kind: 'tool-call' as const, name, sessionId, args });

test('nested chat_send marks the wake replied even when it sends into a different room', async t => {
  const h = hostFor(t, async ({ eff }) => {
    await eff(tool('chat_send', 'room-a', { chatId: 'room-b', text: 'Hello' }));
    return completedTick();
  });
  await h.process({ type: 'message' });
  assert.equal(h.sent[0].chatId, 'room-b');
  assert.equal(h.outcomes[0].kind, 'replied');
});

test('direct-to chat_send reports a reply and suppresses only the confirmed pair-room echo', async t => {
  let calls = 0;
  const h = hostFor(t, async ({ eff }) => {
    if (++calls === 1) await eff(tool('chat_send', 'room-a', { to: 'person-a', text: 'Hello', idempotencyKey: 'pair-reply' }));
    return completedTick();
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ success: true, chatId: 'pair-room' })));
  await h.process({ type: 'message' });
  assert.equal(h.outcomes[0].kind, 'replied');
  await h.process({ type: 'message', senderId: 'rpb-stand-in', messageId: 'sdk_idem_pair-reply' }, 'pair-room');
  assert.equal(calls, 1);
  assert.equal(h.outcomes[1].reason, 'own_message_echo');
});

test('HTTP-success refusals do not claim delivery or suppress subsequent room messages', async t => {
  for (const direct of [false, true]) {
    const h = hostFor(t, async ({ eff }) => {
      await eff(tool('chat_send', 'room-a', { ...(direct ? { to: 'person-a' } : {}), text: 'Hello', idempotencyKey: 'declined' }));
      return completedTick();
    });
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ success: false, chatId: 'room-a' })));
    await h.process({ type: 'message' });
    assert.equal(h.outcomes[0].kind, 'no-op');
    await h.process({ type: 'message', messageId: 'sdk_idem_declined' });
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
    await eff(tool('chat_send', 'room-a', { text: 'Hello', idempotencyKey: 'failed' }));
    return completedTick();
  });
  t.mock.method(globalThis, 'fetch', async (url: unknown) => new Response('{}', { status: String(url).endsWith('/messages') ? 403 : 200 }));
  await h.process({ type: 'message' });
  assert.equal(h.outcomes[0].kind, 'no-op');
  await h.process({ type: 'message', messageId: 'sdk_idem_failed' });
  assert.equal(h.metrics.length, 2, 'an unsuccessful send cannot suppress a later message');
});

test('confirmed message ids suppress stand-in echoes despite presentation aliases, but retain new human input and other rooms', async t => {
  let calls = 0;
  const h = hostFor(t, async ({ eff }) => {
    if (++calls === 1) await eff(tool('chat_send', 'room-a', { text: 'Stand-in reply', idempotencyKey: 'reply' }));
    return completedTick();
  });
  await h.process({ type: 'message' });
  await h.process({ type: 'message', senderId: 'rpb-human-binding', messageId: 'sdk_idem_reply' });
  assert.equal(calls, 1);
  assert.equal(h.outcomes[1].reason, 'own_message_echo');
  await h.process({ type: 'batch', events: [
    { type: 'message', messageId: 'sdk_idem_reply' },
    { type: 'message', senderId: 'rpb-human-binding', messageId: 'new-human-message' },
  ] });
  assert.equal(calls, 2);
  await h.process({ type: 'message', messageId: 'sdk_idem_reply' }, 'different-room');
  assert.equal(calls, 3);
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
      await eff(tool('task_replace_plan', 'room-a', { taskId: 'task-a' }));
      await eff(tool('wake_at', 'room-a', { at: '1970-01-01T00:05:00Z' }));
    }
    return completedTick();
  });
  h.host.registerTool(defineTool('task_replace_plan', { taskId: 'string' }, async () => ({ ok: true, taskId: 'task-a', updatedAt: 'version-1' })));
  h.internal.taskService = { getTask: async () => ({
    taskId: 'task-a', updatedAt: 'version-1', state: 'active', assigneeId: 'agent-test', originChatId: 'room-a',
  }) };
  await h.process({ type: 'message' });
  await h.host.wakeTaskAssignment('task-a', { fromInbox: true });
  assert.equal(calls, 1);
  await h.host.wakeTaskAssignment('task-a');
  assert.equal(calls, 2);
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
      await eff(tool('chat_send', 'room-a', { text: 'Ready for approval', idempotencyKey: 'ready' }));
      await eff(tool('task_replace_plan', 'room-a', { taskId: 'task-a' }));
      await eff(tool('wake_at', 'room-a', { at: '1970-01-01T00:05:00Z', reason: 'Reminder owed' }));
    }
    return completedTick();
  });
  h.host.registerTool(defineTool('task_replace_plan', { taskId: 'string' }, async () => ({ ok: true, taskId: 'task-a', updatedAt: 'version-1' })));
  const events: TimerEvent[] = [];
  h.internal.stateTimers = new StateTimers(event => events.push(event));
  await h.process({ type: 'message' });
  await h.process({ type: 'message', messageId: 'sdk_idem_ready' });
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

test('concurrent wakes keep outcome and inferred work attribution separate', async t => {
  let unblock!: () => void;
  const ready = new Promise<void>(resolve => { unblock = resolve; });
  const h = hostFor(t, async ({ eff, identity }) => {
    if (identity.sessionId === 'room-a') {
      await eff({ kind: 'read-context', sessionId: 'room-a' });
      await ready;
      await eff(tool('chat_send', 'room-a', { chatId: 'room-b', text: 'reply' }));
    } else {
      await eff(tool('task_list', 'room-b'));
      unblock();
    }
    return completedTick();
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    success: true, history: [], agents: [], users: [], agreements: [{ agreementId: 'agr-a' }],
  })));
  h.host.registerTool(defineTool('task_list', {}, async () => ({ tasks: [{ taskId: 'unrelated', agreementId: 'agr-other' }] })));
  await Promise.all([h.process({ type: 'message' }, 'room-a'), h.process({ type: 'message' }, 'room-b')]);
  assert.equal(h.outcomes.find(o => o.sessionId === 'room-a')?.kind, 'replied');
  assert.equal(h.outcomes.find(o => o.sessionId === 'room-b')?.kind, 'no-op');
  assert.equal(h.metrics.find(m => m.sessionId === 'room-a')?.agreementId, 'agr-a');
  assert.equal(h.metrics.find(m => m.sessionId === 'room-b')?.agreementId, undefined);
});

test('scope uses structured task snapshots and refuses contradictory batches or free-text timer reasons', () => {
  assert.deepEqual(workScopeFromWake({ type: 'task_result', result: { taskId: 'task-a', agreementId: 'agr-a' } }), { taskId: 'task-a', agreementId: 'agr-a' });
  assert.deepEqual(workScopeFromWake({ type: 'wake-at', reason: '{"taskId":"invented"}' }), {});
  assert.deepEqual(workScopeFromWake({ type: 'batch', events: [{ taskId: 'task-a', agreementId: 'agr-a' }, { taskId: 'task-b', agreementId: 'agr-b' }] }), {});
  const observed = new WakeEffects({}, 'room-a');
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

test('a confirmed task write bills the room agreement and names the task only when the server ties it there', () => {
  const inRoom = () => {
    const w = new WakeEffects({}, 'room-a');
    w.observe({ kind: 'read-context', sessionId: 'room-a' }, { agreements: [{ agreementId: 'agr-a' }] });
    return w;
  };
  const unproven = inRoom();
  unproven.observe(tool('task_replace_plan', 'room-a', { taskId: 'task-1', steps: [] }), { ok: true, result: { ok: true, taskId: 'task-1', state: 'active', updatedAt: 't1' } });
  assert.deepEqual(unproven.scope, { agreementId: 'agr-a' }, 'the room still pays; a task the server did not tie to it is not named');
  const own = inRoom();
  own.observe(tool('task_replace_plan', 'room-a', { taskId: 'task-1', steps: [] }), { ok: true, result: { ok: true, taskId: 'task-1', agreementId: 'agr-a', state: 'active' } });
  assert.deepEqual(own.scope, { agreementId: 'agr-a', taskId: 'task-1' });
  const other = inRoom();
  other.observe(tool('task_replace_plan', 'room-a', { taskId: 'task-A', steps: [] }), { ok: true, result: { ok: true, taskId: 'task-A', agreementId: 'agr-customer-a', state: 'active' } });
  assert.deepEqual(other.scope, { agreementId: 'agr-a' }, 'a plan written for another customer from this room does not move the spend');
  const noRoom = new WakeEffects({}, 'room-a');
  noRoom.observe(tool('task_set_result', 'room-a', { taskId: 'task-1' }), { ok: true, result: { ok: true, taskId: 'task-1', agreementId: 'agr-a', state: 'completed' } });
  assert.deepEqual(noRoom.scope, { agreementId: 'agr-a', taskId: 'task-1' }, 'without a room snapshot the confirmed write alone scopes the wake');
});

/**
 * The drop this ticket is about, driven through the host itself: a wake handed
 * a question, a brain that writes its answer as host output, and no send. The
 * classification lives on the live delivery path — `replayWake` deliberately
 * does not record an outcome — so this is where it can be shown without a model.
 */
test('a question answered only in prose is recorded as asked and unanswered', async t => {
  const h = hostFor(t, async () => completedTick());
  await h.process({ type: 'message', senderId: 'user-buyer', text: 'what is the status?' });
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
    await eff(tool('chat_send', 'room-a', { chatId: 'room-a', text: 'the status is green' }));
    return completedTick();
  });
  await h.process({ type: 'message', senderId: 'user-buyer', text: 'what is the status?' });
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



test('run scope reaches nested messages across rooms and artifact tools', async t => {
  const scopes: unknown[] = [];
  const h = hostFor(t, async ({ eff }) => {
    await eff(tool('inspect_scope', 'room-a'));
    await eff(tool('chat_send', 'room-a', { text: 'same room' }));
    await eff(tool('chat_send', 'room-a', { chatId: 'room-b', receiverId: 'human', text: 'other room' }));
    await eff(tool('chat_send', 'room-a', { chatId: 'room-b', receiverId: 'human', text: 'explicit work', conversationAgreementId: 'other' }));
    return completedTick();
  });
  h.host.registerTool(defineTool('inspect_scope', {}, async (_args, ctx) => { scopes.push(ctx.serviceAgreementId); return {}; }));
  await h.process({ type: 'message', agreementId: 'trial' });
  assert.deepEqual(scopes, ['trial']);
  assert.deepEqual(h.sent.map(send => (send as any).underAgreementId), ['trial', 'trial', 'trial']);
  assert.deepEqual(h.sent.map(send => (send as any).conversationAgreementId), [undefined, undefined, 'other']);
});
