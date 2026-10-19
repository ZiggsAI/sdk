import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimAgreement,
  counterAgreement,
  fulfillAgreement,
  getAgreement,
  linkSummary,
  listAgreements,
  proposeAgreement,
  revokeAgreement,
} from '../src/http/AgreementClient.js';
import type { Agreement } from '../src/types.js';

/**
 * ZIG-1111: a link never hands the raw agreement document to a caller. The rule
 * used to be written out at six call sites across the SDK runner, the MCP tools
 * and the capability layer, and three verbs never got it — `agreement_counter`,
 * `agreement_fulfill` and `agreement_subcontract` returned the raw document with
 * its money block, approvals ledger and Mongo internals intact.
 *
 * It is applied here now, where the document is parsed, so a new verb inherits
 * it. These tests cover the three that were broken plus the ones that worked, so
 * a regression on either side fails.
 */

const RAW_LINK = {
  agreementId: 'agr_link_1',
  engagementKind: 'link',
  status: 'active',
  proposalStatus: 'approved',
  description: 'trust',
  parties: {
    creator: { principal: 'u1', actor: 'a1' },
    provider: { principal: null, actor: 'a2' },
    proposedTo: { principal: 'u2', actor: null },
  },
  createdAt: '2026-07-01T00:00:00.000Z',
  money: { price: 500, paymentStatus: 'held' },
  approvals: [{ partyId: 'u2', status: 'approved' }],
  maxExecutions: 3,
  _id: 'mongo-internal',
} as const;

const RAW_SERVICE = {
  ...RAW_LINK,
  agreementId: 'agr_service_1',
  engagementKind: 'service',
} as const;

const CREDS = { operatorKey: 'op', agentId: 'a1' };

function stubJson(body: unknown): void {
  mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify(body), { status: 200 }),
  );
}

/** Keys the link summary must never carry — commerce and storage noise. */
const FORBIDDEN = ['money', 'approvals', 'maxExecutions', '_id'] as const;

function assertShapedLink(a: Record<string, unknown>): void {
  for (const key of FORBIDDEN) {
    assert.ok(!(key in a), `link summary must not carry "${key}"`);
  }
  // The facts a caller needs are still there — including engagementKind, which
  // every surface branches on, and which a summary hiding it would break.
  assert.equal(a.agreementId, 'agr_link_1');
  assert.equal(a.engagementKind, 'link');
  assert.equal(a.status, 'active');
  assert.ok('parties' in a);
}

function assertUntouchedService(a: Record<string, unknown>): void {
  assert.equal(a.agreementId, 'agr_service_1');
  assert.ok('money' in a, 'a service agreement is commerce — its money block stays');
  assert.ok('approvals' in a);
}

describe('AgreementClient link shaping', () => {
  afterEach(() => mock.restoreAll());

  // ── the three that were broken ─────────────────────────────────────────────

  it('counterAgreement shapes a link (was raw)', async () => {
    stubJson({ agreement: RAW_LINK });
    assertShapedLink(
      (await counterAgreement('agr_link_1', { price: 100 }, CREDS)) as unknown as Record<string, unknown>,
    );
  });

  it('fulfillAgreement shapes a link (was raw)', async () => {
    stubJson({ ok: true, agreement: RAW_LINK });
    const { ok, agreement } = await fulfillAgreement('agr_link_1', CREDS);
    assert.equal(ok, true, 'the envelope survives shaping');
    assertShapedLink(agreement as unknown as Record<string, unknown>);
  });

  it('proposeAgreement shapes a link — the subcontract/propose path (was raw)', async () => {
    stubJson({ agreement: RAW_LINK });
    assertShapedLink(
      (await proposeAgreement(
        { description: 'trust', proposedTo: 'a2', engagementKind: 'link' },
        CREDS,
      )) as unknown as Record<string, unknown>,
    );
  });

  // ── the ones that already worked, so a regression fails here ──────────────

  it('claimAgreement shapes a link', async () => {
    stubJson({ ok: true, agreement: RAW_LINK });
    assertShapedLink((await claimAgreement('agr_link_1', CREDS)).agreement as unknown as Record<string, unknown>);
  });

  it('revokeAgreement shapes a link', async () => {
    stubJson({ ok: true, agreement: RAW_LINK });
    assertShapedLink((await revokeAgreement('agr_link_1', CREDS)).agreement as unknown as Record<string, unknown>);
  });

  it('getAgreement shapes a link', async () => {
    stubJson({ agreement: RAW_LINK });
    assertShapedLink((await getAgreement('agr_link_1', CREDS)) as unknown as Record<string, unknown>);
  });

  it('listAgreements shapes every link in the page', async () => {
    stubJson({ agreements: [RAW_LINK, RAW_SERVICE] });
    const [link, service] = (await listAgreements({}, CREDS)) as unknown as Array<Record<string, unknown>>;
    assertShapedLink(link);
    assertUntouchedService(service);
  });

  // ── the rule only fires on links ──────────────────────────────────────────

  it('leaves a non-link agreement verbatim on every verb', async () => {
    for (const call of [
      () => counterAgreement('agr_service_1', { price: 100 }, CREDS),
      () => getAgreement('agr_service_1', CREDS),
      () => proposeAgreement({ description: 'x', proposedTo: 'a2' }, CREDS),
    ]) {
      stubJson({ agreement: RAW_SERVICE });
      assertUntouchedService((await call()) as unknown as Record<string, unknown>);
      mock.restoreAll();
    }
    stubJson({ ok: true, agreement: RAW_SERVICE });
    assertUntouchedService(
      (await fulfillAgreement('agr_service_1', CREDS)).agreement as unknown as Record<string, unknown>,
    );
  });

  it('keeps the seat bookkeeping an open invite needs', () => {
    const shaped = linkSummary({
      ...RAW_LINK,
      linkInvite: { maxClaims: 5, claimsUsed: 2 },
    } as unknown as Agreement);
    assert.deepEqual(shaped.linkInvite, { maxClaims: 5, claimsUsed: 2 });
  });

  it('is idempotent — shaping a summary again changes nothing', () => {
    const once = linkSummary(RAW_LINK as unknown as Agreement);
    assert.deepEqual(linkSummary(once as unknown as Agreement), once);
  });
});
