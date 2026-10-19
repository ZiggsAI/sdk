import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mcpDescription, recordArtifactCapability, type Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import {
  PROTOCOL,
  PROTOCOL_RULES,
  renderInstructions,
} from '../src/protocol/delegateProtocol.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { surfaceTools } from './support/surface.js';

/**
 * ZIG-1442: the shared protocol paragraphs appear once, in the generated
 * SKILL / .cursorrules. Tool descriptions keep their own fields and next
 * calls. (ZIG-2116 moved the connect text to its own short form; see
 * server-instructions.test.ts.)
 */
const SHARED = [
  PROTOCOL.reporting,
  PROTOCOL.engage,
  PROTOCOL.loop,
  PROTOCOL.ack,
  PROTOCOL.humanAttention,
  PROTOCOL.pendingDecisions,
] as const;

describe('protocol paragraphs once on connect (ZIG-1442)', () => {
  it('the long protocol still carries every shared rule', () => {
    const instructions = renderInstructions();
    for (const rule of PROTOCOL_RULES) {
      assert.ok(instructions.includes(rule), `instructions missing: ${rule}`);
    }
  });

  it('inbox, chat_send, and artifact_record descriptions do not repeat them', async () => {
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
    const names = ['ziggs_inbox', 'ziggs_chat_send', 'ziggs_artifact_record'];
    for (const name of names) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} must be registered`);
      const description = tool.description ?? '';
      for (const paragraph of SHARED) {
        assert.ok(
          !description.includes(paragraph),
          `${name} still embeds PROTOCOL paragraph: ${paragraph.slice(0, 40)}…`,
        );
      }
    }

    await client.close();
    await server.close();
  });

  it('both capability surfaces dropped the copied reporting paragraph', () => {
    assert.ok(
      !mcpDescription(
        recordArtifactCapability.names.mcp,
        recordArtifactCapability.annotation,
      ).includes(PROTOCOL.reporting),
    );
    assert.ok(!recordArtifactCapability.descriptions.sdk.includes(PROTOCOL.reporting));
  });
});
