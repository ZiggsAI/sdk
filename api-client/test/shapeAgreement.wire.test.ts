/**
 * ZIG-1778 — `shapeAgreement` lifts what the wire nests.
 *
 * The client type offers `description`, `proposalStatus`, `lifecycle`,
 * `expiresAt`, `maxExecutions` and `linkInvite` at the top level; the server
 * sends them under `terms` and `proposal`, and calls the seats `claimSeats`.
 * Nothing mapped between the two, so every one of those reads answered
 * `undefined` while the hand-written type promised a value — the failure a
 * generated contract exists to make impossible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeAgreement } from '../src/http/AgreementClient.js';
import type { Agreement } from '../src/types.js';

/** A hire as `GET /agreements/:id` actually answers it. */
const wireHire = {
  agreementId: 'agr_1',
  engagementKind: 'hire',
  status: 'active',
  terms: {
    description: 'Book a room for the design review',
    lifecycle: 'count-bound',
    expiresAt: '2026-10-01T00:00:00.000Z',
    maxExecutions: 3,
    requiredConnections: [],
  },
  proposal: {
    status: 'approved',
    respondedBy: 'user_1',
    proposedAt: '2026-09-01T00:00:00.000Z',
    respondedAt: '2026-09-02T00:00:00.000Z',
  },
  money: { price: 6000, paymentStatus: 'held', transactionId: 'txn_1' },
} as unknown as Agreement;

test('lifts the terms a caller reads at the top level', () => {
  const shaped = shapeAgreement(wireHire);
  assert.equal(shaped.description, 'Book a room for the design review');
  assert.equal(shaped.lifecycle, 'count-bound');
  assert.equal(shaped.expiresAt, '2026-10-01T00:00:00.000Z');
  assert.equal(shaped.maxExecutions, 3);
});

test('lifts the proposal status, which is nested under `proposal`', () => {
  assert.equal(shapeAgreement(wireHire).proposalStatus, 'approved');
});

test('leaves the nested fields where the server put them', () => {
  // A view, not a move: code reading the wire path keeps working.
  const shaped = shapeAgreement(wireHire) as unknown as {
    terms?: { description?: string };
  };
  assert.equal(shaped.terms?.description, 'Book a room for the design review');
});

test('does not invent values the wire did not send', () => {
  const bare = { agreementId: 'agr_2', engagementKind: 'hire' } as Agreement;
  const shaped = shapeAgreement(bare);
  assert.equal('description' in shaped, false);
  assert.equal('proposalStatus' in shaped, false);
  assert.equal('linkInvite' in shaped, false);
});

test('claimSeats becomes linkInvite, the name the client reads', () => {
  const invite = {
    agreementId: 'agr_3',
    engagementKind: 'hire',
    claimSeats: { maxClaims: 5, claimsUsed: 2 },
  } as unknown as Agreement;
  assert.deepEqual(shapeAgreement(invite).linkInvite, {
    maxClaims: 5,
    claimsUsed: 2,
  });
});

test('a link still summarises, and carries the lifted status', () => {
  const link = {
    agreementId: 'agr_4',
    engagementKind: 'link',
    status: 'active',
    proposal: { status: 'approved' },
    parties: { creator: { principal: 'user_1', actor: null } },
  } as unknown as Agreement;
  const shaped = shapeAgreement(link);
  assert.equal(shaped.proposalStatus, 'approved');
  // The summary drops the payer side: a link carries no money.
  assert.equal((shaped.parties as Record<string, unknown>).payer, undefined);
});
