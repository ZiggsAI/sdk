import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createZiggsMcpServer } from '../src/server.js';
import { DIRECTORY_TOOLS } from '../src/directorySurface.js';
import type { ZiggsMcpConfig } from '../src/config.js';

/**
 * A file reaches someone by being put in a bucket with them. An assistant
 * connected through the directory (Claude, ChatGPT, Cursor) gets the two tools
 * that do it: create a bucket with items, and put an item in one.
 */
async function directoryTools() {
  const server = createZiggsMcpServer(
    { operatorKey: 'e30.eyJ0eXBlIjoib3BlcmF0b3IifQ.test', agentId: 'assistant', instanceId: 'test-host' },
    { directConnection: false, coreOnly: true, debugTools: true } as ZiggsMcpConfig,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ChatGPT', version: 'test' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('bucket tools on the directory surface', () => {
  it('puts a file in a bucket with someone: create with items, and insert', async () => {
    const tools = await directoryTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('ziggs_bucket_create'));
    assert.ok(names.includes('ziggs_bucket_insert'));
    assert.ok(DIRECTORY_TOOLS.has('ziggs_bucket_create') && DIRECTORY_TOOLS.has('ziggs_bucket_insert'));
  });

  it('takes no more than those two: the rest of the bucket tools stay on the compact door', async () => {
    const names = (await directoryTools()).map((t) => t.name).filter((n) => n.startsWith('ziggs_bucket_'));
    assert.deepEqual(names.sort(), ['ziggs_bucket_create', 'ziggs_bucket_insert']);
  });

  it('declares both as writes that destroy nothing, and only create as bringing in new people', async () => {
    const tools = await directoryTools();
    const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;
    for (const name of ['ziggs_bucket_create', 'ziggs_bucket_insert']) {
      assert.equal(hints(name)?.readOnlyHint, false, name);
      assert.equal(hints(name)?.destructiveHint, false, name);
    }
    assert.equal(hints('ziggs_bucket_create')?.openWorldHint, true);
    assert.equal(hints('ziggs_bucket_insert')?.openWorldHint, false);
  });
});
