import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextDelegateCapability,
  findArtifactsCapability,
  nextCall,
  shareArtifactCapability,
} from '../src/index.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';

function env(surface: 'mcp' | 'sdk' = 'mcp'): CapabilityEnv {
  return {
    creds: { operatorKey: 'op', agentId: 'agent-1' },
    surface,
  };
}

describe('AX-06 access request receipts', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('binds share and delegate to the existing HTTP paths', () => {
    const share = nextCall(
      env('mcp'),
      'artifact_share',
      { artifactId: 'art_1', holderId: 'agt_peer' },
      'share one artifact',
    );
    assert.equal(share.ready, true);
    assert.deepEqual(share.http, {
      method: 'POST',
      path: '/context/artifacts/art_1/share',
    });

    const delegate = nextCall(
      env('sdk'),
      'context_delegate',
      {
        parentGrantId: 'xgr_1',
        holderId: 'agt_peer',
        scopeKind: 'artifact',
        scopeId: 'art_1',
        temporal: 'from-start',
      },
      'narrow onward',
    );
    assert.equal(delegate.ready, true);
    assert.deepEqual(delegate.http, {
      method: 'POST',
      path: '/context/grants/xgr_1/delegate',
    });
  });

  it('sends Idempotency-Key on share and keeps pending as requested', async () => {
    let headers: Record<string, string> = {};
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          status: 'pending_approval',
          agreementId: 'agr_share',
          ownerId: 'user_owner',
        }),
        { status: 200 },
      );
    });

    const out = (await shareArtifactCapability.handler(
      { artifactId: 'art_1', holderId: 'agt_stranger', idempotencyKey: 'share-1' },
      env(),
    )) as {
      ok: boolean;
      outcome: string;
      state: string;
      recoverable: boolean;
      agreementId: string;
    };

    assert.equal(headers['Idempotency-Key'], 'share-1');
    assert.equal(out.ok, false);
    assert.equal(out.outcome, 'pending');
    assert.equal(out.state, 'requested');
    assert.equal(out.recoverable, true);
    assert.equal(out.agreementId, 'agr_share');
  });

  it('sends Idempotency-Key on delegate and does not read as granted', async () => {
    let headers: Record<string, string> = {};
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          status: 'pending_approval',
          agreementId: 'agr_del',
          ownerId: 'user_other',
        }),
        { status: 200 },
      );
    });

    const out = (await contextDelegateCapability.handler(
      {
        parentGrantId: 'xgr_1',
        holderId: 'agt_peer',
        scopeKind: 'artifact',
        scopeId: 'art_1',
        temporal: 'from-start',
        idempotencyKey: 'del-1',
      },
      env('sdk'),
    )) as { status: string; state: string; outcome: string; recoverable: boolean };

    assert.equal(headers['Idempotency-Key'], 'del-1');
    assert.equal(out.status, 'pending_approval');
    assert.equal(out.state, 'requested');
    assert.equal(out.outcome, 'pending');
    assert.equal(out.recoverable, true);
  });

  it('never advertises issuing a root grant from a locked find row', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      if (String(url).includes('/context/discovery/available')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                type: 'chat',
                label: 'Locked',
                scopeRef: { kind: 'chat', id: 'chat_locked' },
                orgId: 'org_acme',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          artifacts: [],
          latestSequence: null,
          truncated: [],
          coverage: {
            method: 'lexical',
            searchedFields: ['name'],
            arms: {},
            truncatedArms: [],
            completeness: 'complete',
            limitations: [],
            hasMore: false,
            nextCursor: null,
          },
        }),
        { status: 200 },
      );
    });

    const out = (await findArtifactsCapability.handler({ q: 'x' }, env())) as {
      notSearched: { items: { requestAccess: { tool: string; why: string } }[] };
    };
    const ask = out.notSearched.items[0]!.requestAccess;
    assert.equal(ask.tool, 'ziggs_access_explain');
    assert.match(ask.why, /never|does not request or widen/i);
  });
});
