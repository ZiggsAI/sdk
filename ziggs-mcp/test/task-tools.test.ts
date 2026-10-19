import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

/**
 * ZIG-586 — task-level assignee for explicit delegation. ziggs_task_create
 * gains an optional assigneeId param, ziggs_task_list gains assignedTo /
 * assignedToMe filters. Server-side validation (must be a party to the
 * agreement) is out of scope here — we only verify the MCP layer forwards
 * the right fields to the api-client HTTP calls.
 */
async function connectedClient(agentId = 'agent-1'): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId } as unknown as Creds,
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

describe('ziggs_task_create (ZIG-586 assigneeId)', () => {
  afterEach(() => mock.restoreAll());

  it('forwards assigneeId to the create-task HTTP call', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body ?? '{}'));
      return new Response(
        JSON.stringify({ task: { taskId: 't-1', state: 'active', assigneeId: 'agent-2' } }),
        { status: 200 },
      );
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_task_create', {
        agreementId: 'agr-1',
        description: 'do the thing',
        assigneeId: 'agent-2',
      });

    assert.equal((capturedBody as unknown as Record<string, unknown>)['assigneeId'], 'agent-2');
    const parsed = JSON.parse(callText(result));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.task.assigneeId, 'agent-2');
    await client.close();
  });

  it('omits assigneeId when not provided (backward compatible)', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body ?? '{}'));
      return new Response(JSON.stringify({ task: { taskId: 't-2', state: 'active' } }), { status: 200 });
    });

    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_task_create', { agreementId: 'agr-1', description: 'do the thing' });

    assert.equal((capturedBody as unknown as Record<string, unknown>)['assigneeId'], undefined);
    await client.close();
  });

  it('exposes assigneeId in the tool schema with a delegation-focused description', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const tool = tools.find((t) => t.name === 'ziggs_task_create');
    assert.ok(tool, 'ziggs_task_create should be registered');
    const props = (tool?.inputSchema as { properties?: Record<string, { description?: string }> })?.properties;
    assert.ok(props?.['assigneeId'], 'assigneeId should be in the input schema');
    assert.match(props!['assigneeId'].description ?? '', /assign/i);
    await client.close();
  });
});

describe('ziggs_task_create (ZIG-734 inputArtifactIds)', () => {
  afterEach(() => mock.restoreAll());

  it('forwards inputArtifactIds to the create-task HTTP call', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body ?? '{}'));
      return new Response(JSON.stringify({ task: { taskId: 't-3', state: 'active' } }), { status: 200 });
    });

    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_task_create', {
        agreementId: 'agr-1',
        description: 'step 2',
        inputArtifactIds: ['art_step1', 'art_step1'],
      });

    assert.deepEqual(
      (capturedBody as unknown as Record<string, unknown>)['inputArtifactIds'],
      ['art_step1', 'art_step1'],
    );
    await client.close();
  });
});

describe('ziggs_task_list (ZIG-586 assignedTo / assignedToMe)', () => {
  afterEach(() => mock.restoreAll());

  it('forwards assignedTo as a query param', async () => {
    let capturedUrl: string | null = null;
    mock.method(globalThis, 'fetch', async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ tasks: [], hasMore: false, nextCursor: null }), { status: 200 });
    });

    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_task_list', { assignedTo: 'agent-9' });

    const u = new URL(capturedUrl!);
    assert.equal(u.searchParams.get('assignedTo'), 'agent-9');
    await client.close();
  });

  it('assignedToMe asks the server for the acting assistant', async () => {
    let capturedUrl: string | null = null;
    mock.method(globalThis, 'fetch', async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ tasks: [], hasMore: false, nextCursor: null }), { status: 200 });
    });

    const client = await connectedClient('agent-self-42');
    await callZiggsTool(client, 'ziggs_task_list', { assignedToMe: true });

    const u = new URL(capturedUrl!);
    assert.equal(u.searchParams.get('assignedTo'), 'self');
    await client.close();
  });

  it('assignedToMe takes precedence over assignedTo when both are set', async () => {
    let capturedUrl: string | null = null;
    mock.method(globalThis, 'fetch', async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ tasks: [], hasMore: false, nextCursor: null }), { status: 200 });
    });

    const client = await connectedClient('agent-self-42');
    await callZiggsTool(client, 'ziggs_task_list', { assignedTo: 'someone-else', assignedToMe: true });

    const u = new URL(capturedUrl!);
    assert.equal(u.searchParams.get('assignedTo'), 'self');
    await client.close();
  });

  it('omits assignedTo when neither filter is provided', async () => {
    let capturedUrl: string | null = null;
    mock.method(globalThis, 'fetch', async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ tasks: [], hasMore: false, nextCursor: null }), { status: 200 });
    });

    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_task_list', {});

    const u = new URL(capturedUrl!);
    assert.equal(u.searchParams.has('assignedTo'), false);
    await client.close();
  });
});

