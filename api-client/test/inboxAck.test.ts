import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planInboxAck, planPartialInboxAck } from '../src/inboxAck.js';
const envelope = {
  ackTo: 'opaque',
  deliveries: [
    { responsibilityId: 'a', resourceId: 'same', assigneeId: 'me', ts: 't' },
    { responsibilityId: 'b', resourceId: 'same', assigneeId: 'me', ts: 't' },
    { responsibilityId: 'sibling', assigneeId: 'other' },
    { responsibilityId: 'ambient', assigneeId: null },
  ],
  openRequestsAwaitingMe: [{ agreementId: 'request', responsibilityId: 'request-receipt' }],
};
describe('delivery acknowledgement planning', () => {
  it('lists exact own responsibilities, including discovery request receipts', () => {
    assert.deepEqual(planInboxAck(envelope, { ownAgentId: 'me' }), { allowed: true, handledDeliveryIds: ['a', 'b', 'request-receipt'] });
  });
  it('allows a later success despite an earlier failure and a shared timestamp', () => {
    assert.deepEqual(planPartialInboxAck(envelope, new Set(['b']), { ownAgentId: 'me', failures: 1 }), { ackTo: 'opaque', handledDeliveryIds: ['b'] });
  });
  it('does not substitute resource or thread ids for responsibilities', () => {
    assert.equal(planPartialInboxAck(envelope, new Set(['same']), { ownAgentId: 'me' }), null);
  });
  it('never handles ambient, sibling or inaccessible jobs', () => {
    const e = { ...envelope, deliveries: [...envelope.deliveries, { responsibilityId: 'closed', assigneeId: 'me', outOfReach: { remedy: 'ask' } }] };
    assert.deepEqual(planPartialInboxAck(e, new Set(['ambient', 'sibling', 'closed', 'a']), { ownAgentId: 'me' })?.handledDeliveryIds, ['a']);
  });
  it('a connection may handle its identities but not an unrelated agent', () => {
    assert.deepEqual(planInboxAck(envelope, { ownAgentIds: ['me', 'other'] }).handledDeliveryIds, ['a', 'b', 'sibling', 'request-receipt']);
  });
  it('does not advertise a full-pass ack after failures or without a cursor', () => {
    assert.equal(planInboxAck(envelope, { failures: 1 }).allowed, false);
    assert.equal(planInboxAck({ ...envelope, ackTo: null }).allowed, false);
  });
});
