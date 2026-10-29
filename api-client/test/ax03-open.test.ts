import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContextOpenClient,
  nextCall,
  openCapability,
  contextReadCapability,
  accessExplainCapability,
  accessRequestCapability,
} from '../src/index.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';

function env(surface: 'mcp' | 'sdk' = 'mcp'): CapabilityEnv {
  return {
    creds: { operatorKey: 'op', agentId: 'agent-1', laneId: 'chat_acme' },
    surface,
  };
}

describe('AX-03 open (ZIG-1874)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  for (const capability of [openCapability, accessExplainCapability]) {
    it(`${capability.key} preserves the server-selected OAuth assistant`, async () => {
      const operatorKey = `header.${Buffer.from(JSON.stringify({ connectionClientId: 'client-1' })).toString('base64url')}.signature`;
      mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
        actingAgentId: 'assistant-2',
        outcome: 'ok', ref: { kind: 'chat', id: 'chat_1' },
        access: { summary: 'Readable' }, workContext: { laneId: null },
      })));
      const result = await capability.handler({ ref: 'chat_1' }, {
        creds: { operatorKey, agentId: '' }, surface: 'mcp',
      }) as Record<string, unknown>;
      assert.equal(result.actingAgentId, 'assistant-2');
    });
  }

  it('omits unknown OAuth identity on an older server instead of reporting an empty id', async () => {
    const operatorKey = `header.${Buffer.from(JSON.stringify({ connectionClientId: 'client-1' })).toString('base64url')}.signature`;
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      outcome: 'hidden', ref: { kind: 'chat', id: 'chat_1' },
      access: { summary: 'Unavailable' }, workContext: { laneId: null },
    })));
    const result = await openCapability.handler({ ref: 'chat_1' }, {
      creds: { operatorKey, agentId: '' }, surface: 'mcp',
    }) as Record<string, unknown>;
    assert.equal('actingAgentId' in result, false);
  });

  it('access requests preserve the backend-selected assistant without claiming access', async () => {
    const operatorKey = `header.${Buffer.from(JSON.stringify({ connectionClientId: 'client-1' })).toString('base64url')}.signature`;
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      status: 'pending_approval', agreementId: 'request-1', accessGranted: false,
      actingAgentId: 'assistant-2', scope: { kind: 'chat', id: 'chat_1' },
    })));
    const result = await accessRequestCapability.handler({
      scopeKind: 'chat', scopeId: 'chat_1', reason: 'Read project history', recipientId: 'user-1',
    }, { creds: { operatorKey, agentId: '' }, surface: 'mcp' }) as Record<string, unknown>;
    assert.equal(result.actingAgentId, 'assistant-2');
    assert.equal(result.accessGranted, false);
    assert.equal(result.outcome, 'pending');
  });

  it('POSTs /context/open with an ordinary artifactId — no via, type, or grant id', async () => {
    let calledUrl = '';
    let calledInit: RequestInit | undefined;
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calledUrl = String(url);
      calledInit = init;
      return new Response(
        JSON.stringify({
          outcome: 'ok',
          ref: { kind: 'artifact', id: 'art_1' },
          access: {
            summary: 'You can read this. Reading does not let you reply.',
            document: { empty: false, extractionStatus: 'ok' },
          },
          workContext: { laneId: 'chat_acme' },
          page: {
            type: 'artifacts',
            via: { kind: 'artifact', id: 'art_1' },
            items: [{ artifactId: 'art_1', text: 'hello' }],
            hasMore: false,
            nextCursor: null,
          },
        }),
        { status: 200 },
      );
    });

    const client = new ContextOpenClient('op', 'agent-1', 'http://test');
    const out = await client.open({ artifactId: 'art_1' });
    assert.match(calledUrl, /\/context\/open$/);
    assert.equal(calledInit?.method, 'POST');
    const body = JSON.parse(String(calledInit?.body));
    assert.deepEqual(body, { artifactId: 'art_1' });
    assert.equal('via' in body, false);
    assert.equal('type' in body, false);
    assert.equal('contextGrantId' in body, false);
    assert.equal(out.outcome, 'ok');
  });

  it('refuses a client call that reconstructs more than one id', async () => {
    const client = new ContextOpenClient('op', 'agent-1', 'http://test');
    await assert.rejects(
      () => client.open({ artifactId: 'art_1', chatId: 'chat_1' }),
      /exactly one/,
    );
  });

  it('capability handler does not send grant_list or via', async () => {
    let body: Record<string, unknown> = {};
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          outcome: 'hidden',
          ref: { kind: 'artifact', id: 'art_x' },
          access: {
            summary: 'This resource is not available.',
          },
          workContext: { laneId: null },
        }),
        { status: 200 },
      );
    });
    const result = (await openCapability.handler(
      { ref: 'art_x' },
      env('mcp'),
    )) as Record<string, unknown>;
    assert.deepEqual(body, { ref: 'art_x' });
    assert.equal(result.outcome, 'hidden');
    assert.deepEqual(result.actions, []);
    assert.match(String(result.requestAccessHint), /ziggs_access_request/);
    assert.match(String(result.requestAccessHint), /does not confirm existence or ownership/);
  });

  it('hidden and unknown references get the same conditional guidance with no extra request', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      const { ref: artifactId } = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        outcome: 'hidden', ref: { kind: 'artifact', id: artifactId },
        access: { summary: 'This resource is not available.' },
        workContext: { laneId: null },
      }), { status: 200 });
    });
    const hidden = await openCapability.handler({ ref: 'art_private' }, env()) as Record<string, unknown>;
    const unknown = await openCapability.handler({ ref: 'art_missing' }, env()) as Record<string, unknown>;
    assert.equal(hidden.requestAccessHint, unknown.requestAccessHint);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => url.endsWith('/context/open')));
    assert.deepEqual(hidden.actions, []);
    assert.deepEqual(unknown.actions, []);
    assert.equal('page' in hidden, false);
    const sdk = await openCapability.handler({ ref: 'art_private' }, env('sdk')) as Record<string, unknown>;
    assert.match(String(sdk.requestAccessHint), /access_request/);
    assert.doesNotMatch(String(sdk.requestAccessHint), /ziggs_/);
  });

  it('unreadable names an owner-decision and does not execute a request', async () => {
    mock.method(globalThis, 'fetch', async () => {
      return new Response(
        JSON.stringify({
          outcome: 'unreadable',
          ref: { kind: 'artifact', id: 'art_1' },
          access: {
            summary: 'You cannot read this.',
            continuation: {
              kind: 'owner_decision',
              summary: 'Ask the owner. This call does not request or approve anything.',
            },
          },
          workContext: { laneId: 'chat_acme' },
        }),
        { status: 200 },
      );
    });
    const result = (await accessExplainCapability.handler(
      { ref: 'art_1' },
      env('mcp'),
    )) as {
      outcome: string;
      actions: unknown[];
      access: { continuation?: { kind: string; summary: string } };
    };
    assert.equal(result.outcome, 'unreadable');
    assert.deepEqual(result.actions, [{ kind: 'request_access', tool: 'ziggs_access_request', args: { scopeKind: 'artifact', scopeId: 'art_1', permission: 'read', durationHours: 24 }, requiredInput: ['reason', 'chatId', 'recipientId'], effect: 'request_only', requiresApproval: true }]);
    assert.equal(result.access.continuation?.kind, 'owner_decision');
    assert.match(result.access.continuation?.summary ?? '', /does not request or approve/);
  });

  it('nextCall binds open to POST /context/open on both surfaces', () => {
    const mcp = nextCall(env('mcp'), 'open', { artifactId: 'art_1' }, 'open it');
    const sdk = nextCall(env('sdk'), 'open', { artifactId: 'art_1' }, 'open it');
    assert.equal(mcp.tool, 'ziggs_open');
    assert.equal(sdk.tool, 'open');
    assert.deepEqual(mcp.http, { method: 'POST', path: '/context/open' });
    assert.equal(mcp.ready, true);
  });
});


