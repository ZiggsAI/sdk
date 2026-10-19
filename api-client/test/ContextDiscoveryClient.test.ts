import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ContextDiscoveryClient } from '../src/http/ContextDiscoveryClient.js';

describe('ContextDiscoveryClient', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('requires operatorKey but not agentId (agent-scoped keys)', () => {
    assert.throws(() => new ContextDiscoveryClient('', 'a'), /operatorKey/);
    assert.doesNotThrow(() => new ContextDiscoveryClient('op'));
  });

  it('discoverGrantable hits /context/discovery/available with auth headers', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(
        JSON.stringify({
          items: [
            {
              type: 'chat',
              label: 'Chat abc',
              scopeRef: { kind: 'chat', id: 'c1' },
              orgId: 'org1',
            },
          ],
        }),
        { status: 200 },
      );
    });

    const client = new ContextDiscoveryClient('op_test', 'agent-a', 'http://test');
    const items = await client.discoverGrantable();

    assert.equal(items.length, 1);
    assert.equal(items[0]?.scopeRef.id, 'c1');
    assert.match(calls[0]?.url ?? '', /\/context\/discovery\/available$/);
    assert.equal(calls[0]?.headers.Authorization, 'Bearer op_test');
    assert.equal(calls[0]?.headers['X-Agent-Id'], 'agent-a');
  });

  it('discoverGrantable re-shapes to the whitelist (no leaked fields)', async () => {
    mock.method(globalThis, 'fetch', async () => {
      return new Response(
        JSON.stringify({
          items: [
            {
              type: 'chat',
              label: 'Chat abc',
              scopeRef: { kind: 'chat', id: 'c1' },
              orgId: 'org1',
              // an over-broad server could add extra fields — must be dropped
              secret: 'should-not-appear',
            },
          ],
        }),
        { status: 200 },
      );
    });

    const client = new ContextDiscoveryClient('op_test', undefined, 'http://test');
    const items = await client.discoverGrantable();
    assert.deepEqual(Object.keys(items[0]!).sort(), [
      'label',
      'orgId',
      'scopeRef',
      'type',
    ]);
  });

  // ZIG-927: agreements and connections ride the same wire; reshape must keep
  // the whitelist and drop any extra fields (e.g. a leaked token on connection).
  it('reshapes agreement and connection items to the whitelist', async () => {
    mock.method(globalThis, 'fetch', async () => {
      return new Response(
        JSON.stringify({
          items: [
            {
              type: 'agreement',
              label: 'Ship the widget',
              scopeRef: { kind: 'agreement', id: 'agr1' },
              orgId: 'org1',
              terms: 'should-not-appear',
            },
            {
              type: 'connection',
              label: 'jira',
              scopeRef: { kind: 'connection', id: 'conn1' },
              orgId: 'org1',
              accessToken: 'should-not-appear',
            },
          ],
        }),
        { status: 200 },
      );
    });

    const client = new ContextDiscoveryClient('op_test', undefined, 'http://test');
    const items = await client.discoverGrantable();
    assert.equal(items.length, 2);
    assert.equal(items[0]?.type, 'agreement');
    assert.equal(items[0]?.scopeRef.kind, 'agreement');
    assert.equal(items[1]?.type, 'connection');
    assert.equal(items[1]?.scopeRef.kind, 'connection');
    assert.equal(items[1]?.scopeRef.id, 'conn1');
    for (const it of items) {
      assert.deepEqual(Object.keys(it).sort(), [
        'label',
        'orgId',
        'scopeRef',
        'type',
      ]);
    }
  });
});
