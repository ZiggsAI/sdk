import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ArtifactMemoryStore,
  memoryStoreFor,
  type NoteArtifactClient,
} from '../src/memory/ArtifactMemoryStore.js';
import { partitionMemoryStore } from '../src/memory/MemoryStore.js';

class FakeNotes implements NoteArtifactClient {
  writes: Array<Record<string, unknown>> = [];
  rows: Array<{
    name: string;
    text: string;
    timestamp: string;
    contentType: string;
    visibility: string;
  }> = [];

  async writeStrict(input: {
    text: string;
    name: string;
    contentType: string;
    visibility: 'agent-private';
  }): Promise<{ artifactId?: string }> {
    this.writes.push({ ...input });
    this.rows.push({
      name: input.name,
      text: input.text,
      timestamp: new Date(Date.now() + this.rows.length).toISOString(),
      contentType: input.contentType,
      visibility: input.visibility,
    });
    return { artifactId: `art-${this.rows.length}` };
  }

  async list(): Promise<{
    artifacts: FakeNotes['rows'];
    latestSequence: string | null;
  }> {
    return {
      artifacts: this.rows,
      latestSequence: this.rows.at(-1)?.timestamp ?? null,
    };
  }
}

describe('ArtifactMemoryStore', () => {
  it('keeps a note across a new store and hides it from another hire', async () => {
    const notes = new FakeNotes();
    const first = new ArtifactMemoryStore({
      operatorKey: 'op',
      agentId: 'agent',
      client: notes,
    });
    const dana = partitionMemoryStore(first, 'hire:dana');
    await dana.put('customer', { owes: 12 });

    const restarted = partitionMemoryStore(
      new ArtifactMemoryStore({ operatorKey: 'op', agentId: 'agent', client: notes }),
      'hire:dana',
    );
    assert.deepEqual(await restarted.get('customer'), { owes: 12 });

    const omar = partitionMemoryStore(
      new ArtifactMemoryStore({ operatorKey: 'op', agentId: 'agent', client: notes }),
      'hire:omar',
    );
    assert.equal(await omar.get('customer'), undefined);

    const write = notes.writes[0];
    assert.equal(write.visibility, 'agent-private');
    assert.equal(write.contentType, 'agent-note');
    assert.equal(write.chatId, undefined);
    assert.equal(write.agreementId, undefined);
    assert.equal(write.taskId, undefined);
    assert.equal('artifactId' in (await dana.get('customer') as object), false);
  });

  it('a later write of the same note is the one a restart reads', async () => {
    const notes = new FakeNotes();
    const store = new ArtifactMemoryStore({
      operatorKey: 'op',
      agentId: 'agent',
      client: notes,
    });
    await store.put('k', 'one');
    await store.put('k', 'two');
    const restarted = new ArtifactMemoryStore({
      operatorKey: 'op',
      agentId: 'agent',
      client: notes,
    });
    assert.equal(await restarted.get('k'), 'two');
    assert.equal(notes.writes.length, 2);
  });

  it('credentials select the durable store unless the caller passed one', () => {
    const durable = memoryStoreFor({ operatorKey: 'op', agentId: 'agent' });
    assert.equal(durable instanceof ArtifactMemoryStore, true);
    const local = memoryStoreFor({});
    assert.equal(local instanceof ArtifactMemoryStore, false);
    const given = memoryStoreFor({
      operatorKey: 'op',
      agentId: 'agent',
      memory: local,
    });
    assert.equal(given, local);
  });
});
