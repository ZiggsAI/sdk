import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentMachine, type TransitionEvent } from '../src/runtime/AgentMachine.js';
import {
  allCollectedResults,
  allPendingSubtasks,
} from '../src/runtime/taskBookkeeping.js';
import type { Workflow, Outcome } from '../src/types.js';

const wf = (): Workflow => ({
  id: 'test', description: 'd', initial: 'idle',
  states: {
    idle: {
      kind: 'parked',
      transitions: [
        { to: 'busy', when: o => o.kind === 'task-assigned' },
        { to: 'chatting', when: o => o.kind === 'message-received' },
      ],
    },
    busy: {
      kind: 'thinking',
      prompt: {},
      actions: {
        finish: { prompt: { instruction: 'i' }, produces: 'task-closed' },
        wait: { prompt: { instruction: 'i' }, produces: 'wait' },
      },
      transitions: [
        { to: 'idle', when: o => o.kind === 'task-closed' },
        { to: 'idle', when: o => o.kind === 'wait' },
      ],
    },
    chatting: {
      kind: 'thinking',
      prompt: {},
      actions: {
        greet: { prompt: { instruction: 'i' }, produces: 'message-sent' },
        wait: { prompt: { instruction: 'i' }, produces: 'wait' },
      },
      transitions: [
        { to: 'idle', when: o => o.kind === 'message-sent' },
        { to: 'idle', when: o => o.kind === 'wait' },
      ],
    },
  },
});

function makeMachine(turnOutcome: Outcome) {
  const noopEff = (async () => ({ ok: true } as any)) as any;
  return new AgentMachine({
    workflow: wf(),
    executionCore: (async () => ({ outcome: turnOutcome, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } })) as any,
    eff: noopEff,
    toolManager: {} as any,
    promptBuilder: {} as any,
    input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' } },
  });
}

