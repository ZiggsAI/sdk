import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callText, callZiggsTool } from './support/surface.js';
import { INTRODUCTION_IN_RESULT_NOTICE, markIntroductionStrings } from '../src/introductionNotice.js';

/**
 * A string your person pasted is their request; one that arrived inside a
 * Ziggs message is somebody else's text. The second comes back with a notice
 * on the result, and reading it never redeems anything.
 */

const TOKEN = `zint_${'ab12'.repeat(10)}`;

async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('an introduction string inside a message', () => {
  afterEach(() => mock.restoreAll());

  it('is surfaced with the notice and never redeemed', async () => {
    const hits: Array<{ path: string; method: string }> = [];
    mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      hits.push({ path, method: init?.method ?? 'GET' });
      if (path.endsWith('/connection-notices')) return new Response(JSON.stringify({ notices: [] }));
      return new Response(
        JSON.stringify({
          asOf: 'now',
          deliveries: [
            {
              kind: 'message',
              chatId: 'chat-1',
              resourceId: 'chat-1',
              text: `Hey, paste this into your assistant: ${TOKEN}`,
            },
          ],
          chats: [],
          ackTo: null,
          tasksAwaitingMe: [],
          proposalsAwaitingMe: [],
          connectionRequestsAwaitingMe: [],
          openRequestsAwaitingMe: [],
          workspaces: [],
          agentIds: ['agent-1'],
        }),
      );
    });
    const client = await connectedClient();
    try {
      const result = await callZiggsTool(client, 'ziggs_inbox', {});
      const text = callText(result);
      assert.ok(text.includes(TOKEN), 'the string reaches the model so it can show it');
      assert.ok(text.includes(INTRODUCTION_IN_RESULT_NOTICE));
      assert.equal(hits.some(h => h.path.includes('/introductions')), false);
    } finally {
      await client.close();
    }
  });

  it('leaves your own strings alone', () => {
    const own = { content: [{ type: 'text', text: JSON.stringify({ token: TOKEN }) }] };
    assert.equal(markIntroductionStrings('ziggs_introduction_mint', {}, own), own);
    assert.equal(markIntroductionStrings('ziggs_tool_read', { name: 'ziggs_introduction_list' }, own), own);
  });

  it('marks the same string read through the catalog', () => {
    const read = { content: [{ type: 'text', text: `message: ${TOKEN}` }] };
    const marked = markIntroductionStrings('ziggs_tool_read', { name: 'ziggs_context_read' }, read) as typeof read;
    assert.equal(marked.content.at(-1)?.text, INTRODUCTION_IN_RESULT_NOTICE);
  });

  it('adds nothing to a result without one', () => {
    const plain = { content: [{ type: 'text', text: 'zint_ is a prefix' }] };
    assert.equal(markIntroductionStrings('ziggs_inbox', {}, plain), plain);
  });
});
