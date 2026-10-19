import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  formationGuide,
  marketplaceFormation,
  marketplaceViewCapability,
} from '../src/index.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';

function env(surface: 'mcp' | 'sdk' = 'mcp'): CapabilityEnv {
  return {
    creds: { operatorKey: 'op', agentId: 'agt_me', laneId: 'ln_hire' },
    surface,
  };
}

describe('formation ladder: reuse, claim, request, subcontract', () => {
  it('reuses a matching active agreement instead of forming another', () => {
    const guide = formationGuide(env(), {
      matchingActive: { agreementId: 'agr_live' },
      listing: { agreementId: 'agr_listing' },
    });
    assert.equal(guide.kind, 'reuse');
    assert.equal(guide.outcome, 'noop');
    assert.equal(guide.agreementId, 'agr_live');
    assert.equal(guide.next?.tool, 'ziggs_agreement_get');
    assert.equal(guide.next?.args?.agreementId, 'agr_live');
    assert.equal(guide.next?.ready, true);
    assert.deepEqual(guide.next?.http, {
      method: 'GET',
      path: '/agreements/agr_live',
    });
    assert.match(guide.summary, /already covers/);
    assert.notEqual(guide.next?.tool, 'ziggs_agreement_claim');
  });

  it('refuses a second formation when the live hire would change terms', () => {
    const guide = formationGuide(env(), {
      liveHire: { agreementId: 'agr_live' },
      wantsChangedTerms: true,
      listing: { agreementId: 'agr_listing' },
    });
    assert.equal(guide.kind, 'hire_terms');
    assert.equal(guide.outcome, 'unavailable');
    assert.equal(guide.hireTerms?.secondHire, 'refused');
    assert.equal(guide.hireTerms?.amendLive, 'unavailable');
    assert.equal(guide.agreementId, 'agr_live');
  });

  it('claims a listing and never points at counter', () => {
    const guide = formationGuide(env(), {
      listing: { agreementId: 'agr_offer' },
    });
    assert.equal(guide.kind, 'claim');
    assert.equal(guide.outcome, 'ok');
    assert.equal(guide.next?.tool, 'ziggs_agreement_claim');
    assert.equal(guide.next?.args?.agreementId, 'agr_offer');
    assert.equal(guide.next?.ready, true);
    assert.deepEqual(guide.next?.http, {
      method: 'POST',
      path: '/agreements/agr_offer/claim',
    });
    assert.match(guide.summary, /never counter/);
    assert.doesNotMatch(guide.next?.tool ?? '', /counter/);
  });

  it('posts a request when nothing listed fits', () => {
    const guide = formationGuide(env(), {});
    assert.equal(guide.kind, 'request');
    assert.equal(guide.next?.tool, 'ziggs_agreement_request');
    assert.equal(guide.next?.ready, false);
    assert.ok(guide.next?.missing?.includes('description'));
    assert.deepEqual(guide.next?.http, {
      method: 'POST',
      path: '/agreements/proposals',
    });
    assert.match(guide.summary, /Nothing listed/);
  });

  it('subcontracts under a parent even when a listing also exists', () => {
    const guide = formationGuide(env(), {
      parentAgreementId: 'agr_parent',
      listing: { agreementId: 'agr_offer' },
    });
    assert.equal(guide.kind, 'subcontract');
    assert.equal(guide.next?.tool, 'ziggs_agreement_subcontract');
    assert.equal(guide.next?.args?.parentAgreementId, 'agr_parent');
    assert.equal(guide.next?.ready, false);
    assert.ok(guide.next?.missing?.includes('executorId'));
    assert.ok(guide.next?.missing?.includes('description'));
    assert.equal(guide.next?.missing?.includes('chatId'), false);
    assert.deepEqual(guide.next?.http, {
      method: 'POST',
      path: '/agreements/agr_parent/delegations',
    });
    assert.match(guide.summary, /own rail/);

    const sdk = formationGuide(env('sdk'), {
      parentAgreementId: 'agr_parent',
    });
    assert.equal(sdk.next?.tool, 'agreement_subcontract');
    assert.equal(sdk.next?.missing?.includes('chatId'), false);
    assert.deepEqual(sdk.next?.missing, guide.next?.missing);
  });

  it('does not buy past a claim-only agent', () => {
    const guide = formationGuide(env(), {
      counterparty: 'agt_listed',
      acceptsProposals: false,
      direction: 'buy',
    });
    assert.equal(guide.kind, 'claim');
    assert.equal(guide.outcome, 'unavailable');
    assert.equal(guide.next?.tool, 'ziggs_marketplace_view');
    assert.notEqual(guide.next?.tool, 'ziggs_agreement_buy');
    assert.match(guide.summary, /claim-only/);
  });

  it('goes direct only when they accept proposals and nothing is listed', () => {
    const guide = formationGuide(env('sdk'), {
      counterparty: 'agt_open',
      acceptsProposals: true,
      direction: 'buy',
    });
    assert.equal(guide.kind, 'direct');
    assert.equal(guide.next?.tool, 'agreement_buy');
    assert.equal(guide.next?.args?.counterparty, 'agt_open');
    assert.equal(guide.next?.ready, false);
    assert.ok(guide.next?.missing?.includes('description'));
    assert.deepEqual(guide.next?.http, {
      method: 'POST',
      path: '/agreements/proposals',
    });
  });
});

