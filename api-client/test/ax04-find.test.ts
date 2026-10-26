import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactsClient, findArtifactsCapability } from '../src/index.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';

function env(surface: 'mcp' | 'sdk' = 'mcp'): CapabilityEnv {
  return {
    creds: { operatorKey: 'op', agentId: 'agent-1', laneId: 'chat_acme' },
    surface,
  };
}

const COVERAGE = {
  method: 'lexical' as const,
  searchedFields: ['name', 'filename', 'text'],
  arms: { authored: 1, chats: 2, agreements: 0, tasks: 0, artifactGrants: 0 },
  truncatedArms: [],
  completeness: 'complete' as const,
  limitations: [],
  hasMore: false,
  nextCursor: null,
};

function findResponse(artifacts: unknown[], coverage = COVERAGE) {
  return new Response(
    JSON.stringify({
      artifacts,
      latestSequence: null,
      truncated: [],
      coverage,
    }),
    { status: 200 },
  );
}

/** Labels only — what `GET /context/discovery/available` is allowed to say. */
function discoveryResponse() {
  return new Response(
    JSON.stringify({
      items: [
        {
          type: 'chat',
          label: 'Acme rollout',
          scopeRef: { kind: 'chat', id: 'chat_locked' },
          orgId: 'org_acme',
        },
      ],
    }),
    { status: 200 },
  );
}

