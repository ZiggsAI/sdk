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
};

const parkedTick = (): TickOutput => ({
  ctx: {},
  state: 'idle',
  parked: true,
  stateTimeoutUnhandled: false,
  metrics: { llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } },
});

function makeHost(agreement: Record<string, unknown>) {
  const host = new Agent({
    agentId: 'lead',
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
  internals.agreementService = { get: async () => agreement };
  internals.sessions.set('lead:agrn-agr_1', {
    sessionId: 'agrn-agr_1',
    ownAgentId: 'lead',
    state: 'idle',
  });
  return { internals, ticks: () => ticks };
}

const frame = (reason: string) => ({
  type: 'resource_changed',
  resource: { kind: 'agreement', resourceId: 'agr_1', agreementId: 'agr_1', reason },
  agreementId: 'agr_1',
});

describe('Agent host and the outcome of its own proposal', () => {
  it('wakes on a declined proposal although the decline cancelled the agreement', async () => {
    const { internals, ticks } = makeHost({ status: 'cancelled' });
    await internals._processEvent(frame('proposal_rejected'), 'lead:agrn-agr_1');
    assert.equal(ticks(), 1);
  });

  it('wakes on an approved proposal', async () => {
    const { internals, ticks } = makeHost({ status: 'active', formedBy: 'agent' });
    await internals._processEvent(frame('proposal_approved'), 'lead:agrn-agr_1');
    assert.equal(ticks(), 1);
  });

  it('still drops other frames on a cancelled agreement', async () => {
    const { internals, ticks } = makeHost({ status: 'cancelled' });
    await internals._processEvent(frame('status:cancelled'), 'lead:agrn-agr_1');
    assert.equal(ticks(), 0);
  });
});
