import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import { PROTOCOL } from '../src/protocol/delegateProtocol.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { surfaceTools } from './support/surface.js';

/**
 * ZIG-1442: ziggs_chat_send describes the send grant. The shared reporting
 * rule lives on connect instructions, not this description.
 */
describe('ziggs_chat_send description (ZIG-1442)', () => {
  it('describes the grant and does not repeat the shared reporting paragraph', async () => {
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

    const tools = await surfaceTools(client);
    const sendMessage = tools.find((t) => t.name === 'ziggs_chat_send');
    assert.ok(sendMessage, 'ziggs_chat_send must be registered');
    const description = sendMessage.description ?? '';

    assert.match(description, /active write grant/);
    assert.match(description, /ziggs_chat_open/);
    assert.ok(
      !description.includes(PROTOCOL.reporting),
      'shared reporting paragraph belongs on connect instructions',
    );
    assert.doesNotMatch(description, /chat is conversation only/);

    await client.close();
    await server.close();
  });
});
