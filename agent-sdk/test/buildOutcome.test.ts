import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeFromEvent, outcomeFromActionResult, applyOutcomeToCtx } from '../src/runtime/buildOutcome.js';
import { LANE_BOOK_KEY } from '../src/runtime/taskBookkeeping.js';
import type { Action, Ctx, Outcome } from '../src/types.js';

const ownAgent = 'agent-A';

function freshCtx(): Ctx {
  return {
    identity: { agentId: ownAgent, sessionId: 'chat-1', laneKey: 'A:chat-1' },
    tasks: {},
    activeAgreementId: null,
    activeTaskId: null,
    pendingProposalAgreementId: null,
    pendingSubtasks: {},
    collectedResults: [],
    delegatedAgreementIds: [],
    toolResults: [],
    lastOutcome: { kind: 'enter' },
  };
}

function focusBook(ctx: Ctx) {
  assert.ok(ctx.activeTaskId);
  return ctx.tasks[ctx.activeTaskId!];
}

describe('outcomeFromEvent', () => {
  it('returns enter for null event', () => {
    assert.deepEqual(outcomeFromEvent(null, ownAgent), { kind: 'enter' });
  });

  it('returns task-assigned when agent is provider on an active task', () => {
    const ev = { type: 'task_result', result: { taskId: 't1', state: 'active', providerIsYou: true, agreement: { agreementId: 'a1' } } };
    const o = outcomeFromEvent(ev, ownAgent);
    assert.equal(o.kind, 'task-assigned');
    if (o.kind === 'task-assigned') assert.equal(o.task.taskId, 't1');
  });

  it('returns subtask-finished/failed on cancelled task (new model: no proposal state on tasks)', () => {
    // Tasks are born active in the new model — cancelled maps to subtask-finished/failed.
    const ev = { type: 'task_result', result: { taskId: 't1', state: 'cancelled', creatorIsYou: true, agreement: { agreementId: 'a1' } } };
    const o = outcomeFromEvent(ev, ownAgent);
    assert.equal(o.kind, 'subtask-finished');
    if (o.kind === 'subtask-finished') assert.equal(o.status, 'failed');
  });

  it('returns subtask-finished/completed on completed task', () => {
    const ev = { type: 'task_result', result: { taskId: 't1', state: 'completed', creatorIsYou: true, agreement: { agreementId: 'a1' } } };
    const o = outcomeFromEvent(ev, ownAgent);
    assert.equal(o.kind, 'subtask-finished');
    if (o.kind === 'subtask-finished') assert.equal(o.status, 'completed');
  });

  it('returns message-received for plain text events', () => {
    const o = outcomeFromEvent({ type: 'message', text: 'hi' }, ownAgent);
    assert.equal(o.kind, 'message-received');
  });

  it('a delivered message is a turn whoever it names: the backend already picked (ZIG-2034)', () => {
    const o = outcomeFromEvent(
      { type: 'message', text: 'hi', senderId: 'u1', receiverId: 'agent-B' },
      ownAgent,
    );
    assert.equal(o.kind, 'message-received');
  });

  it('returns proposal-resolved for agreement_lifecycle approve', () => {
    const o = outcomeFromEvent({
      type: 'agreement_lifecycle',
      operation: 'proposal_approved',
      agreementId: 'agr-1',
    }, ownAgent);
    assert.equal(o.kind, 'proposal-resolved');
    if (o.kind === 'proposal-resolved') {
      assert.equal(o.action, 'approve');
      assert.equal(o.proposal.agreementId, 'agr-1');
    }
  });

  it('returns proposal-resolved reject for proposal_rejected lifecycle', () => {
    const o = outcomeFromEvent({
      type: 'agreement_lifecycle',
      operation: 'proposal_rejected',
      agreementId: 'agr-2',
    }, ownAgent);
    assert.equal(o.kind, 'proposal-resolved');
    if (o.kind === 'proposal-resolved') assert.equal(o.action, 'reject');
  });

  it('maps proposal_approved_execute to proposal-resolved approve', () => {
    const o = outcomeFromEvent({
      type: 'agreement_lifecycle',
      operation: 'proposal_approved_execute',
      agreementId: 'agr-3',
    }, ownAgent);
    assert.equal(o.kind, 'proposal-resolved');
    if (o.kind === 'proposal-resolved') assert.equal(o.action, 'approve');
  });

  it('ZIG-1278: resource_changed proposal_approved → proposal-resolved with fromClaimWake', () => {
    const o = outcomeFromEvent({
      type: 'resource_changed',
      resource: {
        kind: 'agreement',
        reason: 'proposal_approved',
        agreementId: 'agr-claim',
        resourceId: 'agr-claim',
        actorId: 'buyer-1',
      },
    }, ownAgent);
    assert.equal(o.kind, 'proposal-resolved');
    if (o.kind === 'proposal-resolved') {
      assert.equal(o.action, 'approve');
      assert.equal(o.proposal.agreementId, 'agr-claim');
      assert.equal(o.fromClaimWake, true);
      assert.equal(o.proposedByMe, false);
    }
  });

  it('picks highest-rank outcome from a batch', () => {
    const ev = {
      type: 'batch',
      events: [
        { type: 'message', text: 'hi' },
        { type: 'task_result', result: { taskId: 't1', state: 'active', providerIsYou: true } },
      ],
    };
    const o = outcomeFromEvent(ev, ownAgent);
    assert.equal(o.kind, 'task-assigned');
  });

  it('maps a state-timeout frame to a state-timeout outcome', () => {
    const o = outcomeFromEvent({ type: 'state-timeout', state: 'waiting', waitedMs: 5000, epoch: 3 }, ownAgent);
    assert.equal(o.kind, 'state-timeout');
    if (o.kind === 'state-timeout') { assert.equal(o.state, 'waiting'); assert.equal(o.waitedMs, 5000); }
  });

  it('a real event in a batch supersedes a coalesced state-timeout', () => {
    const o = outcomeFromEvent({ type: 'batch', events: [
      { type: 'state-timeout', state: 'waiting', waitedMs: 5000, epoch: 1 },
      { type: 'message', text: 'hi', senderId: 'u1' },
    ] }, ownAgent);
    assert.equal(o.kind, 'message-received');
  });
});

