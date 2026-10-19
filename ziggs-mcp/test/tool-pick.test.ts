import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { pickLine } from '../src/toolPick.js';
import { callJson } from './support/surface.js';

/**
 * `ziggs_tools need=`: a plain need answered with the one tool that does it.
 * The pick itself is the backend's (POST /internal/tool-pick); here the
 * surface is checked against every answer that route can give.
 */

async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tool-pick', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function answerWith(body: unknown, status = 200) {
  return mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status }));
}

async function tools(client: Client, args: Record<string, unknown>) {
  return callJson<{
    tools: Array<{ name: string; inputSchema?: unknown; call?: string }>;
    nothingFits?: string;
    need?: string;
    count?: number;
  }>(await client.callTool({ name: 'ziggs_tools', arguments: args }));
}

describe('ziggs_tools need= (ZIG-1991)', () => {
  afterEach(() => mock.restoreAll());

  it('answers a confident pick with that one tool, described in full', async () => {
    const fetchMock = answerWith({ how: 'pick', tool: 'ziggs_task_cancel', confidence: 0.99 });
    const client = await connectedClient();
    const out = await tools(client, { need: 'cancel the task I am on' });
    assert.equal(out.tools.length, 1);
    assert.equal(out.tools[0]!.name, 'ziggs_task_cancel');
    assert.ok(out.tools[0]!.inputSchema, 'the pick carries its schema');
    assert.ok(out.tools[0]!.call, 'the pick carries its call line');

    const [url, init] = fetchMock.mock.calls[0]!.arguments as [string, RequestInit];
    assert.match(url, /\/internal\/tool-pick$/);
    const sent = JSON.parse(init.body as string) as {
      need: string;
      options: Array<{ name: string; line: string }>;
    };
    assert.equal(sent.need, 'cancel the task I am on');
    const names = sent.options.map((o) => o.name);
    assert.ok(names.includes('ziggs_task_cancel'));
    assert.ok(!names.includes('ziggs_tools'), 'the catalog tools are not options');
    assert.ok(sent.options.every((o) => o.line.length > 0));
    await client.close();
  });

  it('says nothing fits in one line', async () => {
    answerWith({ how: 'nothing_fits', confidence: 0.9 });
    const client = await connectedClient();
    const out = await tools(client, { need: 'order a pizza for the team' });
    assert.deepEqual(out.tools, []);
    assert.match(out.nothingFits ?? '', /No Ziggs tool does this/);
    await client.close();
  });

  it('falls back to the full list when unsure, off, refused or unreachable', async () => {
    const client = await connectedClient();
    const full = (await tools(client, {})).count;
    for (const setup of [
      () => answerWith({ how: 'unsure', confidence: 0.4 }),
      () => answerWith({ how: 'off' }),
      () => answerWith({ message: 'Not Found' }, 404),
      () => answerWith({ how: 'pick', tool: 'ziggs_not_a_tool', confidence: 0.99 }),
      () =>
        mock.method(globalThis, 'fetch', async () => {
          throw new TypeError('fetch failed');
        }),
    ]) {
      mock.restoreAll();
      setup();
      const out = await tools(client, { need: 'cancel the task I am on' });
      assert.equal(out.count, full);
    }
    await client.close();
  });

  it('leaves describe and search as they were', async () => {
    const fetchMock = answerWith({ how: 'pick', tool: 'ziggs_task_cancel', confidence: 0.99 });
    const client = await connectedClient();
    const described = await tools(client, { describe: ['ziggs_chat_send'], need: 'cancel it' });
    assert.deepEqual(described.tools.map((t) => t.name), ['ziggs_chat_send']);
    const searched = await tools(client, { search: 'task', need: 'cancel it' });
    assert.ok(searched.tools.length > 1);
    assert.equal(fetchMock.mock.callCount(), 0);
    await client.close();
  });
});

describe('pickLine', () => {
  it('is the title and the first sentence', () => {
    assert.equal(pickLine('Cancel a task', 'Cancel one task. Then more text.'), 'Cancel a task. Cancel one task.');
  });
});
