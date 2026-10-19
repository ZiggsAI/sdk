import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import type { TickOutput } from '../src/brain/ZiggsBrain.js';
import type { Ctx } from '../src/types.js';

type HostInternals = {
  sessions: Map<
    string,
    { sessionId: string; ownAgentId: string; ctx?: Ctx; state?: string }
  >;
  _processEvent: (event: unknown, laneKey: string) => Promise<void>;
  agreementService: { get(id: string): Promise<unknown> };
  taskService: { getTask(id: string): Promise<unknown> };
};

const parkedTick = (): TickOutput => ({
  ctx: {},
  state: 'idle',
  parked: true,
  stateTimeoutUnhandled: false,
  metrics: { llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } },
});

function makeHost() {
  const host = new Agent({
    agentId: 'invoice-engineering',
    operatorKey: 'op-key',
    anthropicKey: 'test-key',
    initial: 'idle',
    states: { idle: { kind: 'parked' as const, transitions: [] } },
    inboxCatchUp: false,
  });
  let ticks = 0;
  host.brain = {
    kind: 'ziggs',
    workflow: {
      id: 't',
      description: 't',
      initial: 'idle',
      states: { idle: { kind: 'parked' as const, transitions: [] } },
    },
    async tick() {
      ticks += 1;
      return parkedTick();
    },
  } as Agent['brain'];
  const internals = host as unknown as HostInternals;
  internals.taskService = { getTask: async taskId => ({ taskId, state: 'active', assigneeId: 'invoice-engineering' }) };
  internals.sessions.set('invoice-engineering:chat-1', {
    sessionId: 'chat-1',
    ownAgentId: 'invoice-engineering',
    state: 'idle',
  });
  return { internals, ticks: () => ticks };
}

describe('Agent host skip for agent-formed hire activation', () => {
  it('does not tick the brain when the agreement row says formedBy agent', async () => {
    const { internals, ticks } = makeHost();
    const fetched: string[] = [];
    internals.agreementService = {
      get: async (id) => {
        fetched.push(id);
        return { formedBy: 'agent', status: 'active' };
      },
    };
    await internals._processEvent(
      {
        type: 'agreement_lifecycle',
        operation: 'proposal_approved_execute',
        agreementId: 'agr_1',
      },
      'invoice-engineering:chat-1',
    );
    assert.deepEqual(fetched, ['agr_1']);
    assert.equal(ticks(), 0);
  });

  it('waits for a task when a person accepts task-only terms', async () => {
    const { internals, ticks } = makeHost();
    internals.agreementService = { get: async () => ({ formedBy: 'principal', status: 'active', terms: { interactionMode: 'tasks' } }) };
    await internals._processEvent({ type: 'agreement_lifecycle', operation: 'proposal_approved_execute', agreementId: 'agr_1' }, 'invoice-engineering:chat-1');
    assert.equal(ticks(), 0);
    await internals._processEvent({ type: 'task_result', result: { taskId: 't1', agreementId: 'agr_1', state: 'active' } }, 'invoice-engineering:chat-1');
    assert.equal(ticks(), 1);
  });

  it('ticks the brain when the agreement row says formedBy principal', async () => {
    const { internals, ticks } = makeHost();
    internals.agreementService = {
      get: async () => ({ formedBy: 'principal', status: 'active' }),
    };
    await internals._processEvent(
      {
        type: 'resource_changed',
        resource: { kind: 'agreement', reason: 'proposal_approved', agreementId: 'agr_1' },
        agreementId: 'agr_1',
      },
      'invoice-engineering:chat-1',
    );
    assert.equal(ticks(), 1);
  });

  it('fails open — a missing formedBy still ticks rather than dropping a store claim', async () => {
    const { internals, ticks } = makeHost();
    internals.agreementService = {
      get: async () => {
        throw new Error('inbox 429');
      },
    };
    await internals._processEvent(
      {
        type: 'resource_changed',
        resource: { kind: 'agreement', reason: 'proposal_approved', agreementId: 'agr_1' },
        agreementId: 'agr_1',
      },
      'invoice-engineering:chat-1',
    );
    assert.equal(ticks(), 1);
  });

  it('an assigned task still ticks after an activation skip', async () => {
    const { internals, ticks } = makeHost();
    internals.agreementService = {
      get: async () => ({ formedBy: 'agent', status: 'active' }),
    };
    await internals._processEvent(
      {
        type: 'agreement_lifecycle',
        operation: 'proposal_approved_execute',
        agreementId: 'agr_1',
      },
      'invoice-engineering:chat-1',
    );
    await internals._processEvent(
      {
        type: 'task_result',
        result: { taskId: 't1', state: 'active' },
      },
      'invoice-engineering:chat-1',
    );
    assert.equal(ticks(), 1);
  });
});
