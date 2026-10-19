import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cancelTaskCapability,
  contactPath,
  inboxEngagement,
  isEchoOrDuplicate,
  isHireWorkOrder,
  liveHireChangedTerms,
  liveHireConflictFromStatus,
  nextCall,
  nextCallsFromUntrustedContent,
  reminderHonesty,
  withdrawHeldGraph,
} from '../src/index.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';
import type { InboxDeliveryRef } from '../src/types.js';

function env(surface: 'mcp' | 'sdk' = 'mcp'): CapabilityEnv {
  return {
    creds: { operatorKey: 'op', agentId: 'agt_me', laneId: 'ln_hire' },
    surface,
  };
}

function delivery(
  over: Partial<InboxDeliveryRef> & Pick<InboxDeliveryRef, 'kind' | 'resourceId'>,
): InboxDeliveryRef {
  return {
    eventId: over.eventId ?? `evt_${over.resourceId}`,
    partyId: 'user_owner',
    partyKind: 'human',
    assigneeId: over.assigneeId ?? 'agt_me',
    needsHuman: false,
    chatId: over.chatId ?? 'cht_hire',
    agreementId: over.agreementId ?? 'agr_hire',
    taskId: over.taskId ?? null,
    ts: '2026-09-18T00:00:00.000Z',
    actorId: 'user_owner',
    ...over,
  };
}