describe('marketplace browse carries a formation receipt', () => {
  afterEach(() => mock.restoreAll());

  it('one listing becomes a ready claim; an empty board becomes a request', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('/marketplace/requests')) {
        return new Response(JSON.stringify({ agreements: [] }), { status: 200 });
      }
      if (u.includes('/marketplace/offers')) {
        return new Response(
          JSON.stringify({
            offers: [
              {
                agreementId: 'agr_listed',
                terms: { description: 'standing help' },
                money: { price: 0 },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const listed = await marketplaceViewCapability.handler({}, env());
    assert.equal((listed as { engagement?: { kind?: string } }).engagement?.kind, 'claim');
    assert.equal(
      (listed as { engagement?: { next?: { tool?: string; args?: { agreementId?: string } } } })
        .engagement?.next?.tool,
      'ziggs_agreement_claim',
    );
    assert.equal(
      (listed as { engagement?: { next?: { args?: { agreementId?: string } } } }).engagement
        ?.next?.args?.agreementId,
      'agr_listed',
    );
    assert.match(String((listed as { nextSteps?: string }).nextSteps), /never counter/);
    assert.doesNotMatch(String((listed as { nextSteps?: string }).nextSteps), /agreement_propose/);

    mock.restoreAll();
    mock.method(globalThis, 'fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('/marketplace/requests') || u.includes('/marketplace/offers')) {
        return new Response(
          JSON.stringify({ agreements: [], offers: [] }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const empty = await marketplaceViewCapability.handler({}, env());
    assert.equal((empty as { engagement?: { kind?: string } }).engagement?.kind, 'request');
    assert.equal(
      (empty as { engagement?: { next?: { tool?: string } } }).engagement?.next?.tool,
      'ziggs_agreement_request',
    );
  });

  it('says when the board holds more listings than the read returned (ZIG-2128)', async () => {
    const board = (body: Record<string, unknown>) =>
      mock.method(globalThis, 'fetch', async (url: string) => {
        const u = String(url);
        if (u.includes('/marketplace/requests')) {
          return new Response(JSON.stringify({ agreements: [] }), { status: 200 });
        }
        if (u.includes('/marketplace/offers')) {
          return new Response(JSON.stringify(body), { status: 200 });
        }
        throw new Error(`unexpected fetch ${u}`);
      });
    const row = { agreementId: 'agr_1', terms: { description: 'help' }, money: { price: 0 } };

    board({ offers: [row], total: 86, hasMore: true });
    const capped = (await marketplaceViewCapability.handler({ limit: 1 }, env())) as {
      offerCount?: number;
      moreOffers?: { total?: number | null; note?: string };
    };
    assert.equal(capped.offerCount, 1);
    assert.equal(capped.moreOffers?.total, 86);
    assert.match(String(capped.moreOffers?.note), /larger limit/);

    mock.restoreAll();
    // All of them, or an older server with no total: nothing extra is said.
    board({ offers: [row], total: 1, hasMore: false });
    const whole = (await marketplaceViewCapability.handler({}, env())) as { moreOffers?: unknown };
    assert.equal(whole.moreOffers, undefined);
    mock.restoreAll();
    board({ offers: [row] });
    const older = (await marketplaceViewCapability.handler({}, env())) as { moreOffers?: unknown };
    assert.equal(older.moreOffers, undefined);
  });

  it('several listings leave agreementId for the caller to pick', () => {
    const guide = marketplaceFormation(env(), {
      listingAgreementIds: ['agr_a', 'agr_b'],
    });
    assert.equal(guide.kind, 'claim');
    assert.equal(guide.next?.ready, false);
    assert.deepEqual(guide.next?.missing, ['agreementId']);
    assert.equal('args' in (guide.next ?? {}), false);
  });
});
