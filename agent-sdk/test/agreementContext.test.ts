import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withAgreementContext, permitsAutomaticMandate, isListing } from '../src/runtime/agreementContext.js';
import { normalizeIncomingEvent } from '../src/ingress/normalizeIncoming.js';

test('service messages retain governing agreement without becoming lifecycle notices', () => {
  const normalized = normalizeIncomingEvent({ text: 'hello', metadata: { chatId: 'room',
    service: { conversationAgreementId: 'trial' }, entryType: 'message' } });
  assert.equal(normalized.event.type, 'message');
  assert.equal(normalized.event.agreementId, 'trial');
});

test('each agreement in a shared room keeps its own terms and batch reads deduplicate', async () => {
  const calls: string[] = [];
  const enriched = await withAgreementContext({ type: 'batch', events: [
    { type: 'message', agreementId: 'trial' }, { type: 'message', agreementId: 'paid' }, { type: 'message', agreementId: 'trial' },
  ] }, async id => {
    calls.push(id);
    return { agreementId: id, status: 'active', terms: { description: id, conversationAllowance: id === 'trial' ? 5 : null },
      conversationUsage: { messages: 5 }, money: { price: id === 'trial' ? 0 : 100 } };
  }) as { events: Array<{ agreementContext: Record<string, unknown> }> };
  assert.deepEqual(calls.sort(), ['paid', 'trial']);
  assert.equal(enriched.events[0].agreementContext.messagesRemaining, 0);
  assert.equal(enriched.events[1].agreementContext.messageLimit, null);
  assert.equal(enriched.events[1].agreementContext.messagesRemaining, null);
  assert.equal(enriched.events[0].agreementContext.scope, 'trial');
});

test('ended work and failed authorized reads remain explicit', async () => {
  const ended = await withAgreementContext({ type: 'task_result', result: { agreementId: 'old' } }, async id => ({
    agreementId: id, status: 'fulfilled', terms: { maxExecutions: 2 }, money: {},
  })) as { agreementContext: Record<string, unknown> };
  assert.equal(ended.agreementContext.status, 'fulfilled');
  const failed = await withAgreementContext({ agreementId: 'private' }, async () => { throw new Error('403'); }) as { agreementContext: Record<string, unknown> };
  assert.equal(failed.agreementContext.available, false);
  assert.match(String(failed.agreementContext.instruction), /Verify authorization/);
});

test('a room id alone never selects an agreement', async () => {
  let reads = 0;
  const frame = { type: 'message', chatId: 'shared-room' };
  assert.equal(await withAgreementContext(frame, async () => { reads++; return {}; }), frame);
  assert.equal(reads, 0);
});

test('link and listing wakes never supply an automatic mandate for paid upgrades', async () => {
  const link = await withAgreementContext({ agreementId: 'relationship' }, async id => ({
    agreementId: id, status: 'active', engagementKind: 'link', terms: {},
  }));
  assert.equal(permitsAutomaticMandate(link), false);
  assert.equal(permitsAutomaticMandate({ type: 'batch', events: [link, { agreementId: 'paid' }] }), false);
  assert.equal(permitsAutomaticMandate({ agreementContext: { available: false } }), false);
  assert.equal(permitsAutomaticMandate({ agreementContext: { available: true } }), true);
});

// ZIG-1998 — a listing is conversation, never work: its per-hire allowance is
// not a stranger's count, and nothing is spent or filed under it.
test('a listing reads as a listing, never as work or a message allowance', async () => {
  const event = await withAgreementContext({ type: 'message', agreementId: 'listing' }, async id => ({
    agreementId: id, status: 'open', engagementKind: 'hire',
    parties: { payer: { principal: 'everyone', actor: null }, provider: { principal: 'org-seller', actor: 'seo-growth' } },
    terms: { description: 'SEO audits', conversationAllowance: 20 }, conversationUsage: { messages: 0 },
  })) as { agreementContext: Record<string, unknown> };
  assert.equal(event.agreementContext.listing, true);
  assert.equal(event.agreementContext.relationship, true);
  assert.equal(event.agreementContext.messageLimit, undefined);
  assert.match(String(event.agreementContext.instruction), /stranger talks with you under it/);
  assert.equal(permitsAutomaticMandate(event), false);
  assert.equal(isListing({ parties: { payer: 'org' }, engagementKind: 'service' }), true);
  assert.equal(isListing({ parties: { payer: 'everyone' }, engagementKind: 'link' }), false);
  assert.equal(isListing({ parties: { payer: { principal: 'user-1' } } }), false);
});
