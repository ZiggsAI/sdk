import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mcpDescription, recordArtifactCapability, type Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import { PROTOCOL } from '../src/protocol/delegateProtocol.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

/**
 * ZIG-560 (revised A4): always-on teaching of the result slot on
 * ziggs_artifact_record — description + success path — not wrong-slot detection.
 */
async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent' } as unknown as Creds,
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

describe('ziggs_artifact_record teaches the result slot (ZIG-560)', () => {
  afterEach(() => mock.restoreAll());

  it('description names the result slot (sourced from the shared rule)', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const recordArtifact = tools.find((t) => t.name === 'ziggs_artifact_record');
    assert.ok(recordArtifact);
    const description = recordArtifact.description ?? '';
    assert.equal(
      description,
      mcpDescription(recordArtifactCapability.names.mcp, recordArtifactCapability.annotation),
    );
    assert.match(description, /contentType result with taskId/);
    assert.ok(
      !description.includes(PROTOCOL.reporting),
      'shared reporting paragraph belongs on connect instructions (ZIG-1442)',
    );
    // ZIG-1320 — teach the inline cap and escape hatch on the tool surface.
    assert.match(description, /50000 characters/);
    // ZIG-1384 #3 — the file rail is this same tool now (filename + mime +
    // contentBase64), not a separate presign/PUT/complete dance to go learn.
    assert.match(description, /contentBase64/);
    await client.close();
  });

  it('over-limit text names the file rail before any wire call', async () => {
    let fetchCalls = 0;
    mock.method(globalThis, 'fetch', async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    });
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_artifact_record', {
        text: 'x'.repeat(50_001),
        visibility: 'chat',
        chatId: 'c1',
      });
    const text = callText(result);
    assert.match(text, /50000 characters/);
    assert.match(text, /ziggs_artifact_upload_url/);
    assert.match(text, /index artifact/);
    assert.equal(fetchCalls, 0);
    await client.close();
  });

  it('success path nudges toward closing the task for a result artifact', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () => new Response('{}', { status: 200 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_artifact_record', {
        text: 'the deliverable',
        visibility: 'chat',
        chatId: 'c1',
        taskId: 't1',
        contentType: 'result',
      });
    const text = callText(result);
    assert.match(text, /task-bound result artifact/);
    assert.match(text, /ziggs_task_set_result/);
    await client.close();
  });

  it('result artifact without a taskId says it is unbound', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () => new Response('{}', { status: 200 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_artifact_record', {
        text: 'the deliverable',
        visibility: 'chat',
        chatId: 'c1',
        contentType: 'result',
      });
    assert.match(callText(result), /not bound to a task/);
    await client.close();
  });

  // ZIG-1300 cut the snake_case alias from the declared schema. The MCP layer
  // validates against that schema and rejects unknown properties, so the old
  // spelling is now a hard error rather than a silently dropped field — which
  // is the point: a stripped content type filed a deliverable as `text`.
  it('rejects the retired snake_case argument outright', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () => new Response('{}', { status: 200 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_artifact_record', {
        text: 'the deliverable',
        visibility: 'chat',
        chatId: 'c1',
        content_type: 'result',
      });
    assert.match(callText(result), /content_type/);
    await client.close();
  });

  it('a plain artifact still points at the result slot', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () => new Response('{}', { status: 200 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_artifact_record', {
        text: 'a note',
        visibility: 'chat',
        chatId: 'c1',
      });
    // ZIG-1879: it still points at the result slot, and it no longer forbids
    // telling the person who asked — that delivery is a separate message, not a
    // competing record.
    assert.match(callText(result), /that record is what the next agent reads/);
    assert.match(callText(result), /separate chat message/);
    await client.close();
  });
});