describe('AX-04 find (ZIG-1875)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('GETs /artifacts/find with the query and the wake lane', async () => {
    let calledUrl = '';
    let headers: Record<string, string> = {};
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calledUrl = String(url);
      headers = (init?.headers ?? {}) as Record<string, string>;
      return findResponse([{ artifactId: 'art_1' }]);
    });

    const out = await new ArtifactsClient('op', 'agent-1', 'chat_acme').find('rollout plan', {
      limit: 5,
    });
    assert.match(calledUrl, /\/artifacts\/find\?/);
    assert.match(calledUrl, /q=rollout\+plan/);
    assert.match(calledUrl, /limit=5/);
    assert.equal(headers['X-Ziggs-Lane'], 'chat_acme');
    assert.equal(out.coverage.completeness, 'complete');
  });

  /**
   * The narrowing filters the route refuses have no client surface at all, so a
   * caller cannot reach for one and get a plausible answer to a question the
   * server never ran.
   */
  it('offers no reach / authoredBy / chatId knob', () => {
    assert.deepEqual(
      Object.keys(findArtifactsCapability.params).sort(),
      ['before', 'fields', 'includeUnreadable', 'limit', 'q'].sort(),
    );
  });

  it('refuses an empty query rather than listing everything', async () => {
    await assert.rejects(
      () => new ArtifactsClient('op', 'agent-1').find('   '),
      /a query is required/,
    );
  });

  it('keeps matches and the unreadable rows in separate fields', async () => {
    mock.method(globalThis, 'fetch', async (url: string) =>
      String(url).includes('/context/discovery/available')
        ? discoveryResponse()
        : findResponse([]),
    );

    const out = (await findArtifactsCapability.handler({ q: 'rollout' }, env())) as {
      artifacts: unknown[];
      coverage: { searchedFields: string[] };
      notSearched: { count: number; items: { label: string; requestAccess: unknown }[] };
    };

    assert.deepEqual(out.artifacts, []);
    assert.deepEqual(out.coverage.searchedFields, ['name', 'filename', 'text']);
    assert.equal(out.notSearched.count, 1);
    assert.equal(out.notSearched.items[0]?.label, 'Acme rollout');
  });

  /**
   * The locked chat is a continuation, not a dead end: complete args, and a
   * hold naming the human whose authority it is. Contents never travel.
   */
  it('gives a locked chat a valid access-request continuation and no content', async () => {
    mock.method(globalThis, 'fetch', async (url: string) =>
      String(url).includes('/context/discovery/available')
        ? discoveryResponse()
        : findResponse([]),
    );

    const out = (await findArtifactsCapability.handler({ q: 'rollout' }, env())) as {
      notSearched: {
        items: (Record<string, unknown> & {
          requestAccess: {
            tool: string;
            args: Record<string, unknown>;
            ready: boolean;
            hold?: string;
            outcome: string;
          };
        })[];
      };
    };

    const item = out.notSearched.items[0]!;
    // A locked scope travels as a label and its continuation — nothing else.
    assert.deepEqual(Object.keys(item).sort(), [
      'label',
      'orgId',
      'requestAccess',
      'scopeRef',
      'type',
    ]);
    const ask = item.requestAccess;
    assert.equal(ask.tool, 'ziggs_access_explain');
    assert.notEqual(ask.tool, 'ziggs_context_issue_grant');
    assert.deepEqual(ask.args, { chatId: 'chat_locked' });
    // Explain-only: a human issues a root grant. This never widens the scope.
    assert.equal(ask.ready, false);
    assert.equal(ask.hold, 'human_approval');
    assert.equal(ask.outcome, 'pending');
    assert.match(ask.why, /does not request or widen/);
  });

  it('does not spend a discovery call when the search found something', async () => {
    let discoveryCalls = 0;
    mock.method(globalThis, 'fetch', async (url: string) => {
      if (String(url).includes('/context/discovery/available')) {
        discoveryCalls += 1;
        return discoveryResponse();
      }
      return findResponse([{ artifactId: 'art_1' }]);
    });

    const out = (await findArtifactsCapability.handler({ q: 'rollout' }, env())) as Record<
      string,
      unknown
    >;
    assert.equal(discoveryCalls, 0);
    assert.equal('notSearched' in out, false);
  });

  it('leaves unreadable rows off when includeUnreadable is false', async () => {
    let discoveryCalls = 0;
    mock.method(globalThis, 'fetch', async (url: string) => {
      if (String(url).includes('/context/discovery/available')) {
        discoveryCalls += 1;
        return discoveryResponse();
      }
      return findResponse([]);
    });

    const out = (await findArtifactsCapability.handler(
      { q: 'rollout', includeUnreadable: false },
      env(),
    )) as Record<string, unknown>;
    assert.equal(discoveryCalls, 0);
    assert.equal('notSearched' in out, false);
  });

  it('lists the unreadable rows alongside matches when asked', async () => {
    mock.method(globalThis, 'fetch', async (url: string) =>
      String(url).includes('/context/discovery/available')
        ? discoveryResponse()
        : findResponse([{ artifactId: 'art_1' }]),
    );

    const out = (await findArtifactsCapability.handler(
      { q: 'rollout', includeUnreadable: true },
      env(),
    )) as { artifacts: unknown[]; notSearched: { count: number } };
    assert.equal(out.artifacts.length, 1);
    assert.equal(out.notSearched.count, 1);
  });

  /**
   * Discovery is bounded to orgs the agent works in and can refuse. The matches
   * are still the answer; the miss is reported, not thrown.
   */
  it('reports a failed discovery as a limitation, not as a failed search', async () => {
    mock.method(globalThis, 'fetch', async (url: string) =>
      String(url).includes('/context/discovery/available')
        ? new Response('nope', { status: 403 })
        : findResponse([]),
    );

    const out = (await findArtifactsCapability.handler({ q: 'rollout' }, env())) as {
      artifacts: unknown[];
      notSearched: { note: string; items?: unknown[] };
    };
    assert.deepEqual(out.artifacts, []);
    assert.equal(out.notSearched.items, undefined);
    assert.match(out.notSearched.note, /only what was searched/);
  });

  it('carries partial coverage through untouched', async () => {
    mock.method(globalThis, 'fetch', async (url: string) =>
      String(url).includes('/context/discovery/available')
        ? discoveryResponse()
        : findResponse([], {
            ...COVERAGE,
            truncatedArms: ['chats'],
            completeness: 'partial',
            limitations: ['the chats arm hit its cap; older ones were not searched'],
          }),
    );

    const out = (await findArtifactsCapability.handler({ q: 'rollout' }, env())) as {
      coverage: { completeness: string; limitations: string[] };
    };
    assert.equal(out.coverage.completeness, 'partial');
    assert.match(out.coverage.limitations[0]!, /hit its cap/);
  });
});
