import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defineAgent } from '../src/defineAgent.js';
import { AgentMachine, type TransitionEvent } from '../src/runtime/AgentMachine.js';
import { TASK_INTAKE_STATE } from '../src/runtime/taskIntake.js';
import type { Ctx, DefineAgentInput } from '../src/types.js';

// A hire-shaped workflow: after approval the agent parks in `engaged` with no
// task-assigned route — exactly the state that used to swallow task #2..N
// under a standing hire.
const hireShapedInput = (): DefineAgentInput => ({
  agentId: 'intake-test', description: 'd', initial: 'idle',
  states: {
    idle: { kind: 'parked', transitions: [{ to: 'listening' }] },
    listening: {
      kind: 'thinking', prompt: { goal: 'g' },
      actions: { wait: { prompt: { instruction: 'i' }, produces: 'wait' } },
      transitions: [
        { to: 'engaged', when: o => o.kind === 'proposal-resolved' && o.action === 'approve' },
        { to: 'idle', when: o => o.kind === 'wait' },
        { to: 'idle', when: o => o.kind === 'error' },
      ],
    },
    engaged: {
      kind: 'parked',
      transitions: [
        { to: 'listening', when: o => o.kind === 'message-received' },
      ],
    },
  },
});

function fullCtx(extra: Partial<Ctx> = {}): Ctx {
  return {
    identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' },
    tasks: {},
    activeAgreementId: null, activeTaskId: null, pendingProposalAgreementId: null,
    pendingSubtasks: {}, collectedResults: [], delegatedAgreementIds: [],
    toolResults: [], lastOutcome: { kind: 'enter' },
    ...extra,
  } as Ctx;
}

const noopEff = (async () => ({ ok: true } as any)) as any;

describe('defineAgent assigned-task-intake default', () => {
  it('injects workingAssignedTask and appends the transition last on states without a task-assigned route', () => {
    const cfg = defineAgent(hireShapedInput());
    const intake = cfg.workflow.states[TASK_INTAKE_STATE];
    assert.ok(intake, 'workingAssignedTask state exists');
    assert.equal(intake.kind, 'thinking');
    if (intake.kind === 'thinking') {
      assert.equal(intake.actions.completeTask.tool, 'task_set_result');
      assert.equal(intake.actions.failTask.tool, 'task_set_result');
    }
    const engaged = cfg.workflow.states['engaged'];
    assert.equal(engaged.transitions[engaged.transitions.length - 1].to, TASK_INTAKE_STATE);
    // idle has an unconditional transition — it already catches task-assigned.
    const idle = cfg.workflow.states['idle'];
    assert.ok(!idle.transitions.some(t => t.to === TASK_INTAKE_STATE), 'idle not injected');
  });

  it('does not inject when every state routes task-assigned', () => {
    const input = hireShapedInput();
    (input.states!['engaged'] as any).transitions.push({ to: 'listening', when: (o: any) => o.kind === 'task-assigned' });
    (input.states!['listening'] as any).transitions.push({ to: 'engaged', when: (o: any) => o.kind === 'task-assigned' });
    const cfg = defineAgent(input);
    assert.equal(cfg.workflow.states[TASK_INTAKE_STATE], undefined);
  });

  it('throws on the reserved state name', () => {
    const input = hireShapedInput();
    (input.states as any)[TASK_INTAKE_STATE] = { kind: 'parked', transitions: [] };
    assert.throws(() => defineAgent(input), /reserved/);
  });

  it('a task assigned while parked in engaged runs the intake turn and returns to initial', async () => {
    const wf = defineAgent(hireShapedInput()).workflow;
    let turns = 0;
    const events: TransitionEvent[] = [];
    const m = new AgentMachine({
      workflow: wf,
      executionCore: (async () => {
        turns++;
        return {
          outcome: { kind: 'task-closed', status: 'completed', result: 'done' },
          toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 },
        };
      }) as any,
      eff: noopEff, toolManager: {} as any, promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, ctx: fullCtx() },
      transitionTap: (e) => events.push(e),
    });
    // Park the machine in engaged first.
    (m as any).state = 'engaged';
    await m.send({
      event: {
        type: 'task_result',
        receiverId: 'A',
        result: { taskId: 't42', agreementId: 'ag-7', state: 'active', assigneeId: 'A' },
      } as any,
    });
    const trans = events.filter(e => e.kind === 'transition') as Extract<TransitionEvent, { kind: 'transition' }>[];
    assert.ok(trans.some(t => t.toState === TASK_INTAKE_STATE), 'entered workingAssignedTask');
    assert.equal(turns, 1, 'the intake turn ran — the task was not silently dropped');
    assert.equal(m.state, 'idle');
  });

  it('an author task-assigned route always wins over the injected default', async () => {
    const input = hireShapedInput();
    (input.states!['engaged'] as any).transitions.unshift({ to: 'listening', when: (o: any) => o.kind === 'task-assigned' });
    const cfg = defineAgent(input);
    const engaged = cfg.workflow.states['engaged'];
    assert.ok(!engaged.transitions.some(t => t.to === TASK_INTAKE_STATE), 'engaged keeps the author route only');
  });
});
