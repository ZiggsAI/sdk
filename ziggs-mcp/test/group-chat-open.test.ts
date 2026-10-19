import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

test('the registered chat_open tool creates groups and admits people to a named room', async (t) => {
  t.after(() => mock.restoreAll());
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' },
    { debugTools: false } as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'group-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());
  const requests: unknown[] = [];
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.ok(String(url).endsWith('/chats'));
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ chatId: 'group', reused: requests.length > 1 }));
  });
  for (const args of [
    { participantIds: ['itay', 'paul'], idempotencyKey: 'q3' },
    { chatId: 'group', participantIds: ['paul'] },
  ]) {
    const result = await callZiggsTool(client, 'ziggs_chat_open', args);
    assert.notEqual((result as { isError?: boolean }).isError, true, JSON.stringify(result));
    assert.deepEqual(requests.at(-1), args);
  }
});

test('a list-of-strings parameter also takes one string, as a list of one', async (t) => {
  t.after(() => mock.restoreAll());
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' },
    { debugTools: false } as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'list-param-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());
  const urls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ items: [], nextCursor: null }));
  });
  for (const scopeKind of ['chat', ['chat']]) {
    const result = await callZiggsTool(client, 'ziggs_grant_list', { scopeKind });
    assert.notEqual((result as { isError?: boolean }).isError, true, JSON.stringify(result));
    assert.match(urls.at(-1)!, /scopeKind=chat/);
  }
});
