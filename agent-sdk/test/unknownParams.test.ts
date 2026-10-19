import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { defineTool } from '../src/tools/defineTool.js';
import { ToolManager } from '../src/tools/ToolManager.js';
import { buildSdkToolDefs } from '../src/brain/toolManagerToSdkMcp.js';
import { PROTOCOL_TOOLS } from '../src/platform/tools/tier1/protocolTools.js';

/**
 * ZIG-1215 — an unknown param used to be dropped silently on both brain paths,
 * so a misspelled `newChat` ran the opposite of what was asked and reported
 * success. Both layers strip: the FSM brain via ToolManager's Ajv pass, the
 * Claude brain earlier still, in the SDK MCP bridge.
 */
describe('unknown tool params are rejected, not dropped (ZIG-1215)', () => {
  it('defineTool closes the top level of every tool schema', () => {
    const t = defineTool('demo', { q: { type: 'string', required: true } }, async (a) => a);
    const params = t.schema.function['parameters'] as Record<string, unknown>;
    assert.equal(params['additionalProperties'], false);
    const permissive = PROTOCOL_TOOLS.filter(
      (p) =>
        ((p.schema.function['parameters'] as Record<string, unknown>) ?? {})[
          'additionalProperties'
        ] !== false,
    ).map((p) => p.schema.function['name']);
    assert.deepEqual(permissive, [], `tools still dropping unknown params: ${permissive.join(', ')}`);
  });

  it('ToolManager refuses the call and names the typo', async () => {
    const manager = new ToolManager();
    let ran = false;
    manager.register(
      defineTool(
        'chat_send',
        { text: { type: 'string', required: true }, newChat: 'boolean' },
        async () => {
          ran = true;
          return 'sent';
        },
      ),
    );
    await assert.rejects(
      () => manager.executeTool('chat_send', { text: 'hi', nweChat: true }),
      (err: Error) => {
        assert.match(err.message, /nweChat/);
        assert.match(err.message, /newChat/);
        return true;
      },
    );
    assert.equal(ran, false, 'handler must not run on a rejected call');
    assert.equal(await manager.executeTool('chat_send', { text: 'hi', newChat: true }), 'sent');
  });

  it('the Claude brain bridge rejects instead of stripping', async () => {
    const defs = buildSdkToolDefs(
      [
        defineTool(
          'chat_send',
          { text: { type: 'string', required: true }, newChat: 'boolean' },
          async () => 'sent',
        ),
      ],
      () => ({ eff: async () => ({ ok: true, result: 'sent' }), chatId: 'chat-1' }) as never,
    );
    const server = createSdkMcpServer({
      name: 'ziggs-test',
      tools: defs.map((d) =>
        sdkTool(d.name, d.description, d.inputSchema as never, d.handler as never),
      ),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([
      (server.instance as unknown as { connect: (t: unknown) => Promise<void> }).connect(
        serverTransport,
      ),
      client.connect(clientTransport),
    ]);

    const listed = (await client.listTools()).tools[0];
    assert.equal(
      (listed?.inputSchema as { additionalProperties?: unknown }).additionalProperties,
      false,
      'the published schema must advertise the closed shape',
    );

    const bad = (await client.callTool({
      name: 'chat_send',
      arguments: { text: 'hi', nweChat: true },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    assert.equal(bad.isError, true);
    const text = bad.content.map((c) => c.text ?? '').join('');
    assert.match(text, /nweChat/);
    assert.match(text, /newChat/);

    const good = (await client.callTool({
      name: 'chat_send',
      arguments: { text: 'hi', newChat: true },
    })) as { isError?: boolean };
    assert.notEqual(good.isError, true, 'declared params must still be accepted');
    await client.close();
  });
});
