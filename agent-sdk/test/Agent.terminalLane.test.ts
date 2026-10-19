/**
 * ZIG-1144 part 3 — a lane named `agrn-<agreementId>` keeps its Claude session for
 * the whole engagement, so a trailing event after the deal ends pays for all of it.
 * Measured on prod: a cancelled hand-off woke its lane for 92k tokens on
 * 2026-08-03, and 147k on 08-04 with the session reaching 399,864 input tokens
 * before it reset. Nothing was produced either time.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';

type HostInternals = {
  laneAgreementIsTerminal(sessionId: string): Promise<boolean>;
  agreementService: { get(id: string): Promise<unknown> };
};

const makeHost = () =>
  new Agent({
    agentId: 'agent-me',
    operatorKey: 'op-key',
    anthropicKey: 'test-key',
    initial: 'idle',
    states: { idle: { kind: 'parked' as const, transitions: [] } },
    inboxCatchUp: false,
  });

const withAgreement = (host: Agent, agreement: unknown, calls: string[] = []) => {
  const internals = host as unknown as HostInternals;
  internals.agreementService = {
    get: async (id: string) => {
      calls.push(id);
      return agreement;
    },
  };
  return internals;
};

describe('Agent lane suppression for terminal agreements', () => {
  for (const status of ['cancelled', 'refunded', 'fulfilled']) {
    it(`suppresses a lane whose agreement is ${status}`, async () => {
      const calls: string[] = [];
      const internals = withAgreement(makeHost(), { status }, calls);
      assert.equal(await internals.laneAgreementIsTerminal('agrn-agr_1'), true);
      assert.deepEqual(calls, ['agr_1']);
    });
  }

  it('runs the turn while the agreement is still live', async () => {
    const internals = withAgreement(makeHost(), { status: 'active' });
    assert.equal(await internals.laneAgreementIsTerminal('agrn-agr_1'), false);
  });

  it('never touches a chat lane — only the agreement-scoped routing key is checked', async () => {
    const calls: string[] = [];
    const internals = withAgreement(makeHost(), { status: 'cancelled' }, calls);
    assert.equal(await internals.laneAgreementIsTerminal('uxvnowcpn'), false);
    assert.deepEqual(calls, []);
  });

  it('fails open: a lookup error runs the turn rather than dropping work', async () => {
    const internals = makeHost() as unknown as HostInternals;
    internals.agreementService = {
      get: async () => {
        throw new Error('inbox 429');
      },
    };
    assert.equal(await internals.laneAgreementIsTerminal('agrn-agr_1'), false);
  });

  it('ignores a lane prefix with no agreement id behind it', async () => {
    const calls: string[] = [];
    const internals = withAgreement(makeHost(), { status: 'cancelled' }, calls);
    assert.equal(await internals.laneAgreementIsTerminal('agrn-'), false);
    assert.deepEqual(calls, []);
  });
});

/**
 * ZIG-1153 — the trailing turn on work already reported. On prod the frame that
 * followed a completed elicitation cost 158,733 tokens (session input 366,417
 * before ZIG-816 reset it) and produced nothing: the spec was written and the task
 * closed one frame earlier. This is not the terminal-agreement case above — it
 * fires while the engagement is still live, which is where the cost was.
 */
describe('Agent drops the echo of a task that already reported', () => {
  type Echo = { isSettledTaskEcho(event: unknown): boolean };
  const host = () => makeHost() as unknown as Echo;

  for (const state of ['completed', 'cancelled', 'failed']) {
    it(`drops a ${state} task frame that carries a result`, () => {
      assert.equal(
        host().isSettledTaskEcho({
          type: 'task_result',
          result: { taskId: 't1', state, result: '{"summary":"done"}' },
        }),
        true,
      );
    });
  }

  it('keeps a terminal task frame with no result — the agent still has something to say', () => {
    assert.equal(
      host().isSettledTaskEcho({
        type: 'task_result',
        result: { taskId: 't1', state: 'completed', result: null },
      }),
      false,
    );
  });

  it('keeps an active task frame — that is the work itself', () => {
    assert.equal(
      host().isSettledTaskEcho({
        type: 'task_result',
        result: { taskId: 't1', state: 'active', result: null },
      }),
      false,
    );
  });

  it('ignores frames that are not task frames', () => {
    assert.equal(host().isSettledTaskEcho({ type: 'message', text: 'hi' }), false);
    assert.equal(host().isSettledTaskEcho(null), false);
  });
});