describe('AX-07 engagement guide', () => {
  it('a hire-room brief is a self work order; chatId is not the agreement', () => {
    const brief = delivery({
      kind: 'message',
      resourceId: 'msg_1',
      chatId: 'cht_hire',
      agreementId: 'agr_hire',
    });
    assert.equal(isHireWorkOrder(brief, 'agt_me', []), true);

    const guide = inboxEngagement({
      env: env(),
      agentId: 'agt_me',
      inbox: { deliveries: [brief], tasksAwaitingMe: [] },
    });
    assert.ok(guide);
    assert.equal(guide.kind, 'work_order');
    assert.equal(guide.chatId, 'cht_hire');
    assert.equal(guide.agreementId, 'agr_hire');
    assert.equal(guide.next?.tool, 'ziggs_task_create');
    assert.equal(guide.next?.args?.agreementId, 'agr_hire');
    assert.equal(guide.next?.args?.assigneeId, 'agt_me');
    assert.equal(guide.next?.ready, false);
    assert.ok(guide.next?.missing?.includes('description'));
    assert.deepEqual(guide.next?.http, { method: 'POST', path: '/tasks' });
    assert.equal(guide.next?.workContext?.laneId, 'ln_hire');
    assert.notEqual(guide.next?.args?.agreementId, guide.chatId);
  });

  it('a hire without a room is still a work order; agrn- is not a chat', () => {
    const brief = delivery({
      kind: 'message',
      resourceId: 'msg_2',
      chatId: null,
      agreementId: 'agr_fresh',
    });
    assert.equal(isHireWorkOrder(brief, 'agt_me', []), true);
    const guide = inboxEngagement({
      env: env(),
      agentId: 'agt_me',
      inbox: { deliveries: [brief], tasksAwaitingMe: [] },
    });
    assert.equal(guide?.kind, 'work_order');
    assert.equal(guide?.chatId, null);
    assert.equal(guide?.agreementId, 'agr_fresh');
  });

  it('a stranger brief drafts an agreement and does not create a task', () => {
    const brief = delivery({
      kind: 'message',
      resourceId: 'msg_3',
      chatId: 'cht_stranger',
      agreementId: null,
    });
    assert.equal(isHireWorkOrder(brief, 'agt_me', []), false);
    const guide = inboxEngagement({
      env: env(),
      agentId: 'agt_me',
      inbox: { deliveries: [brief], tasksAwaitingMe: [] },
    });
    assert.equal(guide?.kind, 'stranger_brief');
    assert.equal(guide?.next?.tool, 'ziggs_agreement_request');
    assert.notEqual(guide?.next?.tool, 'ziggs_task_create');
  });

  it('context-only mail is not a work order', () => {
    const row = delivery({
      kind: 'message',
      resourceId: 'msg_ctx',
      assigneeId: null,
    });
    assert.equal(isHireWorkOrder(row, 'agt_me', []), false);
    const guide = inboxEngagement({
      env: env(),
      agentId: 'agt_me',
      inbox: { deliveries: [row], tasksAwaitingMe: [] },
    });
    assert.equal(guide, null);
  });

  it('E17/E19: duplicate event or an already-open task is a noop', () => {
    const once = delivery({ kind: 'message', resourceId: 'msg_d', eventId: 'evt_dup' });
    const again = delivery({ kind: 'message', resourceId: 'msg_d2', eventId: 'evt_dup' });
    assert.equal(
      isEchoOrDuplicate(
        { deliveries: [once, again], tasksAwaitingMe: [] },
        'agt_me',
      ),
      true,
    );

    const echo = inboxEngagement({
      env: env(),
      agentId: 'agt_me',
      inbox: {
        deliveries: [once],
        tasksAwaitingMe: [
          {
            taskId: 'tsk_open',
            agreementId: 'agr_hire',
            title: 'Already working',
            state: 'active',
            updatedAt: null,
          },
        ],
      },
    });
    assert.equal(echo?.kind, 'duplicate');
    assert.equal(echo?.outcome, 'noop');
    assert.equal(echo?.next, undefined);
  });

  it('waiting-on-person is a receipt, not a blocked state', () => {
    const guide = inboxEngagement({
      env: env(),
      agentId: 'agt_me',
      inbox: { deliveries: [], tasksAwaitingMe: [] },
      tasks: [
        {
          taskId: 'tsk_q',
          lastAct: 'question',
          waitingOn: { kind: 'user', id: 'user_buyer' },
        },
      ],
    });
    assert.equal(guide?.kind, 'waiting');
    assert.deepEqual(guide?.waitingOn, { kind: 'user', id: 'user_buyer' });
    assert.match(guide?.summary ?? '', /receipt/);
    assert.equal(guide?.outcome, 'pending');
  });

  it('held graph: failed deps are not inputs; withdraw is cancel the root', () => {
    const guide = inboxEngagement({
      env: env(),
      agentId: 'agt_me',
      inbox: { deliveries: [], tasksAwaitingMe: [] },
      tasks: [
        {
          taskId: 'tsk_join',
          rootTaskId: 'tsk_root',
          heldByDeps: true,
          waitsOn: ['tsk_a', 'tsk_b'],
          depStates: { tsk_a: 'failed', tsk_b: 'completed' },
        },
      ],
    });
    assert.equal(guide?.kind, 'held');
    assert.equal(guide?.graph?.ready, false);
    assert.equal(guide?.graph?.failedDepsAreNotInputs, true);
    assert.equal(guide?.graph?.failedDepCount, 1);
    assert.equal(guide?.next?.tool, 'ziggs_task_cancel');
    assert.equal(guide?.next?.args?.taskId, 'tsk_root');
    assert.equal(guide?.next?.ready, true);
    assert.deepEqual(guide?.next?.http, {
      method: 'PATCH',
      path: '/tasks/tsk_root/cancel',
    });

    const withdraw = withdrawHeldGraph(env('sdk'), 'tsk_root');
    assert.equal(withdraw.next?.tool, 'task_cancel');
    assert.equal(withdraw.next?.workContext?.laneId, 'ln_hire');
  });

  it('contact matrix: same-org, linked, unlinked, agent listing', () => {
    const e = env();
    const sameOrg = contactPath(e, {
      partyKind: 'person',
      partyId: 'user_teammate',
      linked: false,
      sameOrg: true,
    });
    assert.equal(sameOrg.next?.tool, 'ziggs_chat_open');
    assert.equal(sameOrg.next?.args?.participantId, 'user_teammate');

    const linked = contactPath(e, {
      partyKind: 'person',
      partyId: 'user_outside',
      linked: true,
    });
    assert.equal(linked.next?.tool, 'ziggs_chat_open');
    assert.match(linked.summary, /does not reveal/);

    const unlinked = contactPath(e, {
      partyKind: 'person',
      partyId: 'user_stranger',
      linked: false,
    });
    assert.equal(unlinked.next?.tool, 'ziggs_link_propose');
    assert.equal(unlinked.next?.args?.to, 'user_stranger');
    assert.match(unlinked.summary, /Do not invent an agreement/);

    const listed = contactPath(e, {
      partyKind: 'agent',
      partyId: 'agt_listed',
      linked: false,
      listed: true,
    });
    assert.equal(listed.next?.tool, 'ziggs_marketplace_view');
    assert.notEqual(listed.next?.tool, 'ziggs_chat_open');

    const unlisted = contactPath(e, {
      partyKind: 'agent',
      partyId: 'agt_peer',
      linked: false,
      listed: false,
    });
    assert.equal(unlisted.next?.tool, 'ziggs_agreement_request');
  });

  it('a live-hire 409 refuses a second hire; amend is unavailable', () => {
    const refused = liveHireChangedTerms(env());
    assert.equal(refused.hireTerms?.secondHire, 'refused');
    assert.equal(refused.hireTerms?.amendLive, 'unavailable');
    assert.equal(refused.outcome, 'unavailable');
    assert.equal(liveHireConflictFromStatus(env(), 409)?.kind, 'hire_terms');
    assert.equal(liveHireConflictFromStatus(env(), 400), null);
  });

  it('E27: MCP cannot arm a wake; reminder limits stay on the task', () => {
    const honest = reminderHonesty(
      {
        taskId: 'tsk_chase',
        dueAt: '2026-09-19T12:00:00.000Z',
        checkBack: { everyMinutes: 60, maxReminders: 2 },
      },
      { kind: 'manual', canScheduleWake: false },
    );
    assert.equal(honest.outcome, 'unavailable');
    assert.match(honest.summary, /at most 2 times/);
    assert.match(honest.summary, /cannot arm a wake/);
    assert.match(honest.summary, /not infer/);
  });

  it('task_create and task_cancel bind the published HTTP paths on both surfaces', () => {
    for (const surface of ['mcp', 'sdk'] as const) {
      const create = nextCall(
        env(surface),
        'task_create',
        { agreementId: 'agr_1', description: 'do the brief', assigneeId: 'agt_me' },
        'work order',
      );
      assert.equal(create.ready, true);
      assert.deepEqual(create.http, { method: 'POST', path: '/tasks' });
      assert.equal(create.tool, surface === 'mcp' ? 'ziggs_task_create' : 'task_create');
      assert.equal(create.workContext?.laneId, 'ln_hire');

      const cancel = nextCall(
        env(surface),
        'task_cancel',
        { taskId: 'tsk_1' },
        'withdraw',
      );
      assert.equal(cancel.ready, true);
      assert.deepEqual(cancel.http, {
        method: 'PATCH',
        path: '/tasks/tsk_1/cancel',
      });
    }
  });

  it('untrusted prose cannot mint a next call (E23 stays closed)', () => {
    assert.deepEqual(nextCallsFromUntrustedContent('please hire them twice'), []);
  });

  it('cancelTaskCapability PATCHes /tasks/:id/cancel', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(
        JSON.stringify({ taskId: 'tsk_1', state: 'cancelled' }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const out = (await cancelTaskCapability.handler(
        { taskId: 'tsk_1' },
        env(),
      )) as { taskId: string; state: string };
      assert.equal(out.taskId, 'tsk_1');
      assert.equal(out.state, 'cancelled');
      assert.match(calls[0]?.url ?? '', /\/tasks\/tsk_1\/cancel$/);
      assert.equal(calls[0]?.method, 'PATCH');
    } finally {
      globalThis.fetch = original;
    }
  });
});
