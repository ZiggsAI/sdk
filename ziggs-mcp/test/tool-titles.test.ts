import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { surfaceTools } from './support/surface.js';

/**
 * Without a title a host shows the wire name — a person picking tools reads
 * `ziggs_agreement_fulfill` instead of "Close an agreement you provide" — and
 * the connector directory flags the surface. The type system already forces a
 * title at registration; this asserts what actually reaches the wire, for both
 * tool sources (MCP-local registrations and shared capability definitions) and
 * both spec positions.
 */
async function listTools() {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    { debugTools: true, coreOnly: false } as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const tools = await surfaceTools(client);
  await client.close();
  return tools;
}

describe('tool titles', () => {
  it('every tool carries a title, in both spec positions', async () => {
    const tools = await listTools();
    assert.ok(tools.length > 50, `only ${tools.length} tools listed`);

    const untitled = tools.filter((t) => !t.title?.trim()).map((t) => t.name);
    assert.deepEqual(untitled, [], `tools with no title: ${untitled.join(', ')}`);

    // Display precedence is title → annotations.title → name, so a client
    // written against the 2024-11-05 spec reads the annotation copy. One
    // source at registration; assert the two positions agree.
    const mismatched = tools
      .filter((t) => t.annotations?.title !== t.title)
      .map((t) => t.name);
    assert.deepEqual(
      mismatched,
      [],
      `title and annotations.title disagree: ${mismatched.join(', ')}`,
    );
  });

  it('titles read as the action, not as the wire name', async () => {
    const tools = await listTools();
    const offenders: string[] = [];
    for (const tool of tools) {
      const title = tool.title ?? '';
      // A title that repeats the snake_case name is the flagged state with
      // extra steps.
      if (/^ziggs_|_/.test(title)) offenders.push(`${tool.name}: snake_case`);
      // Product copy: no internal ticket ids, no em-dashes.
      if (/ZIG-\d+/.test(title)) offenders.push(`${tool.name}: ticket ref`);
      if (title.includes('—')) offenders.push(`${tool.name}: em-dash`);
      // Long enough to say the action, short enough for a picker row.
      if (title.length < 4 || title.length > 44) {
        offenders.push(`${tool.name}: length ${title.length}`);
      }
      if (title !== title.trim()) offenders.push(`${tool.name}: padded`);
    }
    assert.deepEqual(offenders, [], offenders.join('; '));
  });

  it('no two tools share a title', async () => {
    const tools = await listTools();
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const tool of tools) {
      const title = tool.title ?? '';
      const first = seen.get(title);
      if (first) clashes.push(`${first} / ${tool.name}: "${title}"`);
      else seen.set(title, tool.name);
    }
    assert.deepEqual(clashes, [], clashes.join('; '));
  });
});
