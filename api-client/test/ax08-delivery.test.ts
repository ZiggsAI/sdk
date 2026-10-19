import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentTaskOutcome } from '../src/capabilities/index.js';
import { shapeAgreement } from '../src/http/AgreementClient.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';
import type { TaskWriteConfirm } from '../src/http/TaskClient.js';
import type { Agreement } from '../src/types.js';

/**
 * ZIG-1879 / AX-08 acceptance: a finished task says what it did and nothing
 * more. Completion, delivery, metering and the end of an engagement are four
 * facts, and `{ state: 'completed' }` was being read as all four at once.
 */

const SURFACES = ['mcp', 'sdk'] as const;

function env(surface: 'mcp' | 'sdk'): CapabilityEnv {
  return {
    creds: { operatorKey: 'op_test', agentId: 'agent_me' },
    surface,
    webUrl: 'http://localhost:1234',
  };
}

function confirm(effects: Record<string, unknown>): TaskWriteConfirm {
  return {
    ok: true,
    taskId: 'tsk_1',
    state: 'completed',
    agreementId: 'agr_1',
    resultRecorded: true,
    effects,
  } as unknown as TaskWriteConfirm;
}

const STANDING_HIRE = {
  resultRecorded: true,
  notified: ['user-buyer'],
  settlement: { metered: true, settled: true, amount: 500, transactionId: 'tx_1' },
  agreement: {
    agreementId: 'agr_1',
    billing: 'per_task',
    status: 'active',
    fulfilledNow: false,
  },
};

test('E14: the result is discoverable, the human is told, and the hire stands', () => {
  for (const surface of SURFACES) {
    const out = presentTaskOutcome(confirm(STANDING_HIRE), env(surface));
    // Discoverable by the next agent: the result lives on the task.
    assert.match(out.recorded, /result is stored on the task/, surface);
    // Delivered to the person in the conversation the work rides on.
    assert.match(out.delivery ?? '', /in the conversation the work rides on/, surface);
    // A standing hire is not ended by the task that finished under it.
    assert.match(out.agreement ?? '', /does not end a hire/, surface);
    assert.doesNotMatch(out.agreement ?? '', /fulfilled/, surface);
    // And the lookup route is a call the surface actually has.
    assert.equal(out.next[0].ready, true, surface);
    assert.equal(
      out.next[0].tool,
      surface === 'mcp' ? 'ziggs_task_get' : 'task_list',
      surface,
    );
  }
});

test('E15: a replayed completion claims no second result, wake, charge or closure', () => {
  for (const surface of SURFACES) {
    const out = presentTaskOutcome(
      confirm({ resultRecorded: true, replayed: true, notified: [] }),
      env(surface),
    );
    assert.match(out.recorded, /nothing was recorded, queued, metered or fulfilled a second time/, surface);
  }
});

test('E16: a queued wake is never reported as a delivery anyone received', () => {
  for (const surface of SURFACES) {
    const out = presentTaskOutcome(confirm(STANDING_HIRE), env(surface));
    assert.match(out.handoff ?? '', /Queued is not read/, surface);
    // The recovery route for a completion whose reply never arrived is a read.
    assert.match(out.next[0].why, /never completes the task twice/, surface);
    assert.equal(out.next[0].outcome, 'ok', surface);
  }
});

test('E16: a completion whose settlement failed is not reported as paid', () => {
  const out = presentTaskOutcome(
    confirm({
      ...STANDING_HIRE,
      settlement: { metered: true, settled: false, reason: 'transfer_failed' },
    }),
    env('mcp'),
  );
  assert.match(out.metering ?? '', /No payment moved/);
  assert.match(out.metering ?? '', /left for reconciliation/);
  assert.match(out.metering ?? '', /Do not report this task as paid/);
  // The work itself is still delivered — a money problem is not a lost result.
  assert.match(out.recorded, /result is stored on the task/);
});

test('a per-task price meters one execution; a total price meters none', () => {
  const perTask = presentTaskOutcome(confirm(STANDING_HIRE), env('mcp'));
  assert.match(perTask.metering ?? '', /Metered per completed task/);
  assert.match(perTask.metering ?? '', /One execution, once/);
  assert.match(perTask.agreement ?? '', /charging per completed task/);

  const total = presentTaskOutcome(
    confirm({
      resultRecorded: true,
      notified: ['user-buyer'],
      settlement: { metered: false, settled: false, reason: 'not_metered' },
      agreement: {
        agreementId: 'agr_1',
        billing: 'total',
        status: 'active',
        fulfilledNow: false,
      },
    }),
    env('mcp'),
  );
  assert.match(total.metering ?? '', /No payment moved/);
  assert.match(total.metering ?? '', /does not bill per completed task/);
  assert.match(total.agreement ?? '', /one total for the engagement/);
  assert.doesNotMatch(total.metering ?? '', /settled/);
});

test('fulfillment stays a separate, visible consequence of its own', () => {
  const out = presentTaskOutcome(
    confirm({
      ...STANDING_HIRE,
      agreement: {
        agreementId: 'agr_1',
        billing: 'per_task',
        status: 'fulfilled',
        fulfilledNow: true,
      },
    }),
    env('mcp'),
  );
  assert.match(out.agreement ?? '', /reached its execution quota/);
  assert.match(out.agreement ?? '', /the engagement is over/);
  assert.match(out.agreement ?? '', /grants went with it/);
});

test('a server that reports no effects has nothing narrated for it', () => {
  const bare = presentTaskOutcome(
    { ok: true, taskId: 'tsk_1', state: 'completed' } as TaskWriteConfirm,
    env('mcp'),
  );
  assert.equal(bare.metering, undefined);
  assert.equal(bare.agreement, undefined);
  assert.equal(bare.handoff, undefined);
  assert.match(bare.recorded, /no result payload stored/);
});

test('the agreement an agent reads says whether its price is a rate or a total', () => {
  const perTask = shapeAgreement({
    agreementId: 'agr_1',
    money: { price: 500 },
    terms: { billing: 'per_task', maxExecutions: 10 },
  } as unknown as Agreement);
  assert.equal(perTask.billing, 'per_task');
  assert.equal(perTask.maxExecutions, 10);

  // Rows written before the field existed read as a total, and say nothing.
  const legacy = shapeAgreement({
    agreementId: 'agr_2',
    money: { price: 500 },
    terms: {},
  } as unknown as Agreement);
  assert.equal(legacy.billing, undefined);
});
