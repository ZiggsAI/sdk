import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

/**
 * A write tool's `sources` reaches the request body as the caller gave it,
 * and a call that names none sends none.
 */
async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function captureBodies(response: Record<string, unknown>): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  mock.method(globalThis, 'fetch', async (_url: string | URL, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body ?? '{}')));
    return new Response(JSON.stringify(response), { status: 200 });
  });
  return bodies;
}

const SOURCES = [
  { kind: 'artifact', id: 'art_research' },
  { kind: 'url', value: 'https://example.com/paper' },
];

describe('what a write drew on', () => {
  afterEach(() => mock.restoreAll());

  it('a chat message carries its sources, and one that names none carries none', async () => {
    const bodies = captureBodies({ success: true, message: 'ok', chatId: 'c-1' });
    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_chat_send', {
      chatId: 'c-1',
      text: 'Summary attached',
      sources: SOURCES,
    });
    await callZiggsTool(client, 'ziggs_chat_send', { chatId: 'c-1', text: 'thanks' });
    assert.deepEqual(bodies[0]['sources'], SOURCES);
    assert.equal('sources' in bodies[1], false);
    await client.close();
  });

  it('a task result carries its sources', async () => {
    const bodies = captureBodies({ task: { taskId: 't-1', state: 'completed' } });
    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_task_set_result', {
      taskId: 't-1',
      state: 'completed',
      result: { summary: 'done' },
      sources: [],
    });
    assert.deepEqual(bodies[0]['sources'], []);
    await client.close();
  });

  it('each replaced plan step carries its own sources', async () => {
    const bodies = captureBodies({ task: { taskId: 't-1', state: 'active' } });
    const client = await connectedClient();
    await callZiggsTool(client, 'ziggs_task_replace_plan', {
      taskId: 't-1',
      steps: [
        { description: 'Read the brief', sources: SOURCES },
        { description: 'Draft' },
      ],
    });
    const steps = bodies[0]['steps'] as Array<Record<string, unknown>>;
    assert.deepEqual(steps[0]['sources'], SOURCES);
    assert.equal('sources' in steps[1], false);
    await client.close();
  });
});
