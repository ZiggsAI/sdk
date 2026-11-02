import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mcpAgentWorkflow } from '../src/mcp/createMcpAgent.js';
import { AgentMachine, type TransitionEvent } from '../src/runtime/AgentMachine.js';
import { TASK_INTAKE_STATE } from '../src/runtime/taskIntake.js';
import type { Ctx } from '../src/types.js';

const TOOLS = [{ name: 'web_search', description: 'Search the web' }];

function fullCtx(): Ctx {
  return {
    identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' },
    tasks: {},
    activeAgreementId: null, activeTaskId: null, pendingProposalAgreementId: null,
    pendingSubtasks: {}, collectedResults: [], delegatedAgreementIds: [],
    toolResults: [], lastOutcome: { kind: 'enter' },
  } as Ctx;
}

describe('MCP agent workflow: an assigned task is answered with its result', () => {
  it('routes every state of the default workflow to the task intake', () => {
    const wf = mcpAgentWorkflow(undefined, 'Search agent', TOOLS);
    const intake = wf.states[TASK_INTAKE_STATE];
    assert.ok(intake && intake.kind === 'thinking', 'the intake state exists');
    if (intake.kind === 'thinking') assert.equal(intake.actions.completeTask.tool, 'task_set_result');
    for (const name of ['idle', 'done']) {
      const t = wf.states[name].transitions;
      assert.equal(t[t.length - 1].to, TASK_INTAKE_STATE, `${name} routes a task to the intake`);
    }
  });

  it('applies the intake to a workflow the caller passed in too', () => {
    const wf = mcpAgentWorkflow(
      { id: 'w', description: 'd', initial: 'only', states: { only: { kind: 'parked', transitions: [] } } },
      'unused',
      TOOLS,
    );
    assert.ok(wf.states[TASK_INTAKE_STATE]);
  });

  it('a task wake in idle runs the intake turn, not a reply', async () => {
    let turns = 0;
    const events: TransitionEvent[] = [];
    const m = new AgentMachine({
      workflow: mcpAgentWorkflow(undefined, 'Search agent', TOOLS),
      executionCore: (async () => {
        turns++;
        return {
          outcome: { kind: 'task-closed', status: 'completed', result: 'found 3 articles' },
          toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 },
        };
      }) as never,
      eff: (async () => ({ ok: true })) as never,
      toolManager: {} as never,
      promptBuilder: {} as never,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, ctx: fullCtx() },
      transitionTap: (e) => events.push(e),
    });
    await m.send({
      event: {
        type: 'task_result',
        receiverId: 'A',
        result: { taskId: 't1', agreementId: 'ag-1', state: 'active', assigneeId: 'A' },
      } as never,
    });
    const transitions = events.filter((e) => e.kind === 'transition') as Extract<TransitionEvent, { kind: 'transition' }>[];
    // The wake goes straight to the intake. Before the fix idle took it and
    // answered with a reply that had no recipient.
    assert.equal(transitions[0]?.toState, TASK_INTAKE_STATE, 'the task wake enters the intake first');
    assert.ok(turns >= 1, 'the intake turn ran');
    assert.equal(m.state, 'idle', 'and the agent is back in idle once the task closed');
  });
});