describe('ziggs_task_get (ZIG-940 fetch one task by id)', () => {
  afterEach(() => mock.restoreAll());

  it('fetches GET /tasks/:id and returns the task', async () => {
    let capturedUrl: string | null = null;
    let capturedMethod: string | undefined;
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method;
      return new Response(
        JSON.stringify({ task: { taskId: 'task_abc', state: 'active', description: 'do the thing' } }),
        { status: 200 },
      );
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_task_get', { taskId: 'task_abc' });

    assert.match(capturedUrl!, /\/tasks\/task_abc$/);
    assert.ok(capturedMethod === undefined || capturedMethod === 'GET');
    const parsed = JSON.parse(callText(result));
    assert.equal(parsed.task.taskId, 'task_abc');
    assert.equal(parsed.task.description, 'do the thing');
    await client.close();
  });

  it('is registered with a taskId param', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const tool = tools.find((t) => t.name === 'ziggs_task_get');
    assert.ok(tool, 'ziggs_task_get should be registered');
    const props = (tool?.inputSchema as { properties?: Record<string, unknown> })?.properties;
    assert.ok(props?.['taskId'], 'taskId should be in the input schema');
    await client.close();
  });
});

describe('ziggs_task_update_steps (ZIG-1443 named-step progress)', () => {
  afterEach(() => mock.restoreAll());

  it('PATCHes /plan with patches only — not a full step list', async () => {
    let capturedUrl: string | null = null;
    let capturedMethod: string | undefined;
    let capturedBody: Record<string, unknown> | null = null;
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method;
      capturedBody = JSON.parse(String(init.body ?? '{}'));
      return new Response(
        JSON.stringify({
          ok: true,
          status: 'updated',
          taskId: 'task_abc',
          state: 'active',
          patchedCount: 1,
          structureChanged: false,
        }),
        { status: 200 },
      );
    });

    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_task_update_steps', {
      taskId: 'task_abc',
      steps: [{ stepId: 's3', status: 'completed', result: 'done' }],
    });

    assert.equal(capturedMethod, 'PATCH');
    assert.match(capturedUrl!, /\/tasks\/task_abc\/plan$/);
    assert.deepEqual(capturedBody, {
      patches: [{ stepId: 's3', status: 'completed', result: 'done' }],
    });
    assert.equal('steps' in (capturedBody ?? {}), false);
    const parsed = JSON.parse(callText(result));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.patchedCount, 1);
    await client.close();
  });
});

describe('ziggs_task_acknowledge_control', () => {
  afterEach(() => mock.restoreAll());
  it('forwards the exact request and support verdict using the authenticated runtime', async () => {
    let captured: { url: string; body: unknown; headers: unknown } | undefined;
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init.body)), headers: init.headers };
      return new Response(JSON.stringify({ ok: true, taskId: 't1', state: 'active', control: { status: 'acknowledged' } }), { status: 200 });
    });
    const client = await connectedClient('worker-agent');
    const requestId = 'edfe5e5c-b55a-4e4e-949a-45c95d96c2b7';
    const result = await callZiggsTool(client, 'ziggs_task_acknowledge_control', { taskId: 't1', requestId, supported: true });
    assert.match(captured!.url, /\/tasks\/t1\/control\/ack$/);
    assert.deepEqual(captured!.body, { requestId, supported: true });
    assert.match(callText(result), /acknowledged/);
    await client.close();
  });
});
