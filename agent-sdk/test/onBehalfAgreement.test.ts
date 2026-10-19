import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mayBindOnBehalf,
  resolveOnBehalfAgreementId,
  type OnBehalfAgreementRow,
} from '../src/brain/onBehalfAgreement.js';

const hire: OnBehalfAgreementRow = {
  agreementId: 'agr_hire',
  status: 'active',
  parties: {
    provider: { actor: 'agent-coord' },
    payer: { actor: 'user-dana', principal: 'user-dana' },
  },
};

const sub: OnBehalfAgreementRow = {
  agreementId: 'agr_sub',
  status: 'active',
  parties: {
    provider: { actor: 'agent-worker' },
    payer: { actor: 'agent-coord', principal: 'org-coord' },
  },
};

test('mayBindOnBehalf: provider hire yes, payer-only sub no', () => {
  assert.equal(mayBindOnBehalf('agr_hire', 'agent-coord', [hire, sub]), true);
  assert.equal(mayBindOnBehalf('agr_sub', 'agent-coord', [hire, sub]), false);
});

test('worker-result naming the sub falls through to the provider hire', () => {
  const id = resolveOnBehalfAgreementId(
    { result: { agreementId: 'agr_sub' } },
    [hire, sub],
    'agent-coord',
    'agrn-agr_sub',
  );
  assert.equal(id, 'agr_hire');
});

test('provider-side result still binds to that hire', () => {
  const id = resolveOnBehalfAgreementId(
    { result: { agreementId: 'agr_hire' } },
    [hire, sub],
    'agent-coord',
    'chat-hire',
  );
  assert.equal(id, 'agr_hire');
});

test('unknown agreement id in context is kept (no invented parent)', () => {
  const id = resolveOnBehalfAgreementId(
    { result: { agreementId: 'agr_mystery' } },
    [hire],
    'agent-coord',
    null,
  );
  assert.equal(id, 'agr_mystery');
});

test('lifecycle top-level agreementId still works when agent provides', () => {
  const id = resolveOnBehalfAgreementId(
    { agreementId: 'agr_hire' },
    [hire],
    'agent-coord',
    null,
  );
  assert.equal(id, 'agr_hire');
});
