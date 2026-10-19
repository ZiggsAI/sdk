import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDeliveryWriteKeys } from '../src/runtime/deliveryWriteKeys.js';

const LANE = 'agent-1:chat-1';

describe('createDeliveryWriteKeys', () => {
  it('derives the same key sequence on a crash-replay of the same wake', () => {
    const event = { type: 'message', messageId: 'm-42', senderId: 'u1', timestamp: 111 };
    const first = createDeliveryWriteKeys(LANE, event);
    // Replay: fresh instance, same durable inputs, different volatile fields.
    const replay = createDeliveryWriteKeys(LANE, { ...event, timestamp: 999_999 });

    assert.ok(first.wakeKey);
    assert.equal(first.wakeKey, replay.wakeKey);
    assert.equal(first.artifactKey(), replay.artifactKey());
    assert.equal(first.artifactKey(), replay.artifactKey());
    assert.equal(
      first.messageKey({ text: 'hello', sessionId: 'chat-1', receiverId: 'u1' }),
      replay.messageKey({ text: 'hello', sessionId: 'chat-1', receiverId: 'u1' }),
    );
    assert.equal(
      first.taskStateKey('task-1', 'completed'),
      replay.taskStateKey('task-1', 'completed'),
    );
    assert.equal(
      first.taskSpawnKey({ agreementId: 'agr-1', description: 'do the thing', assigneeId: 'agent-2' }),
      replay.taskSpawnKey({ agreementId: 'agr-1', description: 'do the thing', assigneeId: 'agent-2' }),
    );
  });

  it('message keys are content-derived and messageId-shaped (ZIG-1045)', () => {
    const keys = createDeliveryWriteKeys(LANE, { type: 'message', messageId: 'm-1' });
    const a0 = keys.artifactKey();
    const mHello = keys.messageKey({ text: 'hello', sessionId: 'chat-1', receiverId: 'u1' });
    const mBye = keys.messageKey({ text: 'bye', sessionId: 'chat-1', receiverId: 'u1' });
    const mHelloAgain = keys.messageKey({ text: 'hello', sessionId: 'chat-1', receiverId: 'u1' });
    assert.ok(a0!.endsWith('_a0'));
    assert.match(mHello!, /^sdk_idem_wk_[0-9a-f]{40}_m_[0-9a-f]{16}$/);
    // Two emissions in one wake with different text get different keys — no
    // ordinal slot collision that would 409-drop the second send.
    assert.notEqual(mHello, mBye);
    // Same text re-derives the same key (crash-replay / identical resend).
    assert.equal(mHello, mHelloAgain);
    assert.ok(mHello!.length <= 128);
  });

  it('ZIG-1045: a redelivered wake re-thinking different text does not collide', () => {
    // Live failure: ordinal `_m6` reused with different content → backend 409
    // drops the reply. Content-derived keys keep same-text replay stable while
    // letting a re-think land under a new messageId.
    const wake = { type: 'message', messageId: 'm-live' };
    const first = createDeliveryWriteKeys(LANE, wake).messageKey({
      text: 'status: hired the worker',
      sessionId: 'chat-1',
      receiverId: 'u1',
    });
    const rethink = createDeliveryWriteKeys(LANE, wake).messageKey({
      text: 'status: worker accepted',
      sessionId: 'chat-1',
      receiverId: 'u1',
    });
    const sameAgain = createDeliveryWriteKeys(LANE, wake).messageKey({
      text: 'status: hired the worker',
      sessionId: 'chat-1',
      receiverId: 'u1',
    });
    assert.notEqual(first, rethink);
    assert.equal(first, sameAgain);
  });

  it('task-spawn keys are content-derived: order-independent, distinct per spawn', () => {
    const keys = createDeliveryWriteKeys(LANE, { type: 'message', messageId: 'm-1' });
    const spawn = { agreementId: 'agr-1', description: 'review chunk', assigneeId: 'agent-2' };
    // Re-deriving the same spawn yields the same key — no ordinal involved.
    assert.equal(keys.taskSpawnKey(spawn), keys.taskSpawnKey(spawn));
    // Any differing field is a different spawn.
    assert.notEqual(keys.taskSpawnKey(spawn), keys.taskSpawnKey({ ...spawn, description: 'review other chunk' }));
    assert.notEqual(keys.taskSpawnKey(spawn), keys.taskSpawnKey({ ...spawn, assigneeId: 'agent-3' }));
    assert.notEqual(keys.taskSpawnKey(spawn), keys.taskSpawnKey({ ...spawn, agreementId: 'agr-2' }));
    assert.notEqual(keys.taskSpawnKey(spawn), keys.taskSpawnKey({ ...spawn, parentTaskId: 'task-9' }));
    assert.ok(keys.taskSpawnKey(spawn)!.length <= 128);
  });

  it('agreement-propose keys are content-derived: replay-stable, distinct per field', () => {
    const first = createDeliveryWriteKeys(LANE, { type: 'message', messageId: 'm-1' });
    const replay = createDeliveryWriteKeys(LANE, { type: 'message', messageId: 'm-1' });
    const propose = { proposedTo: 'agent-2', providerId: 'agent-2', description: 'make me a logo' };
    // A crash-replay of the same wake re-derives the same propose key.
    assert.equal(first.agreementProposeKey(propose), replay.agreementProposeKey(propose));
    // Re-deriving within one wake is stable — no ordinal.
    assert.equal(first.agreementProposeKey(propose), first.agreementProposeKey(propose));
    // Any differing field is a distinct proposal.
    assert.notEqual(first.agreementProposeKey(propose), first.agreementProposeKey({ ...propose, proposedTo: 'agent-3' }));
    assert.notEqual(first.agreementProposeKey(propose), first.agreementProposeKey({ ...propose, providerId: 'agent-3' }));
    assert.notEqual(first.agreementProposeKey(propose), first.agreementProposeKey({ ...propose, description: 'make me a banner' }));
    assert.notEqual(first.agreementProposeKey(propose), first.agreementProposeKey({ ...propose, parentAgreementId: 'agr-9' }));
    assert.ok(first.agreementProposeKey(propose)!.length <= 128);
  });

  it('agreement-subcontract keys are content-derived: replay-stable, distinct per field, disjoint from propose', () => {
    const first = createDeliveryWriteKeys(LANE, { type: 'message', messageId: 'm-1' });
    const replay = createDeliveryWriteKeys(LANE, { type: 'message', messageId: 'm-1' });
    const sub = { executorId: 'agent-2', description: 'do the thing', parentAgreementId: 'agr-1' };
    assert.equal(first.agreementSubcontractKey(sub), replay.agreementSubcontractKey(sub));
    assert.notEqual(first.agreementSubcontractKey(sub), first.agreementSubcontractKey({ ...sub, executorId: 'agent-3' }));
    assert.notEqual(first.agreementSubcontractKey(sub), first.agreementSubcontractKey({ ...sub, description: 'other' }));
    assert.notEqual(first.agreementSubcontractKey(sub), first.agreementSubcontractKey({ ...sub, parentAgreementId: 'agr-2' }));
    // The propose and subcontract namespaces never collide even on identical fields.
    assert.notEqual(
      first.agreementProposeKey({ proposedTo: 'agent-2', providerId: 'agent-2', description: 'do the thing', parentAgreementId: 'agr-1' }),
      first.agreementSubcontractKey(sub),
    );
    assert.ok(first.agreementSubcontractKey(sub)!.length <= 128);
  });

  it('artifact ordinals increment; task-state keys are order-independent', () => {
    const keys = createDeliveryWriteKeys(LANE, { type: 'message', messageId: 'm-1' });
    const a0 = keys.artifactKey();
    const a1 = keys.artifactKey();
    assert.ok(a0!.endsWith('_a0'));
    assert.ok(a1!.endsWith('_a1'));
    assert.notEqual(a0, a1);
    // Repeated derivation of the same transition yields the same key — no ordinal.
    assert.equal(keys.taskStateKey('t1', 'completed'), keys.taskStateKey('t1', 'completed'));
    assert.notEqual(keys.taskStateKey('t1', 'completed'), keys.taskStateKey('t1', 'failed'));
    assert.notEqual(keys.taskStateKey('t1', 'completed'), keys.taskStateKey('t2', 'completed'));
  });

  it('content-derived artifact keys survive a redelivered wake that re-thinks', () => {
    const event = { type: 'agreement_lifecycle', agreementId: 'agr-1', operation: 'approved' };
    // The same lifecycle event delivered twice: identity — and so wakeHash — is
    // identical, and the second wake's ordinals restart at a0. With ordinals the
    // re-think's distinct artifacts collide with the first wake's and the
    // backend discards them; content-derived keys keep them distinct.
    const first = createDeliveryWriteKeys(LANE, event);
    const replay = createDeliveryWriteKeys(LANE, event);
    assert.equal(first.wakeKey, replay.wakeKey);

    first.artifactKey({ kind: 'thought', text: 'first thought' });
    const spec = replay.artifactKey({ kind: 'result', text: 'the spec' });
    assert.notEqual(spec, first.artifactKey({ kind: 'thought', text: 'first thought' }));

    // Same content on a replayed wake still dedups — replay protection intact.
    assert.equal(
      first.artifactKey({ kind: 'result', text: 'the spec' }),
      spec,
    );
    // Two distinct artifacts in ONE wake do not collide.
    assert.notEqual(
      first.artifactKey({ kind: 'result', text: 'a' }),
      first.artifactKey({ kind: 'result', text: 'b' }),
    );
    assert.ok(spec!.length <= 128);
  });

  it('different lanes and different events never share keys', () => {
    const event = { type: 'message', messageId: 'm-1' };
    const a = createDeliveryWriteKeys('agent-1:chat-1', event);
    const b = createDeliveryWriteKeys('agent-2:chat-1', event);
    const c = createDeliveryWriteKeys('agent-1:chat-1', { type: 'message', messageId: 'm-2' });
    assert.notEqual(a.wakeKey, b.wakeKey);
    assert.notEqual(a.wakeKey, c.wakeKey);
  });

  it('keys stay under the backend 128-char cap', () => {
    const keys = createDeliveryWriteKeys(
      `agent-${'x'.repeat(80)}:chat-${'y'.repeat(80)}`,
      { type: 'message', messageId: `m-${'z'.repeat(120)}` },
    );
    for (let i = 0; i < 1000; i++) keys.artifactKey();
    assert.ok(keys.artifactKey()!.length <= 128);
    assert.ok(keys.taskStateKey('t'.repeat(100), 'completed')!.length <= 128);
  });

  it('identifies task_result wakes by task snapshot when no messageId exists', () => {
    const bootstrap = { type: 'task_result', result: { taskId: 't-9', state: 'active' } };
    const a = createDeliveryWriteKeys(LANE, bootstrap);
    const b = createDeliveryWriteKeys(LANE, bootstrap);
    assert.ok(a.wakeKey);
    assert.equal(a.wakeKey, b.wakeKey);
    // A later, different snapshot of the same task is a different wake.
    const c = createDeliveryWriteKeys(LANE, { type: 'task_result', result: { taskId: 't-9', state: 'completed' } });
    assert.notEqual(a.wakeKey, c.wakeKey);
  });

  it('prefers messageId over the task snapshot when both exist', () => {
    const a = createDeliveryWriteKeys(LANE, { type: 'task_result', messageId: 'row-1', result: { taskId: 't', state: 'active' } });
    const b = createDeliveryWriteKeys(LANE, { type: 'task_result', messageId: 'row-2', result: { taskId: 't', state: 'active' } });
    assert.notEqual(a.wakeKey, b.wakeKey);
  });

  it('identifies agreement_lifecycle wakes by agreement + operation', () => {
    const a = createDeliveryWriteKeys(LANE, { type: 'agreement_lifecycle', agreementId: 'agr-1', operation: 'proposal_approved' });
    const b = createDeliveryWriteKeys(LANE, { type: 'agreement_lifecycle', agreementId: 'agr-1', operation: 'proposal_approved' });
    const c = createDeliveryWriteKeys(LANE, { type: 'agreement_lifecycle', agreementId: 'agr-1', operation: 'proposal_rejected' });
    assert.equal(a.wakeKey, b.wakeKey);
    assert.notEqual(a.wakeKey, c.wakeKey);
  });

  it('wakes with no durable identity produce no keys at all', () => {
    for (const event of [
      null,
      undefined,
      { type: 'state-timeout', state: 'idle', waitedMs: 1000 },
      { type: 'resource_changed', resource: { kind: 'agreement', resourceId: 'agr-1', reason: 'updated' } },
      { type: 'message' }, // no messageId on the wire
      { type: 'batch', events: [{ type: 'state-timeout', state: 'idle', waitedMs: 1 }] },
    ]) {
      const keys = createDeliveryWriteKeys(LANE, event);
      assert.equal(keys.wakeKey, null, `expected null wakeKey for ${JSON.stringify(event)}`);
      assert.equal(keys.artifactKey(), undefined);
      assert.equal(keys.taskStateKey('t1', 'completed'), undefined);
      assert.equal(keys.messageKey({ text: 'x', sessionId: 'c', receiverId: 'u' }), undefined);
      assert.equal(keys.taskSpawnKey({ agreementId: 'agr-1', description: 'd' }), undefined);
      assert.equal(keys.agreementProposeKey({ proposedTo: 'agent-2', description: 'd' }), undefined);
      assert.equal(keys.agreementSubcontractKey({ executorId: 'agent-2', description: 'd', parentAgreementId: 'agr-1' }), undefined);
    }
  });

  it('batch identity is member-order independent and ignores identity-less members', () => {
    const m1 = { type: 'message', messageId: 'm-1' };
    const m2 = { type: 'message', messageId: 'm-2' };
    const timer = { type: 'state-timeout', state: 'idle', waitedMs: 5 };
    const a = createDeliveryWriteKeys(LANE, { type: 'batch', events: [m1, m2, timer] });
    const b = createDeliveryWriteKeys(LANE, { type: 'batch', events: [m2, timer, m1] });
    assert.ok(a.wakeKey);
    assert.equal(a.wakeKey, b.wakeKey);
  });
});
