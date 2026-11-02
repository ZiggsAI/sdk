import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

/**
 * ziggs_context_snapshot is the delegate's one-shot resource orientation: it wraps
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

  it('GETs /context/snapshot for the resource and returns the snapshot', async () => {
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
    const result = await callZiggsTool(client, 'ziggs_context_snapshot', { taskId: 'task-1', maxMessages: 20 });

    assert.doesNotMatch(callText(result), /isError/);
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? '', /\/context\/snapshot\?/);
    assert.match(calls[0] ?? '', /via=task%3Atask-1/);
    assert.match(calls[0] ?? '', /maxMessages=20/);
    assert.match(callText(result), /isYou/);
    await client.close();
  });

  it('binds work-brief actions and recovery calls without changing the work scope', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      history: [], agreements: [], agents: [], users: [],
      workBrief: { actions: [{ action: 'reply', state: 'needs_decision',
        scope: { kind: 'agreement', id: 'work' },
        recovery: { tool: 'access_request', args: { scopeKind: 'agreement', scopeId: 'work', permission: 'work' }, required: ['reason'] },
      }, { action: 'deliver_result', state: 'not_evaluated', tool: 'task_set_result', args: { taskId: 'task' }, required: ['state', 'result'] }] },
    }), { status: 200 }));
    const client = await connectedClient();
    try {
      const result = await callZiggsTool(client, 'ziggs_context_snapshot', { agreementId: 'work' });
      const data = JSON.parse(callText(result));
      assert.deepEqual(data.workBrief.actions[0].scope, {kind:'agreement',id:'work'});
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
    const result = await callZiggsTool(client, 'ziggs_context_snapshot', { taskId: 'task-1', contextGrantId: 'xgr_9' });

    assert.doesNotMatch(callText(result), /isError/);
    assert.match(calls[0] ?? '', /contextGrantId=xgr_9/);
    await client.close();
  });

  it('reads an agreement or a task by its own scope, never as an address built from its id', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ history: [], agreements: [], agents: [], users: [] }), { status: 200 });
    });
    const client = await connectedClient();
    try {
      await callZiggsTool(client, 'ziggs_context_snapshot', { agreementId: 'agr-1' });
      await callZiggsTool(client, 'ziggs_context_snapshot', { taskId: 'task-1' });
      const [agreement, task] = calls.map((u) => new URL(u).searchParams);
      assert.equal(agreement.get('via'), 'agreement:agr-1');
      assert.equal(agreement.get('agreementId'), 'agr-1');
      assert.equal(task.get('via'), 'task:task-1');
      assert.doesNotMatch(calls.join(' '), /agrn-/);
    } finally { await client.close(); }
  });
  it('reads exact messages and artifacts without requiring work or an address', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: unknown) => {
      calls.push(String(url));
      return Response.json({ history: [], agreements: [], agents: [], users: [] });
    });
    const client = await connectedClient();
    try {
      for (const args of [{ messageId: 'message-only' }, { artifactId: 'artifact-only' }]) {
        const result = await callZiggsTool(client, 'ziggs_context_snapshot', args);
        assert.equal((result as { isError?: boolean }).isError, undefined);
      }
      assert.deepEqual(calls.map((url) => new URL(url).searchParams.get('via')),
        ['message:message-only', 'artifact:artifact-only']);
      const refused = await callZiggsTool(client, 'ziggs_context_snapshot', { messageId: 'message-only', taskId: 'other' });
      assert.equal((refused as { isError?: boolean }).isError, true);
      assert.equal(calls.length, 2);
    } finally { await client.close(); }
  });

});

it('rejects the retired address selector before any HTTP call', async t => {
  const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json({}));
  const client=await connectedClient();
  try {
    const result=await callZiggsTool(client,'ziggs_context_snapshot',{addressId:'old-room'});
    assert.equal((result as {isError?:boolean}).isError,true);
    assert.equal(fetch.mock.callCount(),0);
  } finally {await client.close();}
});