describe('AgentMachine', () => {
  it('starts in initial state, parked', () => {
    const m = makeMachine({ kind: 'wait' });
    assert.equal(m.state, 'idle');
    assert.equal(m.isParked, true);
    assert.equal(m.ctx.lastOutcome.kind, 'enter');
  });

  it('transitions parked → thinking → re-park on event-driven outcome', async () => {
    const m = makeMachine({ kind: 'task-closed', status: 'completed' });
    const ev = { type: 'task_result', result: { taskId: 't1', state: 'active', providerIsYou: true } };
    await m.send({ event: ev });
    assert.equal(m.state, 'idle');
    assert.equal(m.ctx.activeTaskId, null);
  });

  it('routes message-received → chatting → message-sent → idle', async () => {
    const m = makeMachine({ kind: 'message-sent', text: 'hello' });
    await m.send({ event: { type: 'message', text: 'hi' } });
    assert.equal(m.state, 'idle');
  });

  it('exposes ctx.lastOutcome after each step', async () => {
    const m = makeMachine({ kind: 'task-closed', status: 'completed' });
    await m.send({ event: { type: 'task_result', result: { taskId: 't1', state: 'active', providerIsYou: true } } });
    assert.equal(m.ctx.lastOutcome.kind, 'task-closed');
  });

  it('parks after one thinking turn when the outcome matches no transition (ZIG-303)', async () => {
    const noopEff = (async () => ({ ok: true } as any)) as any;
    let turns = 0;
    const loopWf = (): Workflow => ({
      id: 'loop', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'stuck' }] },
        stuck: {
          kind: 'thinking',
          prompt: {},
          actions: {
            noop: { prompt: { instruction: 'i' }, produces: 'tool-result' },
          },
          allowNoWait: true,
          transitions: [],
        },
      },
    });
    const m = new AgentMachine({
      workflow: loopWf(),
      executionCore: (async () => {
        turns++;
        return {
          outcome: { kind: 'tool-result', tool: 'agent_network', result: {} },
          toolResults: [],
          llmCalls: 1,
          tokens: { total: 0, input: 0, output: 0 },
        };
      }) as any,
      eff: noopEff,
      toolManager: {} as any,
      promptBuilder: {} as any,
      input: {
        identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' },
        state: 'stuck',
      },
    });

    await m._step({ kind: 'message-received', text: 'hi', senderId: 'user-1' }, 0);

    assert.equal(turns, 1, 'must not silently re-roll the same thinking state');
    // ZIG-1573: parking used to leave `this.state` at `stuck`, so the next
    // event was judged by that thinking state's transitions.
    assert.equal(m.state, 'idle');
    assert.equal(m.ctx.lastOutcome.kind, 'tool-result');
  });

  it('escapes to parked initial on error when no transition is defined (ZIG-303)', async () => {
    const noopEff = (async () => ({ ok: true } as any)) as any;
    const loopWf = (): Workflow => ({
      id: 'loop', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'stuck' }] },
        stuck: {
          kind: 'thinking',
          prompt: {},
          actions: {
            noop: { prompt: { instruction: 'i' }, produces: 'wait' },
          },
          allowNoWait: true,
          transitions: [],
        },
      },
    });
    const m = new AgentMachine({
      workflow: loopWf(),
      executionCore: (async () => ({
        outcome: { kind: 'error', source: 'unknown', cause: 'empty turn', retryable: false },
        toolResults: [],
        llmCalls: 1,
        tokens: { total: 0, input: 0, output: 0 },
      })) as any,
      eff: noopEff,
      toolManager: {} as any,
      promptBuilder: {} as any,
      input: {
        identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' },
        state: 'stuck',
      },
    });

    await m._step({ kind: 'message-received', text: 'hi', senderId: 'user-1' }, 0);

    assert.equal(m.state, 'idle');
    assert.equal(m.isParked, true);
  });

  it('sends apology to user on error-escape to parked initial', async () => {
    const sent: { text: string; receiverId: string }[] = [];
    const eff = (async (effect: any) => {
      if (effect.kind === 'send-message') sent.push({ text: effect.text, receiverId: effect.receiverId });
      return { ok: true };
    }) as any;

    const loopWf = (): Workflow => ({
      id: 'loop', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'stuck' }] },
        stuck: {
          kind: 'thinking', prompt: {}, allowNoWait: true,
          actions: { noop: { prompt: { instruction: 'i' }, produces: 'wait' } },
          transitions: [],
        },
      },
    });

    const m = new AgentMachine({
      workflow: loopWf(),
      executionCore: (async () => ({
        outcome: { kind: 'error', source: 'protocol', cause: 'send-failed', retryable: false },
        toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 },
      })) as any,
      eff,
      toolManager: {} as any,
      promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, state: 'stuck' },
    });

    m._lastUserSenderId = 'user-1';
    await m._step({ kind: 'message-received', text: 'hi', senderId: 'user-1' }, 0);

    assert.equal(m.state, 'idle');
    assert.equal(m.isParked, true);
    assert.equal(sent.length, 1, 'expected one apology message on error-escape');
    assert.equal(sent[0].receiverId, 'user-1');
    assert.equal(sent[0].text, 'Something went wrong. Please try again.');
  });

  it('sends fallback message to user when no transition matches and machine parks silently (ZIG-402)', async () => {
    const sent: { text: string; receiverId: string }[] = [];
    const eff = (async (effect: any) => {
      if (effect.kind === 'send-message') sent.push({ text: effect.text, receiverId: effect.receiverId });
      return { ok: true };
    }) as any;

    const stuckWf = (): Workflow => ({
      id: 'stuck', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'stuck' }] },
        stuck: {
          kind: 'thinking', prompt: {}, allowNoWait: true,
          actions: { noop: { prompt: { instruction: 'i' }, produces: 'tool-result' } },
          transitions: [],
        },
      },
    });

    const m = new AgentMachine({
      workflow: stuckWf(),
      executionCore: (async () => ({ outcome: { kind: 'tool-result', tool: 't', result: {} }, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } })) as any,
      eff,
      toolManager: {} as any,
      promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, state: 'stuck' },
    });

    // Simulate an inbound user message so _lastUserSenderId is set
    m._lastUserSenderId = 'user-1';
    await m._step({ kind: 'message-received', text: 'hi', senderId: 'user-1' }, 0);

    assert.equal(sent.length, 1, 'expected one fallback message to the user');
    assert.equal(sent[0].receiverId, 'user-1');
    assert.ok(sent[0].text.length > 0);
  });

  it('sends fallback message when depth guard trips (ZIG-402)', async () => {
    const sent: { text: string; receiverId: string }[] = [];
    const eff = (async (effect: any) => {
      if (effect.kind === 'send-message') sent.push({ text: effect.text, receiverId: effect.receiverId });
      return { ok: true };
    }) as any;

    const loopWf = (): Workflow => ({
      id: 'loop', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'looping' }] },
        looping: {
          kind: 'thinking', prompt: {}, allowNoWait: true,
          actions: { noop: { prompt: { instruction: 'i' }, produces: 'tool-result' } },
          transitions: [{ to: 'looping', when: o => o.kind === 'tool-result' }],
        },
      },
    });

    const m = new AgentMachine({
      workflow: loopWf(),
      executionCore: (async () => ({ outcome: { kind: 'tool-result', tool: 't', result: {} }, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } })) as any,
      eff,
      toolManager: {} as any,
      promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, state: 'looping' },
    });

    m._lastUserSenderId = 'user-1';
    await m._step({ kind: 'message-received', text: 'hi', senderId: 'user-1' }, 0);

    assert.equal(sent.length, 1, 'expected one fallback message when depth guard trips');
    assert.equal(sent[0].receiverId, 'user-1');
  });

  it('still allows explicit same-state self-loops when a transition matches', async () => {
    const noopEff = (async () => ({ ok: true } as any)) as any;
    let turns = 0;
    const selfLoopWf = (): Workflow => ({
      id: 'loop', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'looping' }] },
        looping: {
          kind: 'thinking',
          prompt: {},
          actions: {
            search: { prompt: { instruction: 'i' }, produces: 'tool-result' },
            done: { prompt: { instruction: 'i' }, produces: 'message-sent' },
          },
          transitions: [
            { to: 'looping', when: o => o.kind === 'tool-result' },
            { to: 'idle', when: o => o.kind === 'message-sent' },
          ],
        },
      },
    });
    const m = new AgentMachine({
      workflow: selfLoopWf(),
      executionCore: (async () => {
        turns++;
        return turns === 1
          ? {
              outcome: { kind: 'tool-result', tool: 'agent_network', result: {} },
              toolResults: [{ tool: 'agent_network', result: { operation: 'search' } }],
              llmCalls: 1,
              tokens: { total: 0, input: 0, output: 0 },
            }
          : {
              outcome: { kind: 'message-sent', text: 'done' },
              toolResults: [],
              llmCalls: 1,
              tokens: { total: 0, input: 0, output: 0 },
            };
      }) as any,
      eff: noopEff,
      toolManager: {} as any,
      promptBuilder: {} as any,
      input: {
        identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' },
        state: 'looping',
      },
    });

    await m._step({ kind: 'message-received', text: 'hi', senderId: 'user-1' }, 0);

    assert.equal(turns, 2);
    assert.equal(m.state, 'idle');
  });

  it('mode-all barrier: stays parked until every pending subtask reports', async () => {
    const noopEff = (async () => ({ ok: true } as any)) as any;
    const barrierWf = (): Workflow => ({
      id: 'barrier', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [] },
        awaitingAll: {
          kind: 'parked',
          transitions: [
            {
              to: 'reducing',
              when: (o, c) =>
                o.kind === 'subtask-finished' &&
                Object.keys(allPendingSubtasks(c)).length === 0,
            },
            { to: 'awaitingAll' },
          ],
        },
        reducing: { kind: 'parked', transitions: [] },
      },
    });
    const m = new AgentMachine({
      workflow: barrierWf(),
      executionCore: (async () => ({ outcome: { kind: 'wait' }, toolResults: [], llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } })) as any,
      eff: noopEff,
      toolManager: {} as any,
      promptBuilder: {} as any,
      input: {
        identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' },
        state: 'awaitingAll',
        ctx: {
          identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' },
          tasks: {
            parent: {
              agreementId: 'a1',
              pendingSubtasks: { t1: { agentId: 'x', spawnedAt: 1 }, t2: { agentId: 'y', spawnedAt: 1 } },
              collectedResults: [],
              delegatedAgreementIds: [],
            },
          },
          activeAgreementId: 'a1',
          activeTaskId: 'parent',
          pendingProposalAgreementId: null,
          // ZIG-1057: deprecated mirrors stay empty; barrier reads all*().
          pendingSubtasks: {},
          collectedResults: [],
          delegatedAgreementIds: [],
          toolResults: [], lastOutcome: { kind: 'enter' },
        } as any,
      },
    });

    await m.send({ event: { type: 'task_result', result: { taskId: 't1', state: 'completed', creatorIsYou: true, agreement: { agreementId: 'a1', parties: { creator: { actor: 'A' } } } } } });
    assert.equal(m.state, 'awaitingAll');
    assert.equal(allCollectedResults(m.ctx).length, 1);

    await m.send({ event: { type: 'task_result', result: { taskId: 't2', state: 'completed', creatorIsYou: true, agreement: { agreementId: 'a1', parties: { creator: { actor: 'A' } } } } } });
    assert.equal(m.state, 'reducing');
    assert.equal(Object.keys(allPendingSubtasks(m.ctx)).length, 0);
    assert.equal(allCollectedResults(m.ctx).length, 2);
  });

  it('state-timeout routes to a nudge state and re-parks (handled)', async () => {
    const noopEff = (async () => ({ ok: true } as any)) as any;
    const timedWf = (): Workflow => ({
      id: 'timed', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [] },
        waiting: {
          kind: 'parked', timeoutMs: 5000,
          transitions: [
            { to: 'nudging', when: o => o.kind === 'state-timeout' },
            { to: 'idle', when: o => o.kind === 'message-received' },
          ],
        },
        nudging: {
          kind: 'thinking', prompt: {}, allowNoWait: true,
          actions: { ping: { prompt: { instruction: 'i' }, produces: 'message-sent' } },
          transitions: [{ to: 'waiting', when: o => o.kind === 'message-sent' }],
        },
      },
    });
    const events: TransitionEvent[] = [];
    const m = new AgentMachine({
      workflow: timedWf(),
      executionCore: (async () => ({ outcome: { kind: 'message-sent', text: 'still there?' }, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } })) as any,
      eff: noopEff, toolManager: {} as any, promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, state: 'waiting' },
      transitionTap: (e) => events.push(e),
    });
    await m.send({ event: { type: 'state-timeout', state: 'waiting', waitedMs: 5000, epoch: 1 } as any });
    assert.equal(m.state, 'waiting');
    assert.equal(m.stateTimeoutUnhandled, false);
    const trans = events.filter(e => e.kind === 'transition') as Extract<TransitionEvent, { kind: 'transition' }>[];
    assert.ok(trans.some(t => t.fromState === 'waiting' && t.toState === 'nudging' && t.outcomeKind === 'state-timeout'));
  });

  it('unhandled state-timeout parks loudly and sets stateTimeoutUnhandled', async () => {
    const noopEff = (async () => ({ ok: true } as any)) as any;
    const wfNoHandler = (): Workflow => ({
      id: 'timed', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [] },
        waiting: { kind: 'parked', timeoutMs: 5000, transitions: [{ to: 'idle', when: o => o.kind === 'message-received' }] },
      },
    });
    const events: TransitionEvent[] = [];
    const m = new AgentMachine({
      workflow: wfNoHandler(),
      executionCore: (async () => ({ outcome: { kind: 'wait' }, toolResults: [], llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } })) as any,
      eff: noopEff, toolManager: {} as any, promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, state: 'waiting' },
      transitionTap: (e) => events.push(e),
    });
    await m.send({ event: { type: 'state-timeout', state: 'waiting', waitedMs: 5000, epoch: 1 } as any });
    assert.equal(m.state, 'waiting');
    assert.equal(m.stateTimeoutUnhandled, true);
    assert.ok(events.some(e => e.kind === 'timeout-unhandled'));
  });

  it('explicit self-loop on state-timeout is handled (heartbeat)', async () => {
    const noopEff = (async () => ({ ok: true } as any)) as any;
    const wfSelf = (): Workflow => ({
      id: 'timed', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [] },
        waiting: { kind: 'parked', timeoutMs: 5000, transitions: [{ to: 'waiting', when: o => o.kind === 'state-timeout' }] },
      },
    });
    const m = new AgentMachine({
      workflow: wfSelf(),
      executionCore: (async () => ({ outcome: { kind: 'wait' }, toolResults: [], llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } })) as any,
      eff: noopEff, toolManager: {} as any, promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, state: 'waiting' },
    });
    await m.send({ event: { type: 'state-timeout', state: 'waiting', waitedMs: 5000, epoch: 1 } as any });
    assert.equal(m.state, 'waiting');
    assert.equal(m.stateTimeoutUnhandled, false);
  });

  it('restores pre-migration ctx without the new subtask fields', () => {
    const noopEff = (async () => ({ ok: true } as any)) as any;
    const m = new AgentMachine({
      workflow: wf(),
      executionCore: (async () => ({ outcome: { kind: 'wait' }, toolResults: [], llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } })) as any,
      eff: noopEff,
      toolManager: {} as any,
      promptBuilder: {} as any,
      input: {
        identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' },
        ctx: {
          identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' },
          tasks: {},
          activeAgreementId: null, activeTaskId: null, pendingProposalAgreementId: null,
          toolResults: [], lastOutcome: { kind: 'enter' },
        } as any,
      },
    });
    assert.deepEqual(m.ctx.tasks, {});
    // ZIG-1128: the lane-level mirrors are gone from Ctx — `tasks` is the only
    // bookkeeping, read through the all*() helpers.
    assert.equal('pendingSubtasks' in m.ctx, false);
    assert.equal('collectedResults' in m.ctx, false);
  });
});

