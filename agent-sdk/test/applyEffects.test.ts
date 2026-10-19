import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContextUpdates, CONTEXT_RESET } from '../src/context/applyEffects.js';

describe('CONTEXT_RESET', () => {
  it('is frozen', () => {
    assert.throws(() => {
      CONTEXT_RESET.messageSent = true;
    });
  });
});

describe('buildContextUpdates', () => {
  it('starts from reset with lastAction', () => {
    const u = buildContextUpdates('noop', null as unknown as unknown[]);
    assert.equal(u.lastAction, 'noop');
    assert.equal(u.messageSent, false);
  });

  it('records tool_result for agreement_propose proposal (own)', () => {
    const u = buildContextUpdates('act', [
      {
        type: 'tool_result',
        tool: 'agreement_propose',
        result: {
          state: 'proposal',
          providerIsYou: true,
          agreement: {
            agreementId: 'agr-1',
            parties: { creator: { actor: 'a1' }, provider: { actor: 'a1' } },
            proposal: { status: 'pending' },
          },
        },
      },
    ]);
    assert.ok(u.proposal);
    assert.equal((u.proposal as Record<string, unknown>).state, 'proposal');
  });

  it('records pending proposal when agreement_propose targets other provider', () => {
    const u = buildContextUpdates('act', [
      {
        type: 'tool_result',
        tool: 'agreement_propose',
        result: {
          agreementId: 'agr-d',
          parties: { creator: { principal: 'owner' }, provider: { actor: 'spec' } },
          proposal: { status: 'pending' },
        },
      },
    ]);
    // agreement-propose no longer spawns a task — it creates a pending proposal.
    assert.ok(u.proposal, 'proposal should be set');
    assert.equal(u.delegatedTask, undefined);
  });

  it('marks taskCompleted on task_set_result', () => {
    const u = buildContextUpdates('act', [
      {
        type: 'tool_result',
        tool: 'task_set_result',
        result: { state: 'completed' },
      },
    ]);
    assert.equal(u.taskCompleted, true);
  });

  it('aggregates toolResults array', () => {
    const u = buildContextUpdates('act', [
      { type: 'tool_result', tool: 'x', result: 1 },
      { type: 'tool_error', tool: 'y', error: 'bad' },
    ]);
    assert.equal((u.toolResults as unknown[]).length, 2);
    assert.equal(u.lastError, 'bad');
  });

  it('handles nested emitted event arrays', () => {
    const u = buildContextUpdates('act', [[{ type: 'message_sent' }]]);
    assert.equal(u.messageSent, true);
  });

  it('applies task_result with agreement-propose operation', () => {
    const u = buildContextUpdates('act', [
      {
        type: 'task_result',
        operation: 'agreement-propose',
        result: {
          state: 'proposal',
          providerIsYou: true,
          agreement: {
            agreementId: 'agr-2',
            parties: { creator: { actor: 'a' }, provider: { actor: 'a' } },
            proposal: { status: 'pending' },
          },
        },
      },
    ]);
    assert.ok(u.proposal);
  });
});
