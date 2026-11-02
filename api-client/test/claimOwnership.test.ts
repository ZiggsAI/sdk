import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { agreementClaimCapability } from '../src/capabilities/agreements.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';

const ENV: CapabilityEnv = {
  creds: { operatorKey: 'op', agentId: 'agent-a' },
  surface: 'mcp',
};

function respondWith(body: Record<string, unknown>) {
  const calls: Array<{ body: unknown }> = [];
  mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

const hire = (status: string) => ({
  agreementId: 'agr_hire',
  status,
  engagementKind: 'hire',
  approvals: status === 'open' ? [{ partyId: 'itay', role: 'payer', status: 'pending' }] : [],
});

const claim = (args: Record<string, unknown>) =>
  agreementClaimCapability.handler({ agreementId: 'agr_listing', ...args }, ENV) as Promise<{
    status: string;
    message: string;
    room?: { addressId: string; status: string };
  }>;

describe('agreement_claim owns consent without room admission', () => {
  afterEach(() => mock.restoreAll());
  for (const surface of ['sdk', 'mcp'] as const) {
    it(`${surface} returns active work without an admission step`, async () => {
      const calls = respondWith({ok: true, kind: 'hand-off', agreement: hire('active')});
      const result = await agreementClaimCapability.handler({agreementId: 'agr_listing', mandateAgreementId: 'selected-work'}, {...ENV, surface}) as {status: string; message: string; room?: unknown};
      assert.deepEqual(calls[0].body, {mandateAgreementId: 'selected-work'});
      assert.equal(result.status, 'claimed');
      assert.equal(result.room, undefined);
      assert.match(result.message, /hire is active/);
      assert.doesNotMatch(result.message, /room|admission/);
    });
  }
  it('retains pending consent without promising room membership', async () => {
    respondWith({ok: true, kind: 'hand-off', agreement: hire('open')});
    const result = await claim({});
    assert.equal(result.status, 'pending_approval');
    assert.match(result.message, /Waiting for your yes/);
    assert.doesNotMatch(result.message, /joins|room|admission/);
  });
  it('does not expose a claim sharing parameter', () => {
    assert.equal(agreementClaimCapability.params.addressId, undefined);
  });
});