describe('AgentMachine transitionTap (ZIG-442)', () => {
  const noopEff = (async () => ({ ok: true } as never)) as never;

  it('emits transition event on state change', async () => {
    const events: TransitionEvent[] = [];
    const m = new AgentMachine({
      workflow: wf(),
      executionCore: (async () => ({ outcome: { kind: 'task-closed', status: 'completed' }, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } })) as never,
      eff: noopEff,
      toolManager: {} as never,
      promptBuilder: {} as never,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' } },
      transitionTap: (e) => events.push(e),
    });

    await m.send({ event: { type: 'task_result', result: { taskId: 't1', state: 'active', providerIsYou: true } } as never });

    const transitions = events.filter(e => e.kind === 'transition') as Extract<TransitionEvent, { kind: 'transition' }>[];
    assert.ok(transitions.length >= 1);
    assert.equal(transitions[0].fromState, 'idle');
    assert.equal(transitions[0].toState, 'busy');
  });

  it('emits no-match event when outcome has no matching transition', async () => {
    const events: TransitionEvent[] = [];
    const noMatchWf: Workflow = {
      id: 'x', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'thinking' }] },
        thinking: {
          kind: 'thinking', prompt: {},
          actions: { act: { prompt: { instruction: 'i' }, produces: 'unknown-outcome' } },
          transitions: [{ to: 'idle', when: o => o.kind === 'never-matches' }],
        },
      },
    };
    const m = new AgentMachine({
      workflow: noMatchWf,
      executionCore: (async () => ({ outcome: { kind: 'unknown-outcome' }, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } })) as never,
      eff: noopEff,
      toolManager: {} as never,
      promptBuilder: {} as never,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, state: 'thinking' },
      transitionTap: (e) => events.push(e),
    });

    await m._step({ kind: 'enter' }, 1);

    assert.ok(events.some(e => e.kind === 'no-match'));
    assert.ok(events.some(e => e.kind === 'unmatched-escape'));
    assert.equal(m.state, 'idle');
  });

  it('emits depth-guard event when depth >= 12', async () => {
    const events: TransitionEvent[] = [];
    // Self-loop transition: target === current state, so no-match guard skips,
    // and depth-guard fires next.
    const selfLoopWf: Workflow = {
      id: 'x', description: 'd', initial: 'looping',
      states: {
        looping: {
          kind: 'thinking', prompt: {},
          actions: { act: { prompt: { instruction: 'i' }, produces: 'loop' } },
          transitions: [{ to: 'looping', when: o => o.kind === 'loop' }],
        },
      },
    };
    const m = new AgentMachine({
      workflow: selfLoopWf,
      executionCore: (async () => ({ outcome: { kind: 'loop' }, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } })) as never,
      eff: noopEff,
      toolManager: {} as never,
      promptBuilder: {} as never,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, state: 'looping' },
      transitionTap: (e) => events.push(e),
    });

    await m._step({ kind: 'loop' }, 12);

    assert.ok(events.some(e => e.kind === 'depth-guard'));
  });
});

