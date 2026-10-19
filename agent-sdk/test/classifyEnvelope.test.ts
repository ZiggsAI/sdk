import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIncomingEvent } from '../src/context/classifyEnvelope.js';

describe('classifyIncomingEvent', () => {
  it('returns reset flags for empty input', () => {
    const flags = classifyIncomingEvent(null, 'agent-1');
    assert.equal(flags.incomingMessage, false);
    assert.equal(flags.approval, false);
    assert.equal(flags.taskAssignment, null);
  });

  it('sets incomingMessage for plain message', () => {
    const flags = classifyIncomingEvent({ type: 'message', text: 'hi' }, 'agent-1');
    assert.equal(flags.incomingMessage, true);
  });

  it('classifies task assignment for executor', () => {
    const ev = {
      type: 'task_result',
      result: {
        state: 'active',
        executorId: 'agent-1',
        providerIsYou: true,
      },
    };
    const flags = classifyIncomingEvent(ev, 'agent-1');
    assert.equal(flags.approval, true);
    assert.ok(flags.taskAssignment);
  });

  it('classifies completed subtask', () => {
    const ev = {
      type: 'task_result',
      result: { state: 'completed', taskId: 'sub1', providerIsYou: true },
    };
    const flags = classifyIncomingEvent(ev, 'agent-1');
    assert.ok(flags.subtaskResult);
    assert.equal(flags.subtaskFailed, false);
  });

  it('marks failed subtask', () => {
    const ev = {
      type: 'task_result',
      result: { state: 'failed', taskId: 'sub1', providerIsYou: true },
    };
    const flags = classifyIncomingEvent(ev, 'agent-1');
    assert.equal(flags.subtaskFailed, true);
  });

  it('ignores irrelevant task_result for other executor', () => {
    const ev = {
      type: 'task_result',
      receiverId: 'someone-else',
      result: {
        state: 'active',
        executorId: 'other',
        providerIsYou: false,
      },
    };
    const flags = classifyIncomingEvent(ev, 'agent-1');
    assert.equal(flags.taskAssignment, null);
  });

  it('processes batched events in order', () => {
    const batch = {
      type: 'batch',
      events: [
        { type: 'message', text: 'a' },
        {
          type: 'task_result',
          result: { state: 'completed', taskId: 'x', providerIsYou: true },
        },
      ],
    };
    const flags = classifyIncomingEvent(batch, 'agent-1');
    assert.equal(flags.incomingMessage, true);
    assert.ok(flags.subtaskResult);
  });
});
