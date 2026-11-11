import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

/**
 * A connected assistant writing its first message sees the command's real
 * fields in the tool's schema, and a wrong key is refused by name before
 * anything is sent: an open object left it guessing, and the server's refusal
 * named neither the key nor the shape.
 */
const deviceKey = `header.${Buffer.from(JSON.stringify({ type: 'operator', keyId: 'key', ownerId: 'owner', boundAgentId: 'assistant', issuedVia: 'device_code' })).toString('base64url')}.test`;

for (const host of ['Claude', 'compact']) {
  test(`${host}: ziggs_message_send publishes the command's fields and refuses an unknown key by name`, async (t) => {
    const server = createZiggsMcpServer(
      { operatorKey: host === 'compact' ? 'op' : deviceKey, agentId: 'assistant' },
      { directConnection: host === 'compact', debugTools: false } as ZiggsMcpConfig,
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: host, version: 'test' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    t.after(async () => { await client.close(); await server.close(); });

    const tool = (await client.listTools()).tools.find((x) => x.name === 'ziggs_message_send');
    const command = (tool?.inputSchema.properties as Record<string, any>).command;
    assert.deepEqual(
      [...command.required].sort(),
      ['audience', 'content', 'deliveries', 'intent', 'operationId'],
    );
    assert.deepEqual(command.properties.audience.properties.kind.enum, ['explicit']);
    assert.deepEqual(command.properties.intent.enum, ['fyi', 'request']);
    assert.equal(command.additionalProperties, false);

    const calls: unknown[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ outcome: 'created', message: { messageId: 'm' } }, { status: 201 });
    });
    const wrong = await callZiggsTool(client, 'ziggs_message_send', {
      command: {
        operationId: 'first',
        content: { text: 'Here is the report' },
        audience: { type: 'person', kind: 'explicit', principalIds: ['peer'] },
        deliveries: { kind: 'explicit', principalIds: ['peer'] },
        intent: 'fyi',
      },
    });
    assert.equal((wrong as { isError?: boolean }).isError, true);
    const text = JSON.stringify((wrong as { content?: unknown }).content);
    assert.match(text, /audience/);
    assert.match(text, /type/);
    assert.equal(calls.length, 0);
  });
}
