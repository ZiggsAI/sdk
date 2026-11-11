import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';

/** The catalog tools are listed only when a client asks for them. */

const CATALOG = ['ziggs_tools', 'ziggs_tool_read', 'ziggs_tool_write'];

async function listedNames(cfg: Partial<ZiggsMcpConfig>): Promise<string[]> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    { debugTools: false, ...cfg } as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'catalog-unlisted', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

describe('catalog tools listing', () => {
  it('are not listed by default', async () => {
    const names = await listedNames({});
    for (const n of CATALOG) assert.ok(!names.includes(n), `${n} should be unlisted`);
  });

  it('are listed when the client asks for them', async () => {
    const names = await listedNames({ catalog: true });
    for (const n of CATALOG) assert.ok(names.includes(n), `${n} should be listed`);
  });
});
