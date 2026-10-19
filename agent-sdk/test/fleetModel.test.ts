import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { defineAgent } from '../src/defineAgent.js';
import { DEFAULT_MODEL, resolveFleetModel } from '../src/shared/fleetModel.js';

const parked = {
  agentId: 'fleet-model',
  description: 'resolves one model',
  initial: 'ready',
  states: { ready: { kind: 'parked' as const, transitions: [] } },
};

describe('resolveFleetModel', () => {
  const previous = process.env.LLM_MODEL;
  afterEach(() => {
    if (previous === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = previous;
  });

  it('defaults every unpinned agent to Sonnet 5.5', () => {
    delete process.env.LLM_MODEL;
    assert.equal(DEFAULT_MODEL, 'claude-sonnet-5-5');
    assert.equal(resolveFleetModel(), 'claude-sonnet-5-5');
    assert.equal(defineAgent(parked).model, 'claude-sonnet-5-5');
  });

  it('moves every unpinned agent when LLM_MODEL changes', () => {
    process.env.LLM_MODEL = 'claude-haiku-4-5';
    assert.equal(resolveFleetModel(), 'claude-haiku-4-5');
    assert.equal(defineAgent(parked).model, 'claude-haiku-4-5');
  });

  it('keeps an explicit pin ahead of the fleet setting', () => {
    process.env.LLM_MODEL = 'claude-haiku-4-5';
    assert.equal(resolveFleetModel('claude-opus-4-8'), 'claude-opus-4-8');
    assert.equal(
      defineAgent({
        ...parked,
        services: { llm: { model: 'claude-opus-4-8' } },
      }).model,
      'claude-opus-4-8',
    );
  });
});
