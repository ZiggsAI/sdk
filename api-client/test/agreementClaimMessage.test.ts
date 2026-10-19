import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agreementClaimCapability } from '../src/capabilities/agreements.js';

/**
 * A claim only activates when the claimer could consent for its own side. The
 * answer used to tell every claimer to start working regardless, which is
 * impossible while the formation is still parked on a human — so the message
 * has to follow the row, not the verb.
 */
function stubClaim(
  t: { after: (fn: () => void) => void },
  agreement: Record<string, unknown>,
) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (url: unknown) => {
    const body = /\/claim/.test(String(url))
      ? { agreement }
      : { agreement, kind: 'request' };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }) as unknown as typeof globalThis.fetch;
}

const ENV = {
  creds: { operatorKey: 'op_test', agentId: 'agent_7' },
  webUrl: 'http://localhost:1234',
} as unknown as Parameters<typeof agreementClaimCapability.handler>[1];

test('a claim that has not activated says it is waiting on a person', async (t) => {
  stubClaim(t, {
    agreementId: 'agr_1',
    status: 'open',
    engagementKind: 'service',
  });

  const out = (await agreementClaimCapability.handler(
    { agreementId: 'agr_1' },
    ENV,
  )) as { status: string; outcome?: string; message: string };

  assert.equal(out.status, 'pending_approval');
  assert.equal(out.outcome, 'pending');
  assert.equal((out as { kind?: string }).kind, 'request');
  assert.match(out.message, /Hire requested/);
  assert.match(out.message, /Waiting for your yes/);
  assert.doesNotMatch(out.message, /formation|mandateAgreementId/);
  // ZIG-1585 — the park carries the link where the human answers.
  assert.match(
    out.message,
    /http:\/\/localhost:1234\/app\/agreements\/agr_1/,
  );
  // The instruction that was impossible at this point must not be here.
  assert.doesNotMatch(out.message, /set the task result/);
});

test('a contact-basis park says it is a one-time stranger ask, with the link', async (t) => {
  stubClaim(t, {
    agreementId: 'agr_3',
    status: 'open',
    engagementKind: 'service',
    approvals: [
      { partyId: 'agent_7', status: 'pending', heldReason: 'contact-basis' },
    ],
  });

  const out = (await agreementClaimCapability.handler(
    { agreementId: 'agr_3' },
    ENV,
  )) as { status: string; message: string };

  assert.match(out.message, /first engagement with that counterparty/);
  assert.match(out.message, /standing link/);
  assert.match(
    out.message,
    /http:\/\/localhost:1234\/app\/agreements\/agr_3/,
  );
  // The mandate remedy is the wrong sentence for a contact ask.
  assert.doesNotMatch(out.message, /mandateAgreementId/);
});

test('a claim that did activate keeps the get-to-work instruction', async (t) => {
  stubClaim(t, {
    agreementId: 'agr_2',
    status: 'active',
    engagementKind: 'service',
  });

  const out = (await agreementClaimCapability.handler(
    { agreementId: 'agr_2' },
    ENV,
  )) as { status: string; outcome?: string; message: string };

  assert.equal(out.status, 'claimed');
  assert.equal(out.outcome, 'ok');
  assert.match(out.message, /The hire is active/);
  assert.match(out.message, /You do the work/);
  assert.doesNotMatch(out.message, /Hire requested/);
});

test('ZIG-1873: a refused claim is not a completion receipt', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () => JSON.stringify({ message: 'Offer already claimed or not open' }),
    json: async () => ({ message: 'Offer already claimed or not open' }),
  })) as unknown as typeof globalThis.fetch;

  await assert.rejects(
    () => agreementClaimCapability.handler({ agreementId: 'agr_stale' }, ENV),
    /already claimed|not open|400/i,
  );
});
