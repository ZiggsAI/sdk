import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GrantsClient } from '@ziggs-ai/api-client';
import { ContextReadClient } from '@ziggs-ai/api-client';
import { InboxClient } from '@ziggs-ai/api-client';

describe('ZIG-432 MCP client wiring', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('grant listing hits /grants only (no content)', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ items: [], nextCursor: null, hasMore: false }),
        { status: 200 },
      );
    });
    const client = new GrantsClient('op', 'agent', 'http://test');
    await client.listGrants({ scopeKind: ['chat', 'agreement', 'org'] });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/grants\?/);
    assert.doesNotMatch(calls[0], /\/context\/read$/);
  });

  it('read uses split /context/read/:type (not dead aggregator)', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          type: 'artifacts',
          via: { kind: 'chat', id: 'c1' },
          items: [],
          hasMore: false,
          nextCursor: null,
        }),
        { status: 200 },
      );
    });
    const client = new ContextReadClient('op', 'agent', 'http://test');
    await client.read('artifacts', { via: 'chat:c1' });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/context\/read\/artifacts\?via=chat%3Ac1/);
    assert.doesNotMatch(calls[0], /\/context\/read\?/);
  });

  it('inbox hits /inbox (ZIG-491)', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          asOf: '2026-06-15T00:00:00.000Z',
          scopes: [],
          truncatedScopes: 0,
          countCap: 100,
          proposalsAwaitingMe: [],
          truncatedProposals: 0,
        }),
        { status: 200 },
      );
    });
    const client = new InboxClient('op', 'agent', 'http://test');
    await client.getInbox();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/inbox$/);
  });
});
