import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryStore,
  hireIdsFromEvent,
  memorySectionForWake,
  partitionMemoryStore,
} from '../src/memory/MemoryStore.js';

describe('memorySectionForWake', () => {
  it('uses the pinned hire when the wake carries one', () => {
    assert.equal(
      memorySectionForWake({ sessionId: 'chat-a', activeAgreementId: 'agr_dana' }),
      'hire:agr_dana',
    );
  });

  it('uses the agrn- lane when nothing is pinned', () => {
    assert.equal(
      memorySectionForWake({ sessionId: 'agrn-agr_hire' }),
      'hire:agr_hire',
    );
  });

  it('uses the delivery hire on a chat-room wake with no pin', () => {
    assert.equal(
      memorySectionForWake({
        sessionId: 'chat-a',
        wakeAgreementIds: ['agr_dana'],
      }),
      'hire:agr_dana',
    );
  });

  it('a wake under several agreements has no notes section: notes are bound to one agreement', () => {
    assert.equal(
      memorySectionForWake({
        sessionId: 'chat-shared',
        wakeAgreementIds: ['agr_dana', 'agr_omar'],
      }),
      null,
    );
  });

  it('a wake under no agreement has no notes section either', () => {
    assert.equal(memorySectionForWake({ sessionId: 'chat-a' }), null);
  });
});

describe('hireIdsFromEvent', () => {
  it('reads the delivery hire off a chat-room message', () => {
    assert.deepEqual(
      hireIdsFromEvent({ type: 'message', agreementId: 'agr_dana' }),
      ['agr_dana'],
    );
  });
});

describe('partitionMemoryStore', () => {
  it('a wake under none or several agreements has nothing to read and refuses to write', async () => {
    const backing = new InMemoryStore();
    const mixed = partitionMemoryStore(
      backing,
      memorySectionForWake({ sessionId: 'room-ab', wakeAgreementIds: ['a', 'b'] }),
    );
    assert.equal(await mixed.get('note'), undefined);
    assert.deepEqual(await mixed.list(''), []);
    await assert.rejects(mixed.put('note', 'x'), /kept per agreement/);
    // Nothing reached the backing store: not the room's drawer, not the agent's.
    assert.deepEqual(await backing.list(''), []);
  });
  it('keeps a note written in one hire unreadable in another', async () => {
    const backing = new InMemoryStore();
    const dana = partitionMemoryStore(backing, 'hire:agr_dana');
    const omar = partitionMemoryStore(backing, 'hire:agr_omar');

    await dana.put('note', 'dana-only');
    assert.equal(await dana.get('note'), 'dana-only');
    assert.equal(await omar.get('note'), undefined);
    assert.deepEqual(await omar.list(''), []);
    assert.deepEqual(await dana.list(''), [{ key: 'note', value: 'dana-only' }]);
  });

  it('leaves the agent key shape unchanged so chat-keyed tools still match', async () => {
    const backing = new InMemoryStore();
    const section = partitionMemoryStore(backing, 'agent');
    await section.put('orch:prepared:chat-1', ['specialist-a']);
    assert.deepEqual(await section.get('orch:prepared:chat-1'), ['specialist-a']);
    assert.equal(await section.get('orch:prepared:chat-2'), undefined);
    const listed = await section.list('orch:prepared:');
    assert.deepEqual(listed, [{ key: 'orch:prepared:chat-1', value: ['specialist-a'] }]);
  });
});
