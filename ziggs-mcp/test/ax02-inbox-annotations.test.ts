import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { surfaceTools } from './support/surface.js';

/**
 * ZIG-1873 / AX-02: an operation capable of acknowledgement is not described
 * as read-only. The split has to survive both native listing and catalog
 * dispatch — a host that only reads annotations decides whether to confirm.
 */
describe('ZIG-1873 MCP effects annotations', () => {
  async function listed() {
    const server = createZiggsMcpServer(
      { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
      { debugTools: false } as ZiggsMcpConfig,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ax02-annotations', version: '0.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const native = await client.listTools();
    const surface = await surfaceTools(client);
    await client.close();
    return { native: native.tools, surface };
  }

  it('legacy acquiring inbox and inbox_ack are writes', async () => {
    const { native } = await listed();
    const inbox = native.find((t) => t.name === 'ziggs_inbox');
    const ack = native.find((t) => t.name === 'ziggs_inbox_ack');
    assert.ok(inbox && ack, 'both inbox tools are native');
    assert.equal(inbox!.annotations?.readOnlyHint, false);
    assert.equal(ack!.annotations?.readOnlyHint, false);
  });

  it('catalog dispatch keeps the same read/write split', async () => {
    const { surface } = await listed();
    const aRead = surface.find(
      (t) =>
        t.annotations.readOnlyHint === true && t.name !== 'ziggs_inbox',
    );
    const aWrite = surface.find(
      (t) =>
        t.annotations.readOnlyHint === false &&
        t.name !== 'ziggs_inbox_ack' &&
        t.annotations.destructiveHint !== true,
    );
    assert.ok(aRead, 'catalog still has a read-only tool');
    assert.ok(aWrite, 'catalog still has a write tool');
    assert.equal(aRead!.annotations.readOnlyHint, true);
    assert.equal(aWrite!.annotations.readOnlyHint, false);
  });
});
