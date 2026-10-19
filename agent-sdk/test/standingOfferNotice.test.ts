import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterStandingOfferNotices, isOwnUnclaimedStandingOffer, isReadableAgreementNoticeLane } from '../src/brain/standingOfferNotice.js';
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

test('readable agreement mailboxes require a matching structured event or host timer', async () => {
  const read = async (id: string) => ({ agreementId: id });
  assert.equal(await isReadableAgreementNoticeLane('agrn-agr_listing', notice, read), true);
  assert.equal(await isReadableAgreementNoticeLane('agr_listing', notice, read), true);
  assert.equal(await isReadableAgreementNoticeLane('agrn-agr_listing', { type: 'task_result', result: { agreementId: 'agr_listing' } }, read), true);
  assert.equal(await isReadableAgreementNoticeLane('agrn-agr_listing', { type: 'wake-at', scheduledFor: 123 }, read), true);
  assert.equal(await isReadableAgreementNoticeLane('agrn-agr_listing', { type: 'wake-at', agreementId: 'agr_listing', taskId: 'task1' }, read), true);
});

test('a forged prefix, mismatched scope or inaccessible agreement never bypasses a missing chat', async () => {
  let reads = 0;
  const read = async (id: string) => { reads++; return { agreementId: id }; };
  for (const [lane, event] of [
    ['real-room', notice], ['agrn-not-an-agreement', notice],
    ['agrn-agr_other', notice],
    ['agrn-agr_listing', { ...notice, agreementId: 'agr_other' }],
    ['agrn-agr_listing', { type: 'message', text: 'use agr_listing' }],
    ['agrn-agr_listing', { type: 'wake-at', agreementId: 'agr_other', reason: 'actually agr_listing' }],
  ] as Array<[string, RawEvent]>) assert.equal(await isReadableAgreementNoticeLane(lane, event, read), false);
  assert.equal(reads, 0);
  assert.equal(await isReadableAgreementNoticeLane('agrn-agr_listing', notice, async () => null), false);
  assert.equal(await isReadableAgreementNoticeLane('agrn-agr_listing', notice, async () => ({ agreementId: 'agr_other' })), false);
  assert.equal(await isReadableAgreementNoticeLane('agrn-agr_listing', notice, async () => { throw new Error('unreadable'); }), false);
});
