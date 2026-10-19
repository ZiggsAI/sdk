/**
 * Agent accommodations for the Claude brain (cleanup): a claude-sdk agent
 * needs no hand-written FSM workflow, builds no (dead) LLM adapter, and must not
 * require an OpenAI key it never uses.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../src/Agent.js';
import { ClaudeBrain } from '../src/brain/ClaudeBrain.js';
import { OpenAIAdapter } from '../src/adapters/OpenAIAdapter.js';
import { AnthropicAdapter } from '../src/adapters/AnthropicAdapter.js';

const CLAUDE_BASE = {
  cognition: 'claude-sdk' as const,
  anthropicKey: 'sk-ant-test',
  operatorKey: 'op-key',
  agentId: 'claude-agent',
  description: 'A hired Claude agent',
};

describe('Agent + claude-sdk cognition (cleanup)', () => {
  it('constructs with no workflow and no openaiKey, wiring the ClaudeBrain and no LLM adapter', () => {
    // Regression: the Claude brain never uses an LLM adapter, but the host used
    // to build one eagerly — and the provider client throws at construction on a
    // missing key, so this previously failed without an unused openaiKey.
    let host!: ReturnType<typeof createAgent>;
    assert.doesNotThrow(() => { host = createAgent({ ...CLAUDE_BASE }); });
    assert.ok(host.brain instanceof ClaudeBrain);
    assert.equal(host.llm, undefined);
  });

  it('synthesizes a trivial parked workflow for the Claude brain', () => {
    const host = createAgent({ ...CLAUDE_BASE });
    assert.equal(host.brain.workflow.initial, 'ready');
    assert.equal(host.brain.workflow.states.ready?.kind, 'parked');
  });

  it('coerces a non-claude model to a safe claude id for the brain', () => {
    const host = createAgent({ ...CLAUDE_BASE, model: 'gpt-5.4' });
    assert.match((host.brain as unknown as { model: string }).model, /^claude/);
  });

  it('still requires an explicit workflow for the FSM cognition', () => {
    // anthropicKey satisfies the key check for the default claude-* model, so
    // the constructor reaches the workflow check this test is asserting on.
    assert.throws(
      () => createAgent({ anthropicKey: 'sk-ant', operatorKey: 'op', agentId: 'fsm-agent' }),
      /workflow \(or states \+ initial\) is required/,
    );
  });
});

describe('Agent + FSM cognition — LLM adapter is unchanged (Ziggs brain)', () => {
  // The Ziggs/FSM brain reaches the model via llm-call/stream-text and can run
  // EITHER provider. Skipping the adapter is claude-sdk-only; the FSM path must
  // still build the right adapter for its model. (User check on cleanup #2.)
  const FSM_BASE = {
    operatorKey: 'op',
    agentId: 'fsm-agent',
    initial: 'idle',
    states: { idle: { kind: 'parked' as const, transitions: [] } },
  };

  it('builds an OpenAI adapter for a non-claude model', () => {
    const host = createAgent({ ...FSM_BASE, openaiKey: 'sk-openai', model: 'gpt-5.4' });
    assert.ok(host.llm instanceof OpenAIAdapter);
  });

  it('builds an Anthropic adapter for a claude model (FSM running a Claude LLM)', () => {
    const host = createAgent({ ...FSM_BASE, anthropicKey: 'sk-ant', model: 'claude-opus-4-8' });
    assert.ok(host.llm instanceof AnthropicAdapter);
  });
});