describe('outcomeFromActionResult', () => {
  it('uses static produces from action', () => {
    const action: Action = { prompt: { instruction: 'i' }, produces: 'message-sent' };
    const events = [{ type: 'message_sent', message: 'hello', receiverId: 'u1' }];
    const o = outcomeFromActionResult('greet', action, {}, events as any, []);
    assert.equal(o.kind, 'message-sent');
    if (o.kind === 'message-sent') assert.equal(o.text, 'hello');
  });

  it('uses function produces to branch on result', () => {
    const action: Action = {
      prompt: { instruction: 'i' },
      tool: 'my_tool',
      produces: (r: any) => (r?.error ? 'error' : 'tool-result'),
    };
    const errEvents = [{ type: 'tool_result', tool: 'my_tool', result: { error: 'bad' } }];
    const okEvents = [{ type: 'tool_result', tool: 'my_tool', result: { value: 1 } }];
    assert.equal(outcomeFromActionResult('x', action, {}, errEvents as any, []).kind, 'error');
    assert.equal(outcomeFromActionResult('x', action, {}, okEvents as any, []).kind, 'tool-result');
  });

  it('infers task-closed for task_set_result completed', () => {
    const action: Action = { prompt: { instruction: 'i' }, tool: 'task_set_result', produces: 'task-closed' };
    const events = [{ type: 'tool_result', tool: 'task_set_result', result: { task: { taskId: 't1', state: 'completed' } } }];
    const o = outcomeFromActionResult('close', action, {}, events as any, []);
    assert.equal(o.kind, 'task-closed');
    if (o.kind === 'task-closed') {
      assert.equal(o.status, 'completed');
      assert.equal(o.taskId, 't1');
    }
  });

  it('accumulates tool results into the out parameter', () => {
    const action: Action = { prompt: { instruction: 'i' }, tool: 'x', produces: 'tool-result' };
    const events = [{ type: 'tool_result', tool: 'x', result: { ok: true } }];
    const out: any[] = [];
    outcomeFromActionResult('a', action, {}, events as any, out);
    assert.equal(out.length, 1);
    assert.equal(out[0].tool, 'x');
  });
});

