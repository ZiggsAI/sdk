import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ContextGrantsClient } from '../src/http/ContextGrantsClient.js';

describe('ContextGrantsClient', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('issueGrant POSTs scope payload', async () => {
    let body = '';
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          grant: {
            grantId: 'xgr_1',
            issuerId: 'u1',
            holderId: 'a2',
            scopeKind: 'chat',
            scopeId: 'c1',
            temporal: 'from-now',
            watermarkAt: '2020-01-01T00:00:00.000Z',
            parentGrantId: null,
            expiresAt: null,
            revoked: false,
            createdAt: '2020-01-01T00:00:00.000Z',
          },
        }),
        { status: 201 },
      );
    });
    const client = new ContextGrantsClient('op', 'agent-a', 'http://test');
    const grant = await client.issueGrant({
      holderId: 'a2',
      scope: { kind: 'chat', id: 'c1' },
      temporal: 'from-now',
    });
    assert.equal(grant.grantId, 'xgr_1');
    assert.match(body, /"holderId":"a2"/);
  });

  it('delegateGrant POSTs to /delegate', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          grant: {
            grantId: 'xgr_child',
            issuerId: 'u1',
            holderId: 'a3',
            scopeKind: 'chat',
            scopeId: 'c1',
            temporal: 'from-now',
            watermarkAt: '2020-01-01T00:00:00.000Z',
            parentGrantId: 'xgr_parent',
            expiresAt: null,
            revoked: false,
            createdAt: '2020-01-01T00:00:00.000Z',
          },
        }),
        { status: 201 },
      );
    });
    const client = new ContextGrantsClient('op', 'agent-a', 'http://test');
    await client.delegateGrant('xgr_parent', {
      holderId: 'a3',
      scope: { kind: 'chat', id: 'c1' },
      temporal: 'from-now',
    });
    assert.match(calls[0] ?? '', /\/context\/grants\/xgr_parent\/delegate$/);
  });

  it('getReach GETs /context/grants/:id/reach and normalizes the envelope', async () => {
    const calls: Array<{ url: string; method?: string; auth?: string; agent?: string }> = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init?.method,
        auth: headers['Authorization'],
        agent: headers['X-Agent-Id'],
      });
      return new Response(
        JSON.stringify({
          grantId: 'xgr_org',
          scope: { kind: 'org', id: 'org_acme' },
          chats: [{ id: 'c1', label: 'Chat c1' }],
          agreements: [{ id: 'a1', label: 'Ship it' }],
          truncatedChats: 3,
          truncatedAgreements: 0,
        }),
        { status: 200 },
      );
    });
    const client = new ContextGrantsClient('op', 'agent-a', 'http://test');
    const reach = await client.getReach('xgr_org');

    assert.deepEqual(reach, {
      grantId: 'xgr_org',
      scope: { kind: 'org', id: 'org_acme' },
      chats: [{ id: 'c1', label: 'Chat c1' }],
      agreements: [{ id: 'a1', label: 'Ship it' }],
      truncatedChats: 3,
      truncatedAgreements: 0,
    });
    assert.match(calls[0].url, /\/context\/grants\/xgr_org\/reach$/);
    assert.equal(calls[0].method ?? 'GET', 'GET');
    assert.equal(calls[0].auth, 'Bearer op');
    assert.equal(calls[0].agent, 'agent-a');
  });

  it('getReach throws on a malformed (scope-less) response', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ grantId: 'xgr_x' }), { status: 200 }),
    );
    const client = new ContextGrantsClient('op', 'agent-a', 'http://test');
    await assert.rejects(() => client.getReach('xgr_x'), /expected \{ scope/);
  });

  it('shareArtifact POSTs /context/artifacts/:id/share and returns granted', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          grant: {
            grantId: 'xgr_share',
            issuerId: 'a1',
            holderId: 'a2',
            parentGrantId: null,
            agreementId: null,
            scope: { kind: 'artifact', id: 'art_1' },
            caveats: [],
            revoked: false,
            expiresAt: null,
            createdAt: '2020-01-01T00:00:00.000Z',
            health: 'active',
          },
        }),
        { status: 201 },
      );
    });
    const client = new ContextGrantsClient('op', 'agent-a', 'http://test');
    const result = await client.shareArtifact('art_1', { holderId: 'a2' });
    assert.equal(result.status, 'granted');
    if (result.status === 'granted') {
      assert.equal(result.grant.grantId, 'xgr_share');
    }
    assert.match(calls[0] ?? '', /\/context\/artifacts\/art_1\/share$/);
  });

  it('shareArtifact returns pending_approval when the owner must consent', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            status: 'pending_approval',
            agreementId: 'agr_share',
            ownerId: 'u_owner',
          }),
          { status: 202 },
        ),
    );
    const client = new ContextGrantsClient('op', 'agent-a', 'http://test');
    const result = await client.shareArtifact('art_1', { holderId: 'a_stranger' });
    assert.deepEqual(result, {
      status: 'pending_approval',
      agreementId: 'agr_share',
      ownerId: 'u_owner',
    });
  });

  it('delegateGrant returns pending_approval through the shared parser', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            status: 'pending_approval',
            agreementId: 'agr_del',
            ownerId: 'u_owner',
          }),
          { status: 202 },
        ),
    );
    const client = new ContextGrantsClient('op', 'agent-a', 'http://test');
    const result = await client.delegateGrant('xgr_parent', {
      holderId: 'a3',
      holderKind: 'agent',
      scope: { kind: 'chat', id: 'c1' },
      temporal: 'from-now',
    });
    assert.equal(result.status, 'pending_approval');
    if (result.status === 'pending_approval') {
      assert.equal(result.agreementId, 'agr_del');
    }
  });
});
