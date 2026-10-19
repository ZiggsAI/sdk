import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

/**
 * ziggs_context_snapshot is the delegate's one-shot chat orientation: it wraps
 * GET /context/snapshot (grant-fenced server-side composition of history +
 * agreements + roster). It replaced ziggs_get_scope, which exposed the raw
 * unfenced /scope neighborhood lookup.
 */
async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function callText(result: unknown): string {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content.map((c) => c.text ?? '').join('');
}

describe('ziggs_context_snapshot', () => {
  afterEach(() => mock.restoreAll());

  it('GETs /context/snapshot for the chat and returns the snapshot', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          history: [],
          agreements: [],
          agents: [{ agentId: 'agent-1', role: 'self', isYou: true }],
          users: [],
          latestSequence: null,
        }),
        { status: 200 },
      );
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_context_snapshot', { chatId: 'chat-1', maxMessages: 20 });

    assert.doesNotMatch(callText(result), /isError/);
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? '', /\/context\/snapshot\?/);
    assert.match(calls[0] ?? '', /via=chat%3Achat-1/);
    assert.match(calls[0] ?? '', /maxMessages=20/);
    assert.match(callText(result), /isYou/);
    await client.close();
  });

  it('binds work-brief actions and recovery calls without changing the work scope', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      history: [], agreements: [], agents: [], users: [],
      workBrief: { actions: [{ action: 'reply', state: 'needs_decision',
        scope: { kind: 'chat', id: 'room', agreementId: 'work' },
        recovery: { tool: 'access_request', args: { scopeKind: 'chat', scopeId: 'room', permission: 'reply' }, required: ['reason'] },
      }, { action: 'deliver_result', state: 'not_evaluated', tool: 'task_set_result', args: { taskId: 'task' }, required: ['state', 'result'] }] },
    }), { status: 200 }));
    const client = await connectedClient();
    try {
      const result = await callZiggsTool(client, 'ziggs_context_snapshot', { chatId: 'room', agreementId: 'work' });
      const data = JSON.parse(callText(result));
      assert.equal(data.workBrief.actions[0].scope.agreementId, 'work');
      assert.equal(data.workBrief.actions[0].recovery.tool, 'ziggs_access_request');
      assert.equal(data.workBrief.actions[1].tool, 'ziggs_task_set_result');
    } finally { await client.close(); }
  });

  it('threads contextGrantId into the fenced read', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ history: [], agreements: [], agents: [], users: [] }),
        { status: 200 },
      );
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_context_snapshot', { chatId: 'chat-1', contextGrantId: 'xgr_9' });

    assert.doesNotMatch(callText(result), /isError/);
    assert.match(calls[0] ?? '', /contextGrantId=xgr_9/);
    await client.close();
  });
});
