/**
 * ZIG-784 — public brain selection API.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ziggsBrain,
  claudeBrain,
  applyBrainToAgentOptions,
  isBrainSelection,
} from '../src/brain/index.js';
import { createAgent } from '../src/Agent.js';
import { ClaudeBrain } from '../src/brain/ClaudeBrain.js';
import { ZiggsBrain } from '../src/brain/ZiggsBrain.js';

describe('brain factories', () => {
  it('ziggsBrain and claudeBrain return branded selections', () => {
    assert.equal(ziggsBrain().kind, 'ziggs');
    assert.equal(claudeBrain({ anthropicKey: 'sk-ant' }).kind, 'claude');
    assert.ok(isBrainSelection(ziggsBrain()));
    assert.ok(isBrainSelection(claudeBrain()));
    assert.equal(isBrainSelection({ kind: 'other' }), false);
  });

  it('applyBrainToAgentOptions maps claude brain to claude-sdk cognition', () => {
    const out = applyBrainToAgentOptions({
      brain: claudeBrain({ anthropicKey: 'sk-ant', model: 'claude-opus-4-8', maxTurns: 8 }),
      operatorKey: 'op',
    });
    assert.equal(out.cognition, 'claude-sdk');
    assert.equal(out.anthropicKey, 'sk-ant');
    assert.equal(out.model, 'claude-opus-4-8');
    assert.equal(out.claudeMaxTurns, 8);
  });

  it('applyBrainToAgentOptions maps ziggs brain to fsm cognition', () => {
    const out = applyBrainToAgentOptions({
      brain: ziggsBrain({ openaiKey: 'sk-openai', model: 'gpt-5.4' }),
    });
    assert.equal(out.cognition, 'fsm');
    assert.equal(out.openaiKey, 'sk-openai');
    assert.equal(out.model, 'gpt-5.4');
  });

  it('brain wins over legacy cognition when both are set', () => {
    const out = applyBrainToAgentOptions({
      brain: claudeBrain({ anthropicKey: 'sk-ant' }),
      cognition: 'fsm',
    });
    assert.equal(out.cognition, 'claude-sdk');
  });
});

describe('Agent + brain injection', () => {
  const FSM_STATES = {
    initial: 'idle',
    states: { idle: { kind: 'parked' as const, transitions: [] } },
  };

  it('claudeBrain() wires ClaudeBrain without legacy cognition flag', () => {
    const host = createAgent({
      ...FSM_STATES,
      brain: claudeBrain({ anthropicKey: 'sk-ant-test' }),
      operatorKey: 'op-key',
      agentId: 'claude-via-brain',
      description: 'Claude brain via factory',
    });
    assert.ok(host.brain instanceof ClaudeBrain);
    assert.equal(host.options.cognition, 'claude-sdk');
    assert.equal(host.llm, undefined);
  });

  it('ziggsBrain() wires the FSM ZiggsBrain', () => {
    const host = createAgent({
      ...FSM_STATES,
      brain: ziggsBrain({ openaiKey: 'sk-openai' }),
      operatorKey: 'op',
      agentId: 'ziggs-via-brain',
      description: 'Ziggs brain via factory',
      model: 'gpt-5.4',
    });
    assert.ok(host.brain instanceof ZiggsBrain);
    assert.equal(host.options.cognition, 'fsm');
  });
});
