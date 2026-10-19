import { createHash } from 'node:crypto';
import { ArtifactsClient } from '@ziggs-ai/api-client';
import {
  InMemoryStore,
  type MemoryStore,
} from './MemoryStore.js';

const NOTE_CONTENT_TYPE = 'agent-note';
const NOTE_NAME_PREFIX = 'mem:';
const PAGE_LIMIT = 100;
const MAX_PAGES = 30;

/**
 * The artifact calls a note store makes. Production uses {@link ArtifactsClient}.
 * Tests pass a fake. No chat, agreement, or task: a note is not a deliverable
 * and is not announced.
 */
export interface NoteArtifactClient {
  writeStrict(input: {
    text: string;
    name: string;
    contentType: string;
    visibility: 'agent-private';
  }): Promise<{ artifactId?: string }>;
  list(
    query: { authoredBy: 'me' },
    opts?: { after?: string; limit?: number },
  ): Promise<{
    artifacts: Array<{
      name?: string | null;
      text: string;
      timestamp: string;
      contentType: string;
      visibility: string;
    }>;
    latestSequence: string | null;
  }>;
}

interface StoredNote {
  key: string;
  value: unknown;
  timestamp: string;
}

function noteName(key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return `${NOTE_NAME_PREFIX}${digest}`;
}

function parseNote(text: string): { key: string; value: unknown } | null {
  try {
    const parsed = JSON.parse(text) as { key?: unknown; value?: unknown };
    if (typeof parsed?.key !== 'string') return null;
    return { key: parsed.key, value: parsed.value };
  } catch {
    return null;
  }
}

/**
 * Notes that survive a process restart.
 *
 * Each note is an agent-private artifact with no container. A later write of
 * the same key stores a newer row; reads return that row. An agent cannot
 * delete an artifact, so older rows stay and are not what a read returns.
 * The artifact id never leaves this store.
 */
export class ArtifactMemoryStore implements MemoryStore {
  private readonly client: NoteArtifactClient;
  private loaded: Map<string, StoredNote> | null = null;

  constructor(opts: { operatorKey: string; agentId: string; client?: NoteArtifactClient }) {
    this.client =
      opts.client ??
      new ArtifactsClient(opts.operatorKey, opts.agentId);
  }

  async get(key: string): Promise<unknown | undefined> {
    const notes = await this.notes();
    return notes.get(key)?.value;
  }

  async put(key: string, value: unknown): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.client.writeStrict({
      text: JSON.stringify({ key, value }),
      name: noteName(key),
      contentType: NOTE_CONTENT_TYPE,
      visibility: 'agent-private',
    });
    const notes = await this.notes();
    notes.set(key, { key, value, timestamp });
  }

  async list(prefix: string): Promise<{ key: string; value: unknown }[]> {
    const notes = await this.notes();
    const out: { key: string; value: unknown }[] = [];
    for (const note of notes.values()) {
      if (note.key.startsWith(prefix)) out.push({ key: note.key, value: note.value });
    }
    return out;
  }

  private async notes(): Promise<Map<string, StoredNote>> {
    if (this.loaded) return this.loaded;
    const byKey = new Map<string, StoredNote>();
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.client.list(
        { authoredBy: 'me' },
        { after, limit: PAGE_LIMIT },
      );
      for (const row of result.artifacts) {
        if (row.contentType !== NOTE_CONTENT_TYPE) continue;
        if (row.visibility !== 'agent-private') continue;
        if (!row.name?.startsWith(NOTE_NAME_PREFIX)) continue;
        const parsed = parseNote(row.text);
        if (!parsed) continue;
        const previous = byKey.get(parsed.key);
        if (!previous || row.timestamp >= previous.timestamp) {
          byKey.set(parsed.key, {
            key: parsed.key,
            value: parsed.value,
            timestamp: row.timestamp,
          });
        }
      }
      if (result.artifacts.length < PAGE_LIMIT || !result.latestSequence || result.latestSequence === after) {
        break;
      }
      after = result.latestSequence;
    }
    this.loaded = byKey;
    return byKey;
  }
}

/** The store a host gets when the caller did not pass one. */
export function memoryStoreFor(options: {
  memory?: MemoryStore;
  operatorKey?: string;
  agentId?: string;
}): MemoryStore {
  if (options.memory) return options.memory;
  if (options.operatorKey && options.agentId) {
    return new ArtifactMemoryStore({
      operatorKey: options.operatorKey,
      agentId: options.agentId,
    });
  }
  return new InMemoryStore();
}
