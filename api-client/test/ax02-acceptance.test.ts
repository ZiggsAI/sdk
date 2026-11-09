import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agreementClaimCapability,
  nextCall,
  presentClaimResult,
  redeemIntroductionCapability,
} from '../src/capabilities/index.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';
import type { Agreement } from '../src/types.js';
import type { ClaimedKind } from '../src/http/AgreementClient.js';

/**
 * ZIG-1873 / AX-02 remaining acceptance: same authorized fixture, same
 * outcome on assistant|worker × HTTP|MCP. Profile is not a field. Pending
 * share/hire cannot read as completed.
 */

const EXPERIENCES = ['assistant', 'worker'] as const;
const SURFACES = ['mcp', 'sdk'] as const;

function env(
  surface: 'mcp' | 'sdk',
  extra: { laneId?: string } = {},
): CapabilityEnv {
  return {
    creds: {
      operatorKey: 'op_test',
      agentId: 'agent_me',
      ...(extra.laneId ? { laneId: extra.laneId } : {}),
    },
    surface,
    webUrl: 'http://localhost:1234',
  };
}

function stubFetch(
  t: { after: (fn: () => void) => void },
  body: unknown,
  ok = true,
  status = 200,
) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
    json: async () => body,
  })) as unknown as typeof globalThis.fetch;
}

test('ZIG-1873: equivalent fixtures match across assistant/worker × MCP/HTTP', () => {
  const domain = { command: { operationId: 'send', content: { text: 'Hello' }, audience: { kind: 'explicit', principalIds: ['user_peer'] }, deliveries: { kind: 'explicit', principalIds: ['user_peer'] }, intent: 'fyi' } };
  const http = { method: 'POST', path: '/messaging/messages' };
  for (const experience of EXPERIENCES) {
    for (const surface of SURFACES) {
      // Experience is a product fact, not an env field and not a nextCall field.
      const call = nextCall(env(surface), 'message_send', domain, 'open a room');
      assert.equal(call.ready, true, `${experience}/${surface} ready`);
      assert.equal(call.outcome, 'ok', `${experience}/${surface} outcome`);
      assert.deepEqual(call.http, http, `${experience}/${surface} http`);
      assert.deepEqual(call.args, domain);
      assert.equal('profile' in call, false);
      assert.equal('experience' in call, false);
      assert.equal(
        call.tool,
        surface === 'mcp' ? 'ziggs_message_send' : 'message_send',
      );
    }
  }
});

test('ZIG-1873: pending hire is not a claimed completion on any surface', () => {
  const agreement = {
    agreementId: 'agr_parked',
    status: 'open',
    engagementKind: 'service',
  } as Agreement;
  for (const experience of EXPERIENCES) {
    for (const surface of SURFACES) {
      const out = presentClaimResult(agreement, 'request' as ClaimedKind, env(surface));
      assert.equal(out.status, 'pending_approval', `${experience}/${surface}`);
      assert.equal(out.outcome, 'pending', `${experience}/${surface}`);
      assert.match(out.message, /Hire requested/);
      assert.match(out.message, /Waiting for your yes/);
      assert.equal(out.kind, 'request');
      assert.doesNotMatch(out.message, /set the task result/);
      assert.deepEqual(out.workContext, { actingAgentId: 'agent_me' });
    }
  }
});

test('ZIG-1873: an activated claim stays a completion receipt', () => {
  const out = presentClaimResult(
    { agreementId: 'agr_live', status: 'active', engagementKind: 'service' } as Agreement,
    'request' as ClaimedKind,
    env('mcp'),
  );
  assert.equal(out.status, 'claimed');
  assert.equal(out.outcome, 'ok');
});

test('ZIG-1873: staged introduction redeem does not advertise a ready door', async (t) => {
  stubFetch(t, {
    token: 'zint_1',
    status: 'redeemed',
    outcome: 'link_pending',
    from: { orgId: 'org_them', agentId: 'agt_them', claimedLabel: { text: 'x', selfChosen: true, verified: false } },
    venue: null,
    venueRef: null,
    note: null,
    agreementId: 'agr_link',
    redeemedBy: null,
    expiresAt: '2099-01-01T00:00:00.000Z',
    url: 'https://example.test/i/zint_1',
  });

  const out = (await redeemIntroductionCapability.handler(
    { token: 'zint_1' },
    env('mcp'),
  )) as {
    outcome: string;
    readPlan: Array<{ tool: string; ready: boolean; outcome: string; hold?: string }>;
  };

  assert.equal(out.outcome, 'pending');
  assert.equal(out.readPlan.some((c) => c.tool === 'ziggs_message_send'), false);
  const respond = out.readPlan.find((c) => c.tool === 'ziggs_agreement_respond');
  assert.ok(respond);
  assert.equal(respond!.ready, false);
  assert.equal(respond!.outcome, 'pending');
  assert.equal(respond!.hold, 'human_approval');
});

test('ZIG-1873: already-linked redeem is a live door, not a park', async (t) => {
  stubFetch(t, {
    token: 'zint_2',
    status: 'redeemed',
    outcome: 'joined',
    from: { orgId: 'org_them', agentId: 'agt_them', claimedLabel: { text: 'x', selfChosen: true, verified: false } },
    venue: null,
    venueRef: null,
    note: null,
    agreementId: null,
    redeemedBy: null,
    expiresAt: '2099-01-01T00:00:00.000Z',
    url: 'https://example.test/i/zint_2',
    counterparty: {
      principal: 'user_them',
      agentId: 'agt_them',
      claimedLabel: { text: 'x', selfChosen: true, verified: false },
      nextStep: 'talk',
    },
  });

  const out = (await redeemIntroductionCapability.handler(
    { token: 'zint_2' },
    env('sdk'),
  )) as {
    outcome: string;
    readPlan: Array<{ tool: string; ready: boolean; outcome: string }>;
  };

  assert.equal(out.outcome, 'ok');
  assert.equal(out.readPlan[0]?.tool, 'message_send');
  assert.equal(out.readPlan[0]?.ready, false);
  assert.equal(out.readPlan[0]?.outcome, 'unavailable');
});

test('ZIG-1873: claim effects are named and a suggestion does not confer authority', () => {
  const call = nextCall(
    env('mcp'),
    'agreement_claim',
    { agreementId: 'agr_1' },
    'claim this listing',
  );
  assert.ok(call.effects?.commitment);
  assert.ok(call.effects?.relationship);
  assert.equal(call.ready, true);
  // The call is a suggestion: executing it is still the claim verb, which
  // revalidates on the server (see the 400 case in agreementClaimMessage).
  // A claim activates the agreement and reserves points: a commitment that
  // cannot be taken back, so the directories' rule makes it destructive.
  assert.equal(agreementClaimCapability.annotation, 'destructive');
});
