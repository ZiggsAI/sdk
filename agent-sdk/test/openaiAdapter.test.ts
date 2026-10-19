import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maxCompletionTokensForModel } from '../src/adapters/OpenAIAdapter.js';

describe('maxCompletionTokensForModel', () => {
  it('caps gpt-4o family at 16384', () => {
    assert.equal(maxCompletionTokensForModel('gpt-4o-mini'), 16384);
    assert.equal(maxCompletionTokensForModel('gpt-4o'), 16384);
  });

  it('keeps 25000 for reasoning / newer models', () => {
    assert.equal(maxCompletionTokensForModel('gpt-5.4'), 25000);
    assert.equal(maxCompletionTokensForModel('o3-mini'), 25000);
  });
});
