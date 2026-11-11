import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { RETIRED_TOOLS } from '../src/retiredTools.js';

/**
 * A call to a tool we removed gets a message the assistant can act on, not the
 * MCP SDK's bare "not found".
 */

const compact = { catalog: true } as unknown as ZiggsMcpConfig;
const directory = { directConnection: false } as unknown as ZiggsMcpConfig;

async function connect(cfg: ZiggsMcpConfig, clientName = 'retired-test') {
  const server = createZiggsMcpServer({ operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds, cfg);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const textOf = (result: unknown): string =>
  ((result as { content: Array<{ text: string }> }).content[0]?.text) ?? '';

describe('calling a removed tool', () => {
  it('direct call on the compact door names the replacement and says to use the dispatcher', async () => {
    const client = await connect(compact, 'claude-code');
    const result = await client.callTool({ name: 'ziggs_send_message', arguments: {} });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /ziggs_send_message was removed from Ziggs/);
    assert.match(text, /out of date/);
    assert.match(text, /ziggs_message_send/);
    assert.match(text, /by its name from your tool list/);
    assert.doesNotMatch(text, /ziggs_tool_write/);
    assert.match(text, /\/mcp/);
    assert.doesNotMatch(text, /not found/i);
    await client.close();
  });

  it('through the write dispatcher and through describe, on the compact door', async () => {
    const client = await connect(compact);
    const viaDispatcher = await client.callTool({
      name: 'ziggs_tool_write',
      arguments: { tool: 'ziggs_send_message', args: {} },
    });
    assert.equal(viaDispatcher.isError, true);
    assert.match(textOf(viaDispatcher), /ziggs_message_send/);
    const viaDescribe = await client.callTool({
      name: 'ziggs_tools',
      arguments: { describe: ['ziggs_send_message'] },
    });
    assert.equal(viaDescribe.isError, true);
    assert.match(textOf(viaDescribe), /ziggs_message_send/);
    await client.close();
  });

  it('directory door asks the person to refresh and never points at a dispatcher', async () => {
    const client = await connect(directory, 'ChatGPT');
    const result = await client.callTool({ name: 'ziggs_send_message', arguments: {} });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /ziggs_message_send/);
    assert.match(text, /Apps & Connectors/);
    assert.match(text, /once per conversation/);
    assert.doesNotMatch(text, /ziggs_tool_write/);
    await client.close();
  });

  it('a split name lists each replacement and when to use which', async () => {
    const client = await connect(compact);
    const text = textOf(await client.callTool({ name: 'ziggs_agreement_propose', arguments: {} }));
    for (const tool of ['ziggs_agreement_buy', 'ziggs_agreement_bid', 'ziggs_agreement_request', 'ziggs_link_propose']) {
      assert.match(text, new RegExp(tool));
    }
    assert.match(text, /you pay a named party/);
    await client.close();
  });

  it('a name with no replacement says so and still gives the refresh steps', async () => {
    const client = await connect(compact, 'Cursor');
    const text = textOf(await client.callTool({ name: 'ziggs_payment_transfer', arguments: {} }));
    assert.match(text, /Agents do not move points/);
    assert.doesNotMatch(text, /Use ziggs_/);
    assert.match(text, /Cursor/);
    await client.close();
  });

  it('other apps get their own steps, and an unknown app gets the generic ones', async () => {
    const claude = await connect(compact, 'claude-ai');
    assert.match(textOf(await claude.callTool({ name: 'ziggs_send_message', arguments: {} })), /Settings → Connectors/);
    await claude.close();
    const other = await connect(compact, 'some-other-app');
    assert.match(textOf(await other.callTool({ name: 'ziggs_send_message', arguments: {} })), /Reconnect Ziggs/);
    await other.close();
  });

  it('sends the tool-list-changed signal on a session with a stream', async () => {
    const client = await connect(compact);
    let signalled = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      signalled = true;
    });
    await client.callTool({ name: 'ziggs_send_message', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(signalled, true);
    await client.close();
  });

  it('search finds the replacement for a retired word', async () => {
    const client = await connect(compact);
    for (const [word, tool] of [['commission', 'ziggs_agreement_buy'], ['quest', 'ziggs_agreement_request']] as const) {
      const out = JSON.parse(textOf(await client.callTool({ name: 'ziggs_tools', arguments: { search: word } }))) as {
        tools: Array<{ name: string }>;
      };
      assert.ok(out.tools.some((t) => t.name === tool), word);
    }
    await client.close();
  });
});

describe('the table of removed tools', () => {
  const registered = JSON.parse(
    readFileSync(new URL('./registered-tools.snapshot.json', import.meta.url), 'utf8'),
  ) as string[];

  it('never lists a removed name in tools/list, on either door', async () => {
    for (const cfg of [compact, directory]) {
      const client = await connect(cfg);
      const listed = (await client.listTools()).tools.map((t) => t.name);
      assert.deepEqual(listed.filter((n) => n in RETIRED_TOOLS), []);
      await client.close();
    }
  });

  it('sends every replacement to a tool the server registers today', () => {
    const missing: string[] = [];
    for (const [name, row] of Object.entries(RETIRED_TOOLS)) {
      for (const use of row.use) if (!registered.includes(use.tool)) missing.push(`${name} -> ${use.tool}`);
    }
    assert.deepEqual(missing, []);
  });

  it('has a row for every tool removed since the snapshot (add the row when you remove a tool)', async () => {
    const live = new Set<string>();
    for (const cfg of [compact, directory]) {
      const client = await connect(cfg);
      for (const t of (await client.listTools()).tools) live.add(t.name);
      await client.close();
    }
    const unexplained = registered.filter((name) => !live.has(name) && !(name in RETIRED_TOOLS));
    assert.deepEqual(unexplained, [], 'a tool left the registered set without a row in src/retiredTools.ts');
  });

  it('covers the 87 tools removed before this table existed, and each removal since', () => {
    assert.ok(Object.keys(RETIRED_TOOLS).length >= 87);
  });
});
