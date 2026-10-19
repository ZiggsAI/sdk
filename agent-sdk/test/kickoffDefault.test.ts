import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defineAgent } from '../src/defineAgent.js';
import { AgentMachine, type TransitionEvent } from '../src/runtime/AgentMachine.js';
import { buildClaimKickoffState, CLAIM_KICKOFF_STATE, KICKOFF_STATE } from '../src/runtime/kickoff.js';
import { CLAUDE_SDK_PROTOCOL } from '../src/brain/claudeSdkProtocol.js';
import { TASK_INTAKE_STATE } from '../src/runtime/taskIntake.js';
import { outcomeFromEvent } from '../src/runtime/buildOutcome.js';
import { allPendingSubtasks } from '../src/runtime/taskBookkeeping.js';
import type { Ctx, DefineAgentInput } from '../src/types.js';

const baseInput = (): DefineAgentInput => ({
  agentId: 'kick-test', description: 'd', initial: 'idle',
  states: {
    idle: { kind: 'parked', transitions: [{ to: 'working', when: o => o.kind === 'task-assigned' }] },
    working: {
      kind: 'thinking', prompt: { goal: 'g' },
      actions: {
        done: { prompt: { instruction: 'i' }, produces: 'task-closed' },
        wait: { prompt: { instruction: 'i' }, produces: 'wait' },
      },
      transitions: [
        { to: 'idle', when: o => o.kind === 'task-closed' },
        { to: 'idle', when: o => o.kind === 'wait' },
        { to: 'idle', when: o => o.kind === 'error' },
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

describe('defineAgent agreement-kickoff default', () => {
  it('injects kickingOff last and claimKickingOff first', () => {
    const cfg = defineAgent(baseInput());
    const kickoff = cfg.workflow.states[KICKOFF_STATE];
    assert.ok(kickoff, 'kickingOff state exists');
    assert.equal(kickoff.kind, 'thinking');
    if (kickoff.kind === 'thinking') assert.equal(kickoff.actions.spawnFirstTask.tool, 'task_create');
    const claimKickoff = cfg.workflow.states[CLAIM_KICKOFF_STATE];
    assert.ok(claimKickoff, 'claimKickingOff state exists');
    assert.equal(claimKickoff.kind, 'thinking');
    if (claimKickoff.kind === 'thinking') {
      assert.equal(claimKickoff.actions.openChat.tool, 'chat_open');
      assert.equal(claimKickoff.actions.greetBuyer.produces, 'message-sent');
    }
    // ZIG-1559: the claim kickoff goes in FIRST so it beats an author
    // fallthrough; the proposer kickoff stays LAST so author routes win.
    const idle = cfg.workflow.states['idle'];
    assert.equal(idle.transitions.length, 3);
    assert.equal(idle.transitions[0].to, CLAIM_KICKOFF_STATE);
    assert.equal(idle.transitions[2].to, KICKOFF_STATE);
    // `working` has no task-assigned route, so the task-intake default is
    // appended after: [claimKickoff, ...user, kickoff, taskIntake].
    const working = cfg.workflow.states['working'];
    assert.equal(working.transitions[0].to, CLAIM_KICKOFF_STATE);
    assert.equal(working.transitions[working.transitions.length - 2].to, KICKOFF_STATE);
    assert.equal(working.transitions[working.transitions.length - 1].to, TASK_INTAKE_STATE);
  });

  it('does not inject into a state that already handles proposer approval', () => {
    const input = baseInput();
    // Broad approve handler: suppresses the proposer kickoff. It does NOT
    // suppress the claim kickoff — it fires for a bare counterparty approve
    // too, so it says nothing about claims (ZIG-1559).
    (input.states!['idle'] as any).transitions.push({ to: 'working', when: (o: any) => o.kind === 'proposal-resolved' && o.action === 'approve' });
    const cfg = defineAgent(input);
    const idle = cfg.workflow.states['idle'];
    assert.ok(!idle.transitions.some(t => t.to === KICKOFF_STATE), 'idle not injected');
    assert.equal(idle.transitions[0].to, CLAIM_KICKOFF_STATE, 'idle still gets the claim kickoff, first');
    const working = cfg.workflow.states['working'];
    assert.ok(
      working.transitions.some(t => t.to === KICKOFF_STATE),
      'working got the kickoff transition',
    );
    assert.ok(
      working.transitions.some(t => t.to === CLAIM_KICKOFF_STATE),
      'working got the claim kickoff transition',
    );
    assert.ok(cfg.workflow.states[KICKOFF_STATE], 'kickingOff still exists (working injected)');
    assert.ok(cfg.workflow.states[CLAIM_KICKOFF_STATE], 'claimKickingOff still exists');
  });

  it('injects no kickingOff state when every state handles approval', () => {
    const input = baseInput();
    (input.states!['idle'] as any).transitions.push({ to: 'working', when: (o: any) => o.kind === 'proposal-resolved' });
    (input.states!['working'] as any).transitions.push({ to: 'idle', when: (o: any) => o.kind === 'proposal-resolved' });
    const cfg = defineAgent(input);
    assert.equal(cfg.workflow.states[KICKOFF_STATE], undefined);
    // A generic proposal-resolved route is not a claim handler, so the claim
    // kickoff is still built and still injected (ZIG-1559).
    assert.ok(cfg.workflow.states[CLAIM_KICKOFF_STATE], 'claimKickingOff still built');
  });

  it('ZIG-1559: only an explicit fromClaimWake route suppresses the claim kickoff', () => {
    const input = baseInput();
    (input.states!['idle'] as any).transitions.unshift({
      to: 'working',
      when: (o: any) => o.kind === 'proposal-resolved' && o.fromClaimWake === true,
    });
    const cfg = defineAgent(input);
    const idle = cfg.workflow.states['idle'];
    assert.ok(!idle.transitions.some(t => t.to === CLAIM_KICKOFF_STATE), 'author owns the claim wake');
    // The other state said nothing, so the state itself is still built.
    assert.ok(cfg.workflow.states[CLAIM_KICKOFF_STATE], 'claimKickingOff built for `working`');
  });

  it('ZIG-1559: an unconditional fallthrough no longer swallows the claim', () => {
    // The shape 24 of 83 agents have, 7 of them published: `idle → listening`
    // with nothing else on it. It used to count as "already handles the claim".
    const cfg = defineAgent({
      agentId: 'fallthrough-test', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'listening' }] },
        listening: {
          kind: 'thinking', prompt: { goal: 'g' },
          actions: { wait: { prompt: { instruction: 'i' }, produces: 'wait' } },
          transitions: [{ to: 'idle', when: o => o.kind === 'wait' }],
        },
      },
    });
    const idle = cfg.workflow.states['idle'];
    assert.equal(idle.transitions[0].to, CLAIM_KICKOFF_STATE, 'claim route sits ahead of the fallthrough');
    assert.equal(idle.transitions[1].to, 'listening');
  });

  it('throws on the reserved state name', () => {
    const input = baseInput();
    (input.states as any)[KICKOFF_STATE] = { kind: 'parked', transitions: [] };
    assert.throws(() => defineAgent(input), /reserved/);
  });

  it('throws on the reserved claim kickoff state name', () => {
    const input = baseInput();
    (input.states as any)[CLAIM_KICKOFF_STATE] = { kind: 'parked', transitions: [] };
    assert.throws(() => defineAgent(input), /reserved/);
  });

  it('proposer path: approval event routes through kickingOff and spawns', async () => {
    const wf = defineAgent(baseInput()).workflow;
    let turns = 0;
    const events: TransitionEvent[] = [];
    const m = new AgentMachine({
      workflow: wf,
      executionCore: (async () => { turns++; return { outcome: { kind: 'task-delegated', task: { taskId: 't9', agreementId: 'ag-1' } }, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } }; }) as any,
      eff: noopEff, toolManager: {} as any, promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, ctx: fullCtx({ pendingProposalAgreementId: 'ag-1' }) },
      transitionTap: (e) => events.push(e),
    });
    await m.send({ event: { type: 'agreement_lifecycle', operation: 'proposal_approved_execute', agreementId: 'ag-1' } as any });
    const trans = events.filter(e => e.kind === 'transition') as Extract<TransitionEvent, { kind: 'transition' }>[];
    assert.ok(trans.some(t => t.toState === KICKOFF_STATE), 'entered kickingOff');
    assert.equal(m.state, 'idle');
    assert.equal(turns, 1);
    assert.ok(allPendingSubtasks(m.ctx)['t9'], 'task recorded as pending subtask');
    assert.ok(m.ctx.tasks['__lane__']?.delegatedAgreementIds.includes('ag-1'));
    assert.ok(m.ctx.tasks['__lane__']?.pendingSubtasks['t9'], 'also stored under coordinator lane book');
    assert.equal(m.ctx.activeAgreementId, 'ag-1');
    assert.equal(m.ctx.pendingProposalAgreementId, null);
  });

  it('counterparty (approver) never kicks off', async () => {
    const wf = defineAgent(baseInput()).workflow;
    let turns = 0;
    const m = new AgentMachine({
      workflow: wf,
      executionCore: (async () => { turns++; return { outcome: { kind: 'wait' }, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } }; }) as any,
      eff: noopEff, toolManager: {} as any, promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, ctx: fullCtx({ pendingProposalAgreementId: null }) },
    });
    await m.send({ event: { type: 'agreement_lifecycle', operation: 'proposal_approved_execute', agreementId: 'ag-1' } as any });
    assert.equal(m.state, 'idle');
    assert.equal(turns, 0);
  });

  it('ZIG-1278: store-claim provider wake routes through claimKickingOff', async () => {
    const wf = defineAgent(baseInput()).workflow;
    let turns = 0;
    const events: TransitionEvent[] = [];
    const m = new AgentMachine({
      workflow: wf,
      executionCore: (async () => {
        turns++;
        return {
          outcome: { kind: 'message-sent', text: 'hi buyer', receiverId: 'buyer-1' },
          toolResults: [],
          llmCalls: 1,
          tokens: { total: 0, input: 0, output: 0 },
        };
      }) as any,
      eff: noopEff, toolManager: {} as any, promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'agrn-ag-claim', laneKey: 'A:agrn-ag-claim' }, ctx: fullCtx({ pendingProposalAgreementId: null }) },
      transitionTap: (e) => events.push(e),
    });
    await m.send({
      event: {
        type: 'resource_changed',
        resource: {
          kind: 'agreement',
          reason: 'proposal_approved',
          resourceId: 'ag-claim',
          agreementId: 'ag-claim',
          actorId: 'buyer-1',
        },
        senderId: 'buyer-1',
        agreementId: 'ag-claim',
      } as any,
    });
    const trans = events.filter(e => e.kind === 'transition') as Extract<TransitionEvent, { kind: 'transition' }>[];
    assert.ok(trans.some(t => t.toState === CLAIM_KICKOFF_STATE), 'entered claimKickingOff');
    assert.ok(!trans.some(t => t.toState === KICKOFF_STATE), 'did not enter proposer kickingOff');
    assert.equal(m.state, 'idle');
    assert.equal(turns, 1);
    assert.equal(m.ctx.activeAgreementId, 'ag-claim');
  });

  it('ZIG-1559: a claim wake reaches claimKickingOff from an idle→listening initial state', async () => {
    const wf = defineAgent({
      agentId: 'fallthrough-run', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'listening' }] },
        listening: {
          kind: 'thinking', prompt: { goal: 'g' },
          actions: { wait: { prompt: { instruction: 'i' }, produces: 'wait' } },
          transitions: [{ to: 'idle', when: o => o.kind === 'wait' }],
        },
      },
    }).workflow;
    const events: TransitionEvent[] = [];
    const m = new AgentMachine({
      workflow: wf,
      executionCore: (async () => ({
        outcome: { kind: 'message-sent', text: 'hi buyer', receiverId: 'buyer-1' },
        toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 },
      })) as any,
      eff: noopEff, toolManager: {} as any, promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'agrn-ag-claim', laneKey: 'A:agrn-ag-claim' }, ctx: fullCtx() },
      transitionTap: (e) => events.push(e),
    });
    await m.send({
      event: {
        type: 'resource_changed',
        resource: { kind: 'agreement', reason: 'proposal_approved', resourceId: 'ag-claim', agreementId: 'ag-claim', actorId: 'buyer-1' },
        senderId: 'buyer-1',
        agreementId: 'ag-claim',
      } as any,
    });
    const trans = events.filter(e => e.kind === 'transition') as Extract<TransitionEvent, { kind: 'transition' }>[];
    assert.ok(trans.some(t => t.toState === CLAIM_KICKOFF_STATE), 'entered claimKickingOff, not listening');
    assert.equal(m.ctx.activeAgreementId, 'ag-claim');
  });

  it('ZIG-1559: an author keying on fromClaimWake still wins', async () => {
    const wf = defineAgent({
      agentId: 'author-owns-claim', description: 'd', initial: 'idle',
      states: {
        idle: {
          kind: 'parked',
          transitions: [
            { to: 'mine', when: o => o.kind === 'proposal-resolved' && o.fromClaimWake === true },
            { to: 'listening' },
          ],
        },
        mine: {
          kind: 'thinking', prompt: { goal: 'g' },
          actions: { wait: { prompt: { instruction: 'i' }, produces: 'wait' } },
          transitions: [{ to: 'idle', when: o => o.kind === 'wait' }],
        },
        listening: {
          kind: 'thinking', prompt: { goal: 'g' },
          actions: { wait: { prompt: { instruction: 'i' }, produces: 'wait' } },
          transitions: [{ to: 'idle', when: o => o.kind === 'wait' }],
        },
      },
    }).workflow;
    const events: TransitionEvent[] = [];
    const m = new AgentMachine({
      workflow: wf,
      executionCore: (async () => ({
        outcome: { kind: 'wait' }, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 },
      })) as any,
      eff: noopEff, toolManager: {} as any, promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'agrn-ag-claim', laneKey: 'A:agrn-ag-claim' }, ctx: fullCtx() },
      transitionTap: (e) => events.push(e),
    });
    await m.send({
      event: {
        type: 'resource_changed',
        resource: { kind: 'agreement', reason: 'proposal_approved', resourceId: 'ag-claim', agreementId: 'ag-claim', actorId: 'buyer-1' },
        senderId: 'buyer-1',
        agreementId: 'ag-claim',
      } as any,
    });
    const trans = events.filter(e => e.kind === 'transition') as Extract<TransitionEvent, { kind: 'transition' }>[];
    assert.ok(trans.some(t => t.toState === 'mine'), 'author state won');
    assert.ok(!trans.some(t => t.toState === CLAIM_KICKOFF_STATE), 'no injected kickoff');
  });

  it('duplicate approval frame does not double-fire', async () => {
    const wf = defineAgent(baseInput()).workflow;
    let turns = 0;
    const m = new AgentMachine({
      workflow: wf,
      executionCore: (async () => { turns++; return { outcome: { kind: 'task-delegated', task: { taskId: 't9', agreementId: 'ag-1' } }, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } }; }) as any,
      eff: noopEff, toolManager: {} as any, promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, ctx: fullCtx({ pendingProposalAgreementId: 'ag-1' }) },
    });
    await m.send({ event: { type: 'agreement_lifecycle', operation: 'proposal_approved_execute', agreementId: 'ag-1' } as any });
    await m.send({ event: { type: 'agreement_lifecycle', operation: 'proposal_approved', agreementId: 'ag-1' } as any });
    assert.equal(turns, 1);
    assert.equal(m.state, 'idle');
  });

  it('first-task guard: already-delegated agreement suppresses kickoff', async () => {
    const wf = defineAgent(baseInput()).workflow;
    let turns = 0;
    const m = new AgentMachine({
      workflow: wf,
      executionCore: (async () => { turns++; return { outcome: { kind: 'wait' }, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } }; }) as any,
      eff: noopEff, toolManager: {} as any, promptBuilder: {} as any,
      input: {
        identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' },
        ctx: fullCtx({
          pendingProposalAgreementId: 'ag-1',
          tasks: {
            __lane__: {
              agreementId: 'ag-1',
              pendingSubtasks: {},
              collectedResults: [],
              delegatedAgreementIds: ['ag-1'],
            },
          },
        }),
      },
    });
    await m.send({ event: { type: 'agreement_lifecycle', operation: 'proposal_approved_execute', agreementId: 'ag-1' } as any });
    assert.equal(turns, 0);
    assert.equal(m.state, 'idle');
  });

  it('wire path defaults proposedByMe to false', () => {
    const o = outcomeFromEvent({ type: 'agreement_lifecycle', operation: 'proposal_approved', agreementId: 'a' } as any, 'me');
    assert.equal(o.kind, 'proposal-resolved');
    if (o.kind === 'proposal-resolved') {
      assert.equal(o.proposedByMe, false);
      assert.equal(o.fromClaimWake, undefined);
    }
  });

  it('ZIG-2001: a claim kickoff names the hire room instead of saying there is no chat', () => {
    const kickoff = buildClaimKickoffState('idle');
    const text = [
      kickoff.prompt.role,
      kickoff.prompt.goal,
      kickoff.prompt.constraints,
      kickoff.actions.openChat?.prompt.when,
      kickoff.actions.openChat?.prompt.instruction,
      CLAUDE_SDK_PROTOCOL,
    ].join('\n');
    assert.match(text, /agreementId/);
    assert.match(text, /usually made at claim/);
    assert.doesNotMatch(text, /no chat yet/);
    assert.doesNotMatch(text, /often with no chat/);
    assert.match(text, /agrn-\*/);
  });

  it('ZIG-1278: resource_changed proposal_approved stamps fromClaimWake', () => {
    const o = outcomeFromEvent({
      type: 'resource_changed',
      resource: {
        kind: 'agreement',
        reason: 'proposal_approved',
        agreementId: 'ag-claim',
        resourceId: 'ag-claim',
      },
    } as any, 'me');
    assert.equal(o.kind, 'proposal-resolved');
    if (o.kind === 'proposal-resolved') {
      assert.equal(o.action, 'approve');
      assert.equal(o.fromClaimWake, true);
      assert.equal(o.proposedByMe, false);
    }
  });
});
