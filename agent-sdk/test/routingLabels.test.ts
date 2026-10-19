import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  unwrapBatchEvent,
  classifyWorkflowEvent,
  findTaskResult,
  findIncomingTaskResult,
} from '../src/context/routingLabels.js';

describe('unwrapBatchEvent', () => {
  it('returns first inner event for batch', () => {
    const inner = { type: 'message' };
    assert.deepEqual(unwrapBatchEvent({ type: 'batch', events: [inner] }), inner);
  });

  it('returns same event when not batch', () => {
    const ev = { type: 'message' };
    assert.equal(unwrapBatchEvent(ev), ev);
  });
});

describe('classifyWorkflowEvent', () => {
  it('returns message when empty', () => {
    assert.equal(classifyWorkflowEvent(null), 'message');
  });

  it('detects task_assignment', () => {
    const ev = {
      type: 'task_result',
      result: {
        state: 'active',
        providerIsYou: true,
        agreement: { parties: { provider: { actor: 'agent-1' } } },
      },
    };
    assert.equal(classifyWorkflowEvent(ev, 'agent-1'), 'task_assignment');
  });

  it('returns task_set_result for generic task_result', () => {
    const ev = {
      type: 'task_result',
      result: {
        state: 'queued',
        providerIsYou: true,
        agreement: { parties: { provider: { actor: 'agent-1' } } },
      },
    };
    assert.equal(classifyWorkflowEvent(ev, 'agent-1'), 'task_set_result');
  });
});

describe('findTaskResult', () => {
  it('finds task_result in emittedEvents', () => {
    const tr = { type: 'task_result', result: {} };
    const hit = findTaskResult({ emittedEvents: [{ type: 'message_sent' }, tr] });
    assert.equal(hit, tr);
  });

  it('finds tool_result with agreement protocol tool', () => {
    const tr = { type: 'tool_result', tool: 'task_set_result', result: {} };
    const hit = findTaskResult({ emittedEvents: [tr] });
    assert.equal(hit, tr);
  });
});

describe('findIncomingTaskResult', () => {
  it('finds first task_result in batch', () => {
    const tr = { type: 'task_result', result: { taskId: '1' } };
    const batch = { type: 'batch', events: [{ type: 'message' }, tr] };
    assert.equal(findIncomingTaskResult(batch), tr);
  });
});