describe('AgentMachine — runaway turn budget (ZIG-768)', () => {
  // idle wakes into `working` on any message; `working` runs one turn then
  // parks back to idle. Driving non-user wakes accumulates turns without ever
  // building depth, exactly like the Jun 30 supervising ping-pong.
  const budgetWf = (): Workflow => ({
    id: 'budget', description: 'd', initial: 'idle',
    states: {
      idle: { kind: 'parked', transitions: [{ to: 'working', when: o => o.kind === 'message-received' }] },
      working: {
        kind: 'thinking', prompt: {},
        actions: { wait: { prompt: { instruction: 'i' }, produces: 'wait' } },
        transitions: [{ to: 'idle', when: o => o.kind === 'wait' }],
      },
    },
  });

  function makeBudgetMachine(cap: number, onTurn: () => void, events: TransitionEvent[], sent: { receiverId: string; text: string }[]) {
    const eff = (async (e: { kind: string; receiverId?: string; text?: string }) => {
      if (e.kind === 'send-message') sent.push({ receiverId: e.receiverId!, text: e.text! });
      return { ok: true };
    }) as never;
    return new AgentMachine({
      workflow: budgetWf(),
      executionCore: (async () => { onTurn(); return { outcome: { kind: 'wait' }, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } }; }) as never,
      eff,
      toolManager: {} as never,
      promptBuilder: {} as never,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' } },
      maxTurnsWithoutUserInput: cap,
      transitionTap: (e) => events.push(e),
    });
  }

  it('parks with a fallback after the budget is exhausted without user input', async () => {
    let turns = 0;
    const events: TransitionEvent[] = [];
    const sent: { receiverId: string; text: string }[] = [];
    const m = makeBudgetMachine(3, () => { turns++; }, events, sent);
    m._lastUserSenderId = 'user-1';

    // Non-user (agent→agent) wakes: 3 run, the 4th trips the guard.
    for (let i = 0; i < 4; i++) {
      await m._step({ kind: 'message-received', text: 'x', senderId: 'agent-x' }, 0);
    }

    assert.equal(turns, 3, 'ran exactly the budgeted number of turns');
    const guard = events.find(e => e.kind === 'turn-budget-guard');
    assert.ok(guard, 'expected a turn-budget-guard event');
    assert.equal((guard as { turns: number }).turns, 3);
    assert.ok(sent.some(s => s.receiverId === 'user-1'), 'sent a fallback to the waiting user');
  });

  it('resets the budget on human (USER) input', async () => {
    let turns = 0;
    const events: TransitionEvent[] = [];
    const sent: { receiverId: string; text: string }[] = [];
    const m = makeBudgetMachine(3, () => { turns++; }, events, sent);

    await m._step({ kind: 'message-received', text: 'x', senderId: 'agent-x' }, 0); // turn 1
    await m._step({ kind: 'message-received', text: 'x', senderId: 'agent-x' }, 0); // turn 2
    // Human message resets the budget (and itself runs a turn).
    await m.send({ event: { type: 'message', text: 'hi', senderId: 'user-1', senderType: 'user' } });
    await m._step({ kind: 'message-received', text: 'x', senderId: 'agent-x' }, 0); // post-reset turn
    await m._step({ kind: 'message-received', text: 'x', senderId: 'agent-x' }, 0); // post-reset turn

    assert.ok(!events.some(e => e.kind === 'turn-budget-guard'), 'must not trip after a user-input reset');
    assert.ok(turns >= 4, 'kept running turns after the reset');
  });

  it('mechanical state invokes tool with zero LLM calls (ZIG-764)', async () => {
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const workflow: Workflow = {
      id: 'mech',
      description: 'd',
      initial: 'idle',
      states: {
        idle: {
          kind: 'parked',
          transitions: [{ to: 'run', when: (o) => o.kind === 'task-assigned' }],
        },
        run: {
          kind: 'mechanical',
          tool: 'coordinator_execute',
          buildArgs: (ctx) => ({ taskId: ctx.activeTaskId }),
          produces: 'task-closed',
          transitions: [{ to: 'idle', when: (o) => o.kind === 'task-closed' }],
        },
      },
    };
    const eff = (async (effect: { kind: string; name?: string; args?: Record<string, unknown> }) => {
      if (effect.kind === 'tool-call') {
        toolCalls.push({ name: effect.name!, args: effect.args ?? {} });
        return { ok: true, result: { state: 'completed' } };
      }
      return { ok: true };
    }) as any;
    const m = new AgentMachine({
      workflow,
      executionCore: (async () => {
        throw new Error('LLM must not run for mechanical state');
      }) as any,
      eff,
      toolManager: { getTool: () => undefined } as any,
      promptBuilder: {} as any,
      input: { identity: { agentId: 'coord', sessionId: 'c', laneKey: 'coord:c' } },
    });
    await m.send({
      event: {
        type: 'task_result',
        result: { taskId: 'task_coord_1', state: 'active', providerIsYou: true },
      },
    });
    assert.equal(m.state, 'idle');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]!.name, 'coordinator_execute');
    assert.equal(toolCalls[0]!.args.taskId, 'task_coord_1');
    assert.equal(m.llmCalls, 0);
    assert.equal(m.ctx.lastOutcome.kind, 'task-closed');
  });

  /**
   * The runaway guards used to `return` while leaving `this.state` at the state
   * that ran away, so the lane sat inside a thinking state and every later event
   * was matched against transitions written for a different occasion. Three lab
   * workers lost their task wake exactly this way — wedged in the injected
   * greeting, which routes no `task-assigned`.
   */
  it('recovers to the initial state after tripping the runaway depth guard, and still takes the next event', async () => {
    // `looping` produces an outcome its own transitions do not route, so every
    // turn re-enters it — the shape the depth guard exists to stop.
    const loopWf: Workflow = {
      id: 'test', description: 'd', initial: 'idle',
      states: {
        idle: {
          kind: 'parked',
          transitions: [
            { to: 'looping', when: o => o.kind === 'message-received' },
            { to: 'busy', when: o => o.kind === 'task-assigned' },
          ],
        },
        looping: {
          kind: 'thinking',
          prompt: {},
          actions: { spin: { prompt: { instruction: 'i' }, produces: 'tool-result' } },
          // A SELF-LOOP on the turn outcome — the shape `claimKickingOff` has
          // (`chat_open` succeeds → tool-result → re-enter to greet). An
          // unmatched outcome would no-match-park at depth 1 instead and never
          // reach the guard, which is why this has to be a real self-loop.
          transitions: [
            { to: 'looping', when: o => o.kind === 'tool-result' },
            { to: 'idle', when: o => o.kind === 'message-sent' },
          ],
        },
        busy: {
          kind: 'thinking',
          prompt: {},
          actions: { finish: { prompt: { instruction: 'i' }, produces: 'task-closed' } },
          transitions: [{ to: 'idle', when: o => o.kind === 'task-closed' }],
        },
      },
    };
    const noopEff = (async () => ({ ok: true } as any)) as any;
    let turn: Outcome = { kind: 'tool-result', tool: 'spin', result: {} } as Outcome;
    const m = new AgentMachine({
      workflow: loopWf,
      executionCore: (async () => ({ outcome: turn, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } })) as any,
      eff: noopEff,
      toolManager: {} as any,
      promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' } },
    });

    await m.send({ event: { type: 'message', text: 'hi', senderId: 'U' } });

    // Wedged-in-place was the bug; landing back on the listening state is the fix.
    assert.equal(m.state, 'idle', 'should recover to initial, not stay in the runaway state');

    // And the whole point: the wake that arrives next is still handled.
    turn = { kind: 'task-closed', status: 'completed' } as Outcome;
    await m.send({ event: { type: 'task_result', result: { taskId: 't9', state: 'active', providerIsYou: true } } });
    assert.equal(m.state, 'idle');
  });

  /**
   * Same measured failure as the depth-guard recovery above, but at depth 1:
   * a thinking state with no self-loop yields an unmatched outcome, used to
   * log "parking" and stay IN that state. The next event (task-assigned) then
   * ran a turn against the greeting, which has no route for it.
   */
  it('recovers to initial on unmatched thinking outcome, so the next event is judged there (ZIG-1573)', async () => {
    const wedgedWf: Workflow = {
      id: 'test', description: 'd', initial: 'idle',
      states: {
        idle: {
          kind: 'parked',
          transitions: [
            { to: 'greeting', when: o => o.kind === 'message-received' },
            { to: 'busy', when: o => o.kind === 'task-assigned' },
          ],
        },
        greeting: {
          kind: 'thinking',
          prompt: {},
          actions: { greet: { prompt: { instruction: 'i' }, produces: 'tool-result' } },
          transitions: [
            { to: 'idle', when: o => o.kind === 'message-sent' },
          ],
        },
        busy: {
          kind: 'thinking',
          prompt: {},
          actions: { finish: { prompt: { instruction: 'i' }, produces: 'task-closed' } },
          transitions: [{ to: 'idle', when: o => o.kind === 'task-closed' }],
        },
      },
    };
    const noopEff = (async () => ({ ok: true } as any)) as any;
    const statesTurned: string[] = [];
    let turn: Outcome = { kind: 'tool-result', tool: 'greet', result: {} } as Outcome;
    const m = new AgentMachine({
      workflow: wedgedWf,
      executionCore: (async (args: { stateId: string }) => {
        statesTurned.push(args.stateId);
        return { outcome: turn, toolResults: [], llmCalls: 1, tokens: { total: 0, input: 0, output: 0 } };
      }) as any,
      eff: noopEff,
      toolManager: {} as any,
      promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' } },
    });

    await m.send({ event: { type: 'message', text: 'hi', senderId: 'U' } });
    assert.equal(m.state, 'idle', 'unmatched tool-result must leave the greeting, not park inside it');
    assert.deepEqual(statesTurned, ['greeting']);

    turn = { kind: 'task-closed', status: 'completed' } as Outcome;
    await m.send({ event: { type: 'task_result', result: { taskId: 't9', state: 'active', providerIsYou: true } } });
    assert.equal(m.state, 'idle');
    assert.deepEqual(statesTurned, ['greeting', 'busy'], 'task wake must run busy, not a second greeting turn');
  });

  it('recovers to initial when a thinking turn throws and no error transition matches (ZIG-1573)', async () => {
    const wfThrow: Workflow = {
      id: 'test', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'stuck', when: o => o.kind === 'message-received' }] },
        stuck: {
          kind: 'thinking',
          prompt: {},
          actions: { spin: { prompt: { instruction: 'i' }, produces: 'wait' } },
          transitions: [],
        },
      },
    };
    const noopEff = (async () => ({ ok: true } as any)) as any;
    const m = new AgentMachine({
      workflow: wfThrow,
      executionCore: (async () => {
        throw new Error('turn exploded');
      }) as any,
      eff: noopEff,
      toolManager: {} as any,
      promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, state: 'stuck' },
    });

    await m._step({ kind: 'message-received', text: 'hi', senderId: 'U' }, 0);
    assert.equal(m.state, 'idle');
  });

  // ZIG-2058 — the tool-state copy of the error block never parked, so a tool
  // state that threw with no error route stayed put.
  it('recovers to initial when a tool state throws and no error transition matches', async () => {
    const wfThrow: Workflow = {
      id: 'test', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'run', when: o => o.kind === 'message-received' }] },
        run: {
          kind: 'mechanical',
          tool: 'coordinator_execute',
          buildArgs: () => {
            throw new Error('args exploded');
          },
          produces: 'task-closed',
          transitions: [],
        },
      },
    };
    const m = new AgentMachine({
      workflow: wfThrow,
      executionCore: (async () => {
        throw new Error('LLM must not run for mechanical state');
      }) as any,
      eff: (async () => ({ ok: true })) as any,
      toolManager: { getTool: () => undefined } as any,
      promptBuilder: {} as any,
      input: { identity: { agentId: 'A', sessionId: 'c', laneKey: 'A:c' }, state: 'run' },
    });

    await m._step({ kind: 'message-received', text: 'hi', senderId: 'U' }, 0);
    assert.equal(m.state, 'idle');
  });
});
