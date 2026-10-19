import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWakeOutcomePayload,
  classifyWakeOutcome,
  wakeWasAsked,
} from '../src/runtime/wakeOutcome.js';

describe('classifyWakeOutcome', () => {
  it('records a skip as no-op with that reason', () => {
    assert.deepEqual(
      classifyWakeOutcome({
        skippedReason: 'agreement_terminal',
        llmCalls: 0,
      }),
      { kind: 'no-op', reason: 'agreement_terminal' },
    );
  });

  it('records an agent-formed hire activation as a no-op', () => {
    assert.deepEqual(
      classifyWakeOutcome({
        skippedReason: 'agent_formed_hire_activation',
        llmCalls: 0,
      }),
      { kind: 'no-op', reason: 'agent_formed_hire_activation' },
    );
  });

  it('records an unread-room skip naming the room (ZIG-1799)', () => {
    assert.deepEqual(
      classifyWakeOutcome({
        skippedReason: 'chat_unreadable:yoyuvnzkszaqpdwkpurhurwk',
        llmCalls: 0,
      }),
      { kind: 'no-op', reason: 'chat_unreadable:yoyuvnzkszaqpdwkpurhurwk' },
    );
  });

  it('records a send as replied', () => {
    assert.deepEqual(
      classifyWakeOutcome({ sentMessage: true, llmCalls: 2 }),
      { kind: 'replied' },
    );
  });

  it('records an LLM turn that said nothing', () => {
    assert.deepEqual(
      classifyWakeOutcome({ llmCalls: 1 }),
      { kind: 'no-op', reason: 'llm_no_visible_effect' },
    );
  });

  it('records a claimed delivery that never reached the brain', () => {
    assert.deepEqual(
      classifyWakeOutcome({ llmCalls: 0 }),
      { kind: 'no-op', reason: 'no_llm' },
    );
  });
});

describe('buildWakeOutcomePayload', () => {
  it('is ingest-shaped so metering can see mute wakes', () => {
    const payload = buildWakeOutcomePayload({
      agentId: 'meeting-notes',
      sessionId: 'chat_1',
      laneKey: 'meeting-notes:chat_1',
      outcome: { kind: 'no-op', reason: 'llm_no_visible_effect' },
      llmCalls: 1,
    });
    assert.equal((payload.meta as { effect: string }).effect, 'wake-outcome');
    assert.equal((payload.meta as { kind: string }).kind, 'no-op');
    assert.equal(
      (payload.meta as { reason: string }).reason,
      'llm_no_visible_effect',
    );
  });
});

/**
 * ZIG-1897 — an agent asked for a status composed the answer, wrote it as host
 * output and finished clean. The outcome row could not say so: a question left
 * unanswered looked like a duplicate echo, and one answered onto the task alone
 * looked like success.
 */
describe('a wake that was asked something', () => {
  const asked = {
    type: 'message',
    senderId: 'user-buyer',
    text: 'what is the status?',
  };

  it('is a question when a counterparty speaks', () => {
    assert.equal(wakeWasAsked(asked, 'agent-me'), true);
  });

  it('is not a question when the agent hears its own message back', () => {
    assert.equal(wakeWasAsked({ ...asked, senderId: 'agent-me' }, 'agent-me'), false);
  });

  it('is not a question when the wake is news rather than speech', () => {
    for (const type of ['task_result', 'notification', 'agreement_lifecycle']) {
      assert.equal(wakeWasAsked({ ...asked, type }, 'agent-me'), false, type);
    }
  });

  it('finds the question inside a batch', () => {
    assert.equal(
      wakeWasAsked({ type: 'batch', events: [{ type: 'notification' }, asked] }, 'agent-me'),
      true,
    );
  });

  it('records the answer when one was sent', () => {
    const outcome = classifyWakeOutcome({ llmCalls: 2, sentMessage: true, asked: true });
    assert.deepEqual(outcome, { kind: 'replied', reply: { asked: true, sent: true } });
  });

  it('records composing without sending as exactly that', () => {
    const outcome = classifyWakeOutcome({ llmCalls: 3, asked: true });
    assert.deepEqual(outcome, {
      kind: 'no-op',
      reason: 'llm_no_visible_effect',
      reply: { asked: true, sent: false, reason: 'composed_without_sending' },
    });
  });

  it('still reports the unanswered question when the wake wrote the task', () => {
    // task-progress reads like success, and the requester still got nothing.
    const outcome = classifyWakeOutcome({ llmCalls: 2, taskWrite: true, asked: true });
    assert.equal(outcome.kind, 'task-progress');
    assert.deepEqual(outcome.reply, {
      asked: true,
      sent: false,
      reason: 'recorded_on_the_task_only',
    });
  });

  it('says nothing about replying when nothing was asked', () => {
    assert.equal(classifyWakeOutcome({ llmCalls: 1 }).reply, undefined);
    assert.equal(classifyWakeOutcome({ llmCalls: 1, sentMessage: true }).reply, undefined);
  });

  it('carries asked / answered onto the recorded payload', () => {
    const payload = buildWakeOutcomePayload({
      agentId: 'agent-me',
      sessionId: 'chat-1',
      laneKey: 'lane-1',
      outcome: classifyWakeOutcome({ llmCalls: 3, asked: true }),
      llmCalls: 3,
    });
    assert.deepEqual((payload as { meta: Record<string, unknown> }).meta, {
      effect: 'wake-outcome',
      kind: 'no-op',
      reason: 'llm_no_visible_effect',
      asked: true,
      answered: false,
      unansweredReason: 'composed_without_sending',
      laneKey: 'lane-1',
      agentId: 'agent-me',
    });
  });
});