describe('applyOutcomeToCtx', () => {
  it('records active ids and a tasks[] entry on task-assigned', () => {
    const ctx = freshCtx();
    ctx.pendingProposalAgreementId = 'a-pending';
    const o: Outcome = { kind: 'task-assigned', task: { taskId: 't1', agreementId: 'a1' } };
    applyOutcomeToCtx(ctx, o);
    assert.equal(ctx.activeTaskId, 't1');
    assert.equal(ctx.activeAgreementId, 'a1');
    assert.equal(ctx.pendingProposalAgreementId, null);
    assert.ok(ctx.tasks['t1']);
    assert.equal(ctx.tasks['t1'].agreementId, 'a1');
  });

  it('records pending subtask under the focus task on task-delegated', () => {
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'task-assigned', task: { taskId: 'parent', agreementId: 'a1' } });
    const o: Outcome = { kind: 'task-delegated', task: { taskId: 't2', agreementId: 'a2', executorId: 'spec-1' } };
    applyOutcomeToCtx(ctx, o);
    const book = focusBook(ctx);
    assert.equal(book.pendingSubtasks['t2'].agentId, 'spec-1');
    assert.equal(typeof book.pendingSubtasks['t2'].spawnedAt, 'number');
    assert.deepEqual(book.delegatedAgreementIds, ['a2']);
  });

  it('task-delegated twice for the same taskId keeps the first entry', () => {
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'task-assigned', task: { taskId: 'parent', agreementId: 'a1' } });
    applyOutcomeToCtx(ctx, { kind: 'task-delegated', task: { taskId: 't2', agreementId: 'a2', executorId: 'spec-1' } });
    const firstSpawn = focusBook(ctx).pendingSubtasks['t2'].spawnedAt;
    applyOutcomeToCtx(ctx, { kind: 'task-delegated', task: { taskId: 't2', agreementId: 'a2', executorId: 'spec-2' } });
    assert.equal(Object.keys(focusBook(ctx).pendingSubtasks).length, 1);
    assert.equal(focusBook(ctx).pendingSubtasks['t2'].agentId, 'spec-1');
    assert.equal(focusBook(ctx).pendingSubtasks['t2'].spawnedAt, firstSpawn);
  });

  it('subtask-finished removes pending and collects the result', () => {
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'task-assigned', task: { taskId: 'parent', agreementId: 'a1' } });
    applyOutcomeToCtx(ctx, { kind: 'task-delegated', task: { taskId: 't1', agreementId: 'a1', executorId: 'spec-1' } });
    applyOutcomeToCtx(ctx, { kind: 'subtask-finished', status: 'completed', task: { taskId: 't1', result: 'latte ordered' } });
    const book = focusBook(ctx);
    assert.equal(Object.keys(book.pendingSubtasks).length, 0);
    assert.deepEqual(book.collectedResults, [{ taskId: 't1', agentId: 'spec-1', status: 'completed', result: 'latte ordered' }]);
  });

  it('duplicate subtask-finished is idempotent', () => {
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'task-assigned', task: { taskId: 'parent', agreementId: 'a1' } });
    applyOutcomeToCtx(ctx, { kind: 'task-delegated', task: { taskId: 't1', executorId: 'spec-1' } });
    applyOutcomeToCtx(ctx, { kind: 'subtask-finished', status: 'completed', task: { taskId: 't1', result: 'r' } });
    applyOutcomeToCtx(ctx, { kind: 'subtask-finished', status: 'completed', task: { taskId: 't1', result: 'r' } });
    assert.equal(focusBook(ctx).collectedResults.length, 1);
  });

  it('skeleton subtask-finished is upgraded by the full task_result', () => {
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'task-assigned', task: { taskId: 'parent', agreementId: 'a1' } });
    applyOutcomeToCtx(ctx, { kind: 'task-delegated', task: { taskId: 't1', executorId: 'spec-1' } });
    applyOutcomeToCtx(ctx, { kind: 'subtask-finished', status: 'completed', task: { taskId: 't1' } });
    applyOutcomeToCtx(ctx, { kind: 'subtask-finished', status: 'completed', task: { taskId: 't1', result: 'answer' } });
    assert.equal(focusBook(ctx).collectedResults.length, 1);
    assert.equal(focusBook(ctx).collectedResults[0].result, 'answer');
  });

  it('skeleton finish with no pending record upgrades agentId from the full frame', () => {
    // No task-delegated first (skeleton arrives before we recorded pending),
    // so agentId is null on the placeholder; the full frame carries executorId.
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'subtask-finished', status: 'completed', task: { taskId: 't1' } });
    assert.equal(ctx.tasks[LANE_BOOK_KEY].collectedResults[0].agentId, null);
    applyOutcomeToCtx(ctx, { kind: 'subtask-finished', status: 'completed', task: { taskId: 't1', executorId: 'spec-x', result: 'answer' } });
    assert.equal(ctx.tasks[LANE_BOOK_KEY].collectedResults.length, 1);
    assert.equal(ctx.tasks[LANE_BOOK_KEY].collectedResults[0].agentId, 'spec-x');
    assert.equal(ctx.tasks[LANE_BOOK_KEY].collectedResults[0].result, 'answer');
  });

  it('failed subtask records status failed', () => {
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'task-assigned', task: { taskId: 'parent', agreementId: 'a1' } });
    applyOutcomeToCtx(ctx, { kind: 'task-delegated', task: { taskId: 't1', executorId: 'spec-1' } });
    applyOutcomeToCtx(ctx, { kind: 'subtask-finished', status: 'failed', task: { taskId: 't1', result: null } });
    assert.equal(focusBook(ctx).collectedResults[0].status, 'failed');
  });

  it('all results are kept in arrival order and pending emptied only after the last', () => {
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'task-assigned', task: { taskId: 'parent', agreementId: 'a1' } });
    applyOutcomeToCtx(ctx, { kind: 'task-delegated', task: { taskId: 't1', executorId: 'a' } });
    applyOutcomeToCtx(ctx, { kind: 'task-delegated', task: { taskId: 't2', executorId: 'b' } });
    applyOutcomeToCtx(ctx, { kind: 'subtask-finished', status: 'completed', task: { taskId: 't2', result: '2' } });
    assert.equal(Object.keys(focusBook(ctx).pendingSubtasks).length, 1);
    applyOutcomeToCtx(ctx, { kind: 'subtask-finished', status: 'completed', task: { taskId: 't1', result: '1' } });
    assert.equal(Object.keys(focusBook(ctx).pendingSubtasks).length, 0);
    assert.deepEqual(focusBook(ctx).collectedResults.map(r => r.taskId), ['t2', 't1']);
  });

  it('task-closed clears only the closed task — sibling bookkeeping survives (ZIG-977)', () => {
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'task-assigned', task: { taskId: 'tA', agreementId: 'a1' } });
    applyOutcomeToCtx(ctx, { kind: 'task-delegated', task: { taskId: 'childA', executorId: 'x' } });
    applyOutcomeToCtx(ctx, { kind: 'task-assigned', task: { taskId: 'tB', agreementId: 'a1' } });
    applyOutcomeToCtx(ctx, { kind: 'task-delegated', task: { taskId: 'childB', executorId: 'y' } });
    assert.ok(ctx.tasks['tA'].pendingSubtasks['childA']);
    assert.ok(ctx.tasks['tB'].pendingSubtasks['childB']);

    applyOutcomeToCtx(ctx, { kind: 'task-closed', status: 'completed', taskId: 'tA' });

    assert.equal(ctx.tasks['tA'], undefined);
    assert.ok(ctx.tasks['tB']);
    assert.ok(ctx.tasks['tB'].pendingSubtasks['childB']);
    assert.equal(ctx.activeTaskId, 'tB');
    assert.equal(ctx.activeAgreementId, 'a1');
  });

  it('task-closed of the focused task without siblings clears focus', () => {
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'task-assigned', task: { taskId: 't1', agreementId: 'a1' } });
    applyOutcomeToCtx(ctx, { kind: 'task-delegated', task: { taskId: 't9', executorId: 'x' } });
    applyOutcomeToCtx(ctx, { kind: 'task-closed', status: 'completed', taskId: 't1' });
    assert.equal(ctx.activeAgreementId, null);
    assert.equal(ctx.activeTaskId, null);
    assert.equal(ctx.tasks['t1'], undefined);
  });

  it('ZIG-1171: task-closed clears via outcome.taskId — no result re-walk', () => {
    // buildOutcomeOfKind already puts taskId on the outcome; applyOutcomeToCtx
    // must not dig into result.task.taskId / result.taskId again.
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'task-assigned', task: { taskId: 't1', agreementId: 'a1' } });
    const action: Action = {
      prompt: { instruction: 'i' },
      tool: 'task_set_result',
      produces: 'task-closed',
    };
    const events = [
      {
        type: 'tool_result',
        tool: 'task_set_result',
        result: { task: { taskId: 't1', state: 'completed' } },
      },
    ];
    const o = outcomeFromActionResult('close', action, {}, events as never, []);
    assert.equal(o.kind, 'task-closed');
    if (o.kind === 'task-closed') assert.equal(o.taskId, 't1');
    applyOutcomeToCtx(ctx, o);
    assert.equal(ctx.tasks['t1'], undefined);
  });

  it('ctx with subtask state round-trips through JSON (DynamoDB doc client)', () => {
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'task-assigned', task: { taskId: 'parent', agreementId: 'a1' } });
    applyOutcomeToCtx(ctx, { kind: 'task-delegated', task: { taskId: 't1', executorId: 'spec-1' } });
    applyOutcomeToCtx(ctx, { kind: 'subtask-finished', status: 'completed', task: { taskId: 't1', result: 'done' } });
    assert.deepEqual(JSON.parse(JSON.stringify(ctx)), ctx);
  });

  it('clears pending on proposal-resolved', () => {
    const ctx = freshCtx();
    ctx.pendingProposalAgreementId = 'a1';
    applyOutcomeToCtx(ctx, { kind: 'proposal-resolved', action: 'approve', proposal: { agreementId: 'a1' }, proposedByMe: false });
    assert.equal(ctx.pendingProposalAgreementId, null);
  });

  it('records pending on proposal-made', () => {
    const ctx = freshCtx();
    applyOutcomeToCtx(ctx, { kind: 'proposal-made', proposal: { agreementId: 'a-new' } });
    assert.equal(ctx.pendingProposalAgreementId, 'a-new');
  });
});
