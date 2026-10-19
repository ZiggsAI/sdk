import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentMachine } from '../src/runtime/AgentMachine.js';
import { PromptBuilder } from '../src/runtime/PromptBuilder.js';
import { ToolManager } from '../src/tools/ToolManager.js';
import type { Workflow, Outcome, Identity, Effect, EffectHandler, ToolResultEntry } from '../src/types.js';

/**
 * Integration test for the agent loop. Drives the state machine end-to-end
 * through: message → understanding → awaitingApproval → delegating →
 * supervising. Uses AgentMachine directly with a mocked executionCore so we
 * can substitute a fixed outcome queue for the LLM/tool path.
 */

function makeWorkflow(): Workflow {
  return {
    id: 'loop-agent',
    description: 'Test orchestrator',
    initial: 'idle',
    states: {
      idle: {
        kind: 'parked',
        transitions: [
          { to: 'understanding', when: o => o.kind === 'message-received' },
        ],
      },
      understanding: {
        kind: 'thinking',
        prompt: { goal: 'Understand user ask and propose an agreement' },
        actions: {
          proposeAgent: { prompt: { instruction: 'Propose a contract' }, tool: 'agreement_propose', produces: 'proposal-made' },
          hold: { prompt: { instruction: 'Wait' }, produces: 'wait' },
        },
        transitions: [
          { to: 'awaitingApproval', when: o => o.kind === 'proposal-made' },
          { to: 'idle', when: o => o.kind === 'wait' },
        ],
      },
      awaitingApproval: {
        kind: 'parked',
        transitions: [
          { to: 'delegating', when: o => o.kind === 'task-assigned' },
        ],
      },
      delegating: {
        kind: 'thinking',
        prompt: { goal: 'Delegate to specialist' },
        actions: {
          delegate: { prompt: { instruction: 'Subcontract to specialist' }, tool: 'agreement_subcontract', produces: 'task-delegated' },
        },
        transitions: [
          { to: 'supervising', when: o => o.kind === 'task-delegated' },
        ],
      },
      supervising: {
        kind: 'parked',
        transitions: [
          { to: 'idle', when: o => o.kind === 'task-closed' },
        ],
      },
    },
  };
}

const IDENTITY: Identity = { agentId: 'orch', sessionId: 'chat-loop', laneKey: 'orch:chat-loop' };

const noopEff: EffectHandler = async (_e: Effect) => ({} as any);

describe('AgentMachine full loop (mocked executionCore; no WebSocket, no backend)', () => {
  it('runs idle → understanding → awaitingApproval → delegating → supervising', async () => {
    const outcomeQueue: Outcome[] = [
      { kind: 'proposal-made', proposal: { agreementId: 'agr-prop-1' } },
      { kind: 'task-delegated', task: { taskId: 'del-1', agreementId: 'agr-del-1' } },
    ];
    const executionCore = async () => {
      const outcome = outcomeQueue.shift() ?? { kind: 'wait' as const };
      return {
        outcome,
        toolResults: [] as ToolResultEntry[],
        llmCalls: 1,
        tokens: { total: 0, input: 0, output: 0 },
      };
    };

    const machine = new AgentMachine({
      workflow: makeWorkflow(),
      executionCore: executionCore as any,
      eff: noopEff,
      toolManager: new ToolManager(),
      promptBuilder: new PromptBuilder(),
      input: { identity: IDENTITY },
    });

    // Step 1: message → understanding → (proposal-made) → awaitingApproval
    await machine.send({ event: { type: 'message', text: 'I need coffee' }, identity: IDENTITY });
    assert.equal(machine.state, 'awaitingApproval', `expected awaitingApproval, got ${machine.state}`);

    // Step 2: task-assigned → delegating → (task-delegated) → supervising
    await machine.send({
      event: {
        type: 'task_result',
        result: {
          taskId: 'root-1', state: 'active', providerIsYou: true,
          agreement: { agreementId: 'agr-root-1', parties: { creator: { actor: 'orch' }, provider: { actor: 'orch' } }, proposal: { status: 'approved' } },
        },
      },
      identity: IDENTITY,
    });
    assert.equal(machine.state, 'supervising', `expected supervising, got ${machine.state}`);
  });
});
