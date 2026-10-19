import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContextReadClient,
  CONTEXT_READ_TYPES,
  CONTEXT_READ_VIA,
  VIA_KINDS,
  parseVia,
  viaHint,
} from '../src/http/ContextReadClient.js';

/**
 * ZIG-1075 — the `via` grammar is one exported list, not prose repeated across a
 * regex, a type, and a tool description. These tests hold that list to the two
 * things that read it: the parser and the per-type map.
 */
describe('via vocabulary', () => {
  it('parses every kind in the vocabulary, and nothing outside it', () => {
    for (const kind of VIA_KINDS) {
      assert.deepEqual(parseVia(`${kind}:abc`), { kind, id: 'abc' });
    }
    assert.equal(parseVia('wallet:wal_1'), null, 'a rail that is not an entry');
    assert.equal(parseVia('chat'), null, 'no separator');
    assert.equal(parseVia('chat:'), null, 'no id');
    assert.equal(parseVia(':abc'), null, 'no kind');
  });

  it('keeps an id containing a colon whole', () => {
    assert.deepEqual(parseVia('chat:a:b'), { kind: 'chat', id: 'a:b' });
  });

  it('admits only known kinds per read type', () => {
    for (const type of CONTEXT_READ_TYPES) {
      const kinds = CONTEXT_READ_VIA[type];
      assert.ok(kinds.length > 0, `${type} must be readable through something`);
      for (const kind of kinds) {
        assert.ok(VIA_KINDS.includes(kind), `${kind} is not a via kind`);
      }
    }
  });

  it('renders a hint an agent can copy an argument out of', () => {
    assert.equal(viaHint('messages'), 'chat:<id>');
    assert.equal(viaHint('tasks'), 'agreement:<id>, task:<id>');
  });

  it('routes counterparty to no read — it resolves a graph, not content', () => {
    for (const type of CONTEXT_READ_TYPES) {
      assert.ok(!CONTEXT_READ_VIA[type].includes('counterparty'));
    }
  });
});

describe('ContextReadClient.snapshot', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('requests newest artifacts and carries their continuation cursor without a forward watermark', async () => {
    const urls: URL[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      urls.push(new URL(String(url)));
      return new Response(JSON.stringify({
        type: 'artifacts', via: { kind: 'chat', id: 'c1' }, items: [],
        hasMore: true, nextCursor: 'older-page', latestSequence: null,
      }), { status: 200 });
    });
    const client = new ContextReadClient('op', 'agent-a', 'http://test');
    const first = await client.read('artifacts', { via: 'chat:c1', direction: 'backward', limit: 20 });
    assert.equal(urls[0].searchParams.get('direction'), 'backward');
    assert.equal(first.latestSequence, null);
    await client.read('artifacts', { via: 'chat:c1', cursor: first.nextCursor! });
    assert.equal(urls[1].searchParams.get('cursor'), 'older-page');
    assert.equal(urls[1].searchParams.has('after'), false);
  });

  it('GETs /context/snapshot with via + maxMessages and X-Agent-Id', async () => {
    let calledUrl = '';
    let calledHeaders: Record<string, string> = {};
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calledUrl = String(url);
      calledHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          history: [],
          agreements: [],
          agents: [{ agentId: 'agent-a', role: 'self', isYou: true }],
          users: [],
          latestSequence: null,
        }),
        { status: 200 },
      );
    });

    const client = new ContextReadClient('op', 'agent-a', 'http://test');
    const snap = await client.snapshot('c1', { maxMessages: 25 });

    assert.match(calledUrl, /\/context\/snapshot\?/);
    assert.match(calledUrl, /via=chat%3Ac1/);
    assert.match(calledUrl, /maxMessages=25/);
    assert.equal(calledHeaders['Authorization'], 'Bearer op');
    assert.equal(calledHeaders['X-Agent-Id'], 'agent-a');
    assert.equal(snap.agents[0].isYou, true);
  });

  it('sends X-Context-Grant-Id header + query when a grant is presented', async () => {
    let calledUrl = '';
    let calledHeaders: Record<string, string> = {};
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calledUrl = String(url);
      calledHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({ history: [], agreements: [], agents: [], users: [] }),
        { status: 200 },
      );
    });

    const client = new ContextReadClient('op', 'agent-a', 'http://test');
    await client.snapshot('c1', { contextGrantId: 'xgr_9' });

    assert.match(calledUrl, /contextGrantId=xgr_9/);
    assert.equal(calledHeaders['X-Context-Grant-Id'], 'xgr_9');
  });

  it('rejects with an ApiError carrying the HTTP status on non-OK', async () => {
    mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 403 }));

    const client = new ContextReadClient('op', 'agent-a', 'http://test');
    await assert.rejects(
      () => client.snapshot('c1'),
      (err: Error & { status?: number; body?: string }) => {
        assert.equal(err.status, 403);
        assert.equal(err.message, 'nope');
        assert.equal(err.body, 'nope');
        return true;
      },
    );
  });

  it('throws when chatId is missing', async () => {
    const client = new ContextReadClient('op', 'agent-a', 'http://test');
    await assert.rejects(() => client.snapshot(''), /chatId is required/);
  });
});
