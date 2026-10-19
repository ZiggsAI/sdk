import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getBatchEvents, isTaskResultRelevantToAgent } from '../src/context/batch.js';

describe('getBatchEvents', () => {
  it('returns empty array for null/undefined', () => {
    assert.deepEqual(getBatchEvents(null), []);
    assert.deepEqual(getBatchEvents(undefined), []);
  });

  it('unwraps batch events', () => {
    const inner = { type: 'message', text: 'hi' };
    assert.deepEqual(getBatchEvents({ type: 'batch', events: [inner] }), [inner]);
  });

  it('wraps single event in array', () => {
    const ev = { type: 'task_result', result: { taskId: '1' } };
    assert.deepEqual(getBatchEvents(ev), [ev]);
  });
});

describe('isTaskResultRelevantToAgent', () => {
  it('returns true when ownAgentId is missing', () => {
    assert.equal(
      isTaskResultRelevantToAgent({ agreement: { parties: { provider: { actor: 'x' } } } }, null),
      true,
    );
    assert.equal(
      isTaskResultRelevantToAgent(
        { agreement: { parties: { provider: { actor: 'x' } } } },
        undefined as unknown as string | null,
      ),
      true,
    );
  });

  it('matches explicit party ids on the agreement', () => {
    assert.equal(
      isTaskResultRelevantToAgent(
        { agreement: { parties: { provider: { actor: 'a1' } } } },
        'a1',
      ),
      true,
    );
    assert.equal(
      isTaskResultRelevantToAgent(
        { agreement: { parties: { creator: { actor: 'a1' } } } },
        'a1',
      ),
      true,
    );
    assert.equal(
      isTaskResultRelevantToAgent(
        { agreement: { parties: { proposedTo: { principal: 'everyone' } } } },
        'any',
      ),
      true,
    );
    assert.equal(
      isTaskResultRelevantToAgent(
        { agreement: { parties: { proposedTo: { actor: 'a1' } } } },
        'a1',
      ),
      true,
    );
  });

  it('matches IsYou flags', () => {
    assert.equal(isTaskResultRelevantToAgent({ providerIsYou: true }, 'me'), true);
    assert.equal(isTaskResultRelevantToAgent({ creatorIsYou: true }, 'me'), true);
  });

  it('returns false for unrelated agent', () => {
    assert.equal(
      isTaskResultRelevantToAgent(
        { agreement: { parties: { provider: { actor: 'other' } } } },
        'me',
      ),
      false,
    );
  });
});
