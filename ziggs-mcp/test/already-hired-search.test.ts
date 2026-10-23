import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

/**
 * ZIG-2240 — the search the assistant actually calls names an active hire.
 * The capability test covers the match. This one covers the registration.
 */
describe('ziggs_agent_search names an active hire (ZIG-2240)', () => {
  afterEach(() => mock.restoreAll());

  it('says already hired, with the agreement and workspace, and the tool text says so', async () => {
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/agents/search')) {
        return Response.json({
          results: [{ agentId: 'agent-notes', name: 'Meeting Notes' }],
        });
      }
      return Response.json({
        agreements: [
          {
            agreementId: 'agr-live',
            status: 'active',
            engagementKind: 'hire',
            payerLane: 'org-kiwook',
            parties: {
              provider: { actor: 'agent-notes', principal: 'org-seller' },
              payer: { principal: 'user-buyer', actor: null },
            },
          },
        ],
      });
    });
    const server = createZiggsMcpServer(
      { operatorKey: 'op', agentId: 'assistant' } as unknown as Creds,
      {} as unknown as ZiggsMcpConfig,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const tool = listed.tools.find((t) => t.name === 'ziggs_agent_search');
    assert.match(tool?.description ?? '', /already hired/);
    const result = await callZiggsTool(client, 'ziggs_agent_search', { query: 'meeting notes' });
    assert.notEqual((result as { isError?: boolean }).isError, true);
    const text = (result as { content: Array<{ text?: string }> }).content
      .map((c) => c.text ?? '')
      .join('');
    const parsed = JSON.parse(text) as {
      agents: Array<{ alreadyHired?: string; hires?: Array<{ agreementId: string; workspace: string }> }>;
    };
    assert.equal(parsed.agents[0]?.alreadyHired, 'already hired');
    assert.deepEqual(parsed.agents[0]?.hires, [
      { agreementId: 'agr-live', workspace: 'org-kiwook' },
    ]);
    await client.close();
  });
});
