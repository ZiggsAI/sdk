import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { surfaceTools } from './support/surface.js';

/**
 * ZIG-222's "smoke" labeling stuck to the propose verb long after it
 * became the only production path for proposing a direct agreement. This
 * guards against that framing creeping back in.
 */
async function connectedClient(
  cfg: Partial<ZiggsMcpConfig> = {},
): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    { debugTools: false, ...cfg } as ZiggsMcpConfig,
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

function clientVisibleBlob(tool: {
  description?: string;
  inputSchema?: unknown;
}): string {
  const parts = [tool.description ?? ''];
  if (tool.inputSchema !== undefined) {
    parts.push(JSON.stringify(tool.inputSchema));
  }
  return parts.join('\n');
}

describe('tool descriptions', () => {
  it('each agreement verb describes its own shape, not the whole table', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const byName = new Map(tools.map((t) => [t.name, t.description ?? '']));

    // The old single verb had to teach every shape in one description, which is
    // what made it a tenth of the whole surface. A verb that names its shape
    // should not be re-explaining the others.
    const verbs = [
      'ziggs_agreement_buy',
      'ziggs_agreement_bid',
      'ziggs_agreement_broker',
      'ziggs_agreement_request',
      'ziggs_agreement_handoff',
    ];
    for (const name of verbs) {
      const description = byName.get(name);
      assert.ok(description, `${name} is not registered`);
      assert.doesNotMatch(description!, /smoke/i);
      assert.doesNotMatch(
        description!,
        /providerId/,
        `${name} still explains providerId — only ziggs_agreement_broker names a provider`,
      );
    }

    // Each says who works and who pays, since that is the whole distinction.
    assert.match(byName.get('ziggs_agreement_buy')!, /they provide, you pay/i);
    assert.match(byName.get('ziggs_agreement_bid')!, /you provide/i);
    assert.match(byName.get('ziggs_agreement_request')!, /claims it does the work/i);

    await client.close();
  });

  it('no client-visible tool text cites internal ZIG ticket ids (ZIG-672)', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const offenders = tools
      .filter((t) => /ZIG-\d+/.test(clientVisibleBlob(t)))
      .map((t) => t.name);
    assert.deepEqual(
      offenders,
      [],
      `tools with ZIG refs in description/schema: ${offenders.join(', ')}`,
    );
    await client.close();
  });

  it('ziggs_smoke_impersonation is absent from normal delegate sessions (ZIG-672)', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    assert.equal(
      tools.some((t) => t.name === 'ziggs_smoke_impersonation'),
      false,
    );
    await client.close();
  });

  it('ziggs_smoke_impersonation is registered and labeled when ZIGGS_MCP_DEBUG is on (ZIG-672)', async () => {
    const client = await connectedClient({ debugTools: true });
    const tools = await surfaceTools(client);
    const tool = tools.find((t) => t.name === 'ziggs_smoke_impersonation');
    assert.ok(tool);
    assert.match(tool!.description ?? '', /\[Internal\/debug\]/);
    await client.close();
  });
});
