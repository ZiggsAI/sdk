import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
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

function callText(result: unknown): string {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content.map((c) => c.text ?? '').join('');
}

function persona() {
  return {
    persona: { id: 'psn_buyer', name: 'Buyer', image: null },
    mode: 'persona',
  };
}

const WIRE_CHAT = {
  chatId: 'cht_1',
  name: 'Hire room',
  updatedAt: '2026-09-21T10:00:00.000Z',
  lastMessage: {
    sender: 'agt_1',
    at: '2026-09-21T10:00:00.000Z',
    snippet: 'Draft ready.',
  },
  unreadCount: 2,
  addressKind: 'pair',
  participantsRefreshAt: null,
  members: [{ principalId: 'usr_1', agentId: null, presentation: persona() }],
  rosterSummary: [
    {
      id: 'usr_1',
      type: 'user',
      via: [{ kind: 'grant' }],
      access: 'write',
      persona: persona().persona,
      presentation: 'persona',
      presentationView: persona(),
    },
  ],
  participantSummary: [
    {
      id: 'usr_1',
      type: 'user',
      via: [{ kind: 'grant' }],
      access: 'write',
      persona: persona().persona,
      presentation: 'persona',
      presentationView: persona(),
    },
  ],
};

describe('ziggs_chat_list fields (ZIG-1945)', () => {
  afterEach(() => mock.restoreAll());

  it('an empty room list explains how to start contact without claiming permission', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ chats: [] }), { status: 200 }));
    const client = await connectedClient();
    const result = JSON.parse(callText(await callZiggsTool(client, 'ziggs_chat_list', {})));
    assert.deepEqual(result.chats, []);
    assert.match(result.note, /ziggs_chat_open/);
    assert.match(result.note, /server checks whether contact is allowed/);
    await client.close();
  });

  it('advertises optional fields', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const tool = tools.find((t) => t.name === 'ziggs_chat_list');
    const props = (
      tool?.inputSchema as { properties?: Record<string, unknown> }
    )?.properties;
    assert.ok(props?.fields, 'fields is on the schema');
    await client.close();
  });

  it('default call drops members and rosterSummary and slims the face', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ chats: [WIRE_CHAT] }), { status: 200 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_chat_list', {});
    assert.notEqual((result as { isError?: boolean }).isError, true);
    const parsed = JSON.parse(callText(result)) as {
      count: number;
      chats: Array<Record<string, unknown>>;
    };
    assert.equal(parsed.count, 1);
    const row = parsed.chats[0];
    assert.equal(row.chatId, 'cht_1');
    assert.equal(row.name, 'Hire room');
    assert.equal(row.members, undefined);
    assert.equal(row.rosterSummary, undefined);
    const people = row.participantSummary as Array<Record<string, unknown>>;
    assert.equal(people.length, 1);
    assert.equal(people[0].presentationView, undefined);
    assert.deepEqual(people[0].persona, { id: 'psn_buyer', name: 'Buyer', image: null });
    await client.close();
  });

  it('fields can request the other two rosters', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ chats: [WIRE_CHAT] }), { status: 200 }),
    );
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_chat_list', {
      fields: ['chatId', 'members', 'rosterSummary'],
    });
    const parsed = JSON.parse(callText(result)) as {
      chats: Array<Record<string, unknown>>;
    };
    assert.ok(Array.isArray(parsed.chats[0].members));
    assert.ok(Array.isArray(parsed.chats[0].rosterSummary));
    assert.equal(parsed.chats[0].participantSummary, undefined);
    await client.close();
  });
});
