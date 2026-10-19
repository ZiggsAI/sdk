import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planInboxAck, planPartialInboxAck } from '../src/inboxAck.js';

/**
 * ZIG-1767 — one function decides the ack list and whether an ack is allowed.
 */
describe('planInboxAck', () => {
  const outOfReach = {
    scopeKind: 'chat',
    scopeId: 'chat-x',
    remedy: 'get a grant',
  };

  it('lists assigned rows and open requests, and allows when ackTo is set', () => {
    const decision = planInboxAck(
      {
        ackTo: 'ibxa1',
        deliveries: [
          { resourceId: 'msg-mine', assigneeId: 'agt-1' },
          { resourceId: 'msg-other', assigneeId: 'agt-2' },
        ],
        openRequestsAwaitingMe: [{ agreementId: 'agr-q' }],
      },
      { ownAgentId: 'agt-1' },
    );
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.handledResourceIds, ['msg-mine', 'agr-q']);
  });

  it('lists every delivery when no self id is configured', () => {
    const decision = planInboxAck({
      ackTo: 'ibxa1',
      deliveries: [
        { resourceId: 'a', assigneeId: 'x' },
        { resourceId: 'b', assigneeId: 'y' },
      ],
    });
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.handledResourceIds, ['a', 'b']);
  });

  it('never lists a row marked out of reach', () => {
    const decision = planInboxAck(
      {
        ackTo: 'ibxa1',
        deliveries: [
          { resourceId: 'open', assigneeId: 'agt-1' },
          { resourceId: 'closed', assigneeId: 'agt-1', outOfReach },
        ],
      },
      { ownAgentId: 'agt-1' },
    );
    assert.deepEqual(decision.handledResourceIds, ['open']);
  });

  it('refuses when there is no ackTo', () => {
    const decision = planInboxAck({
      ackTo: null,
      deliveries: [{ resourceId: 'm', assigneeId: 'agt-1' }],
    });
    assert.equal(decision.allowed, false);
  });

  it('acks when an old payload still carries a request-overflow count', () => {
    const decision = planInboxAck({
      ackTo: 'ibxa1',
      deliveries: [{ resourceId: 'm', assigneeId: 'agt-1' }],
      truncatedRequests: 2,
    } as Parameters<typeof planInboxAck>[0]);
    assert.equal(decision.allowed, true);
  });

  it('holds the watermark after a failed handover unless forceAck', () => {
    const envelope = {
      ackTo: 'ibxa1',
      deliveries: [{ resourceId: 'm', assigneeId: 'agt-1' }],
    };
    assert.equal(
      planInboxAck(envelope, { ownAgentId: 'agt-1', failures: 1 }).allowed,
      false,
    );
    assert.equal(
      planInboxAck(envelope, {
        ownAgentId: 'agt-1',
        failures: 1,
        forceAck: true,
      }).allowed,
      true,
    );
  });
});

/**
 * ZIG-1840 — how far a reader may ack mid-pass, so the stand-in's 90s takeover
 * window does not run against a whole poll pass.
 */
describe('planPartialInboxAck', () => {
  const T1 = '2026-06-01T10:00:00.000Z';
  const T2 = '2026-06-01T11:00:00.000Z';
  const T3 = '2026-06-01T12:00:00.000Z';
  const mineAt = (resourceId: string, ts: string) => ({
    resourceId,
    assigneeId: 'agt-1',
    ts,
    ackTo: `tok-${ts}`,
  });
  const envelope = {
    ackTo: 'tok-all',
    deliveries: [mineAt('a', T1), mineAt('b', T2), mineAt('c', T3)],
  };
  const opts = { ownAgentId: 'agt-1' };

  it('stops at the newest instant whose rows are all finished', () => {
    const step = planPartialInboxAck(envelope, new Set(['a']), opts);
    assert.deepEqual(step, { ackTo: `tok-${T1}`, handledResourceIds: ['a'] });
  });

  it('does not skip ahead over an unfinished older row', () => {
    // 'c' is done but 'b' is not: a mark at T3 would bury 'b'.
    const step = planPartialInboxAck(envelope, new Set(['a', 'c']), opts);
    assert.deepEqual(step, { ackTo: `tok-${T1}`, handledResourceIds: ['a'] });
  });

  it('returns null before anything is finished', () => {
    assert.equal(planPartialInboxAck(envelope, new Set(), opts), null);
  });

  it('an open request gates the mark exactly as a delivery does', () => {
    const withRequest = {
      ...envelope,
      openRequestsAwaitingMe: [{ agreementId: 'agr-q', ts: T1 }],
    };
    assert.equal(planPartialInboxAck(withRequest, new Set(['a']), opts), null);
    assert.deepEqual(
      planPartialInboxAck(withRequest, new Set(['a', 'agr-q']), opts),
      { ackTo: `tok-${T1}`, handledResourceIds: ['a', 'agr-q'] },
    );
  });

  it('ignores a row that is not mine, and one out of reach', () => {
    const mixed = {
      ...envelope,
      deliveries: [
        mineAt('a', T1),
        { resourceId: 'theirs', assigneeId: 'agt-2', ts: T1, ackTo: `tok-${T1}` },
        {
          resourceId: 'unreachable',
          assigneeId: 'agt-1',
          ts: T1,
          ackTo: `tok-${T1}`,
          outOfReach: { scopeKind: 'chat', scopeId: 'c', remedy: 'grant' },
        },
      ],
    };
    assert.deepEqual(planPartialInboxAck(mixed, new Set(['a']), opts), {
      ackTo: `tok-${T1}`,
      handledResourceIds: ['a'],
    });
  });

  it('is null on an older server that mints no per-row token', () => {
    const old = {
      ackTo: 'tok-all',
      deliveries: [{ resourceId: 'a', assigneeId: 'agt-1', ts: T1 }],
    };
    assert.equal(planPartialInboxAck(old, new Set(['a']), opts), null);
  });

  it('holds everything while a handover has failed', () => {
    const step = planPartialInboxAck(envelope, new Set(['a']), {
      ...opts,
      failures: 1,
    });
    assert.equal(step, null);
  });
});


it('a connection acknowledges assignments to all of its identities, excluding siblings', () => {
  const answer = planInboxAck({ackTo: 'all', deliveries: [
    {resourceId: 'a', assigneeId: 'assistant-a'},
    {resourceId: 'b', assigneeId: 'assistant-b'},
    {resourceId: 'other', assigneeId: 'sibling'},
  ]}, {ownAgentIds: ['assistant-a', 'assistant-b']});
  assert.deepEqual(answer.handledResourceIds, ['a', 'b']);
});