describe('resource action projection', () => {
  for (const surface of ['sdk', 'mcp'] as const) {
    it(`preserves server decisions and binds action/recovery calls on ${surface}`, async () => {
      const savedFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({ outcome: 'ok',
        ref: { kind: 'chat', id: 'room' }, workContext: { laneId: 'work-lane' },
        access: { summary: 'Read available.' },
        actions: [
          { action: 'read', state: 'available', tool: 'open', args: { chatId: 'room' } },
          { action: 'reply', state: 'needs_decision', scope: { kind: 'chat', id: 'room', agreementId: 'work' },
            recovery: { tool: 'access_request', args: { scopeKind: 'chat', scopeId: 'room', permission: 'reply' }, required: ['reason'] } },
        ],
      }), { status: 200 });
      try {
        const result = await accessExplainCapability.handler({ ref: 'room' }, env(surface)) as any;
        const prefix = surface === 'mcp' ? 'ziggs_' : '';
        assert.equal(result.actions[0].tool, `${prefix}open`);
        assert.equal(result.actions[1].state, 'needs_decision');
        assert.equal(result.actions[1].scope.agreementId, 'work');
        assert.equal(result.actions[1].recovery.tool, `${prefix}access_request`);
        assert.deepEqual(result.actions[1].recovery.required, ['reason']);
        assert.equal(result.workContext.laneId, 'work-lane');
      } finally { globalThis.fetch = savedFetch; }
    });
  }
});

describe('ZIG-2113 — which input opens an agreement, and which filters a chat', () => {
  it('open accepts ref and cached typed references, and leaves filtering to context_read', () => {
    assert.ok(openCapability.params?.['agreementId']);
    assert.ok(openCapability.params?.['chatId']);
    assert.match(String(openCapability.params?.['ref']?.description), /T7K2QXD/);
    // It says where the filter lives instead.
    assert.match(String(openCapability.descriptions.sdk), /context_read with type=messages, via=chat:<id> and its agreement filter/);
  });

  it('refuses a mistyped handle with no call, and sends any other id to the server', async () => {
    const calls: unknown[] = [];
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ outcome: 'hidden', ref: { kind: 'chat', id: 'x' }, access: { summary: 'Unavailable' }, workContext: { laneId: null } }), { status: 200 });
    });
    await assert.rejects(openCapability.handler({ ref: 'T7K2QX0' }, env()), /check letter/);
    assert.equal(calls.length, 0);
    await openCapability.handler({ ref: 'probe_seo-blog_1787188068922' }, env());
    assert.deepEqual(calls, [{ ref: 'probe_seo-blog_1787188068922' }]);
  });

  it('context_read keeps agreementId as the message filter', () => {
    assert.match(
      String(contextReadCapability.params?.['agreementId']?.description),
      /Filter message history to this exact work agreement/,
    );
  });
});
