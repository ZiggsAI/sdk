import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterStandingOfferNotices, isOwnUnclaimedStandingOffer } from '../src/brain/standingOfferNotice.js';
import type { RawEvent } from '../src/runtime/buildOutcome.js';

const listing = {
  agreementId: 'agr_listing', status: 'open', providerPinned: true,
  parties: { provider: { actor: 'sales', principal: 'org_supplier' }, payer: { principal: 'everyone' }, proposedTo: { principal: 'org_supplier' } },
};
const notice: RawEvent = { type: 'resource_changed', agreementId: 'agr_listing', resource: {
  kind: 'agreement', reason: 'approval:approved', agreementId: 'agr_listing', actorId: 'org_supplier',
} };

test('provider acceptance of an open pinned listing has no customer hire to greet', async () => {
  assert.equal(isOwnUnclaimedStandingOffer(listing, 'agr_listing', 'sales'), true);
  const result = await filterStandingOfferNotices(notice, 'sales', async () => listing);
  assert.equal(result.event, undefined);
  assert.deepEqual(result.ignoredAgreementIds, ['agr_listing']);
});

test('active hires, direct approvals, stamped offers, other providers and requests are retained', async () => {
  for (const row of [
    { ...listing, status: 'active' },
    { ...listing, providerPinned: false },
    { ...listing, parties: { ...listing.parties, payer: { principal: 'customer' } } },
    { ...listing, parties: { ...listing.parties, provider: { actor: 'other-agent' } } },
    { ...listing, parties: { payer: { principal: 'customer' }, proposedTo: { principal: 'everyone' } } },
    { ...listing, agreementId: 'agr_different' },
    { agreementId: 'agr_listing', agreementStatus: 'open', proposedToId: 'org_supplier' },
    null,
  ]) {
    const result = await filterStandingOfferNotices(notice, 'sales', async () => row);
    assert.equal(result.event, notice, JSON.stringify(row));
  }
  const failed = await filterStandingOfferNotices(notice, 'sales', async () => { throw new Error('unavailable'); });
  assert.equal(failed.event, notice);
});

test('mixed batch removes only the listing notice, preserves the customer message and reads once', async () => {
  const message: RawEvent = { type: 'message', text: 'Please prepare the order', senderId: 'customer' };
  let reads = 0;
  const result = await filterStandingOfferNotices({ type: 'batch', events: [notice, message, notice] }, 'sales', async () => { reads++; return listing; });
  assert.equal(reads, 1);
  assert.equal(result.event, message);
});

test('org-scoped listings have the same open buyer slot semantics', () => {
  assert.equal(isOwnUnclaimedStandingOffer({ ...listing, parties: { ...listing.parties, payer: { principal: 'org' } } }, 'agr_listing', 'sales'), true);
});

test('conflicting agreement references are not treated as proven listing bookkeeping', async () => {
  let reads = 0;
  const conflicting = { ...notice, agreementId: 'agr_customer' };
  const result = await filterStandingOfferNotices(conflicting, 'sales', async () => { reads++; return listing; });
  assert.equal(result.event, conflicting);
  assert.equal(reads, 0);
});
