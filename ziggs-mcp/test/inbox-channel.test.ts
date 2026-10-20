import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import { renderConnectText } from '../src/protocol/connectText.js';
import {
  CHANNEL_NOTIFICATION, channelEvent, startInboxChannel, type InboxChangesOptions, type InboxChangesResult,
} from '../src/inboxChannel.js';

const creds: Creds = {
  operatorKey: `e30.${Buffer.from(JSON.stringify({ boundAgentId: 'agent' })).toString('base64url')}.sig`,
  agentId: 'agent',
};

async function connect(channel: boolean) {
  const server = createZiggsMcpServer(creds, { directConnection: true, channel } as never);
  const client = new Client({ name: 'claude-code', version: '1' });
  const seen: Array<{ content: string; meta: Record<string, string> }> = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === CHANNEL_NOTIFICATION) seen.push(n.params as never);
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { server, client, seen };
}

const page = (deliveries: InboxChangesResult['deliveries'], cursor: string, hasMore = false): InboxChangesResult =>
  ({ asOf: '2026-10-20T00:00:00Z', cursor, expiresAt: '2026-10-21T00:00:00Z', hasMore, deliveries });
const delivery = (id: string, extra: Partial<InboxChangesResult['deliveries'][number]> = {}) =>
  ({ eventId: `e-${id}`, kind: 'message', resourceId: id, chatId: 'chat-1', ts: '2026-10-20T00:00:00Z', needsHuman: false, ...extra });

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

it('declares the Claude Code channel only when asked, and says what an event means', async () => {
  const off = await connect(false);
  const on = await connect(true);
  try {
    assert.equal(off.client.getServerCapabilities()?.experimental?.['claude/channel'], undefined);
    assert.deepEqual(on.client.getServerCapabilities()?.experimental?.['claude/channel'], {});
    assert.doesNotMatch(off.client.getInstructions() ?? '', /<channel>/);
    assert.match(on.client.getInstructions() ?? '', /<channel> event from Ziggs means new mail/);
    // Claude Code keeps the first 2,048 characters of the connect text.
    assert.ok(renderConnectText('compact', { channel: true }).length <= 2048);
    // The directory door is remote: Claude Code cannot load it as a channel.
    assert.doesNotMatch(renderConnectText('directory', { channel: true }), /<channel>/);
  } finally {
    await off.client.close(); await on.client.close();
  }
});

it('rings with ids only, never what the mail says', () => {
  const event = channelEvent(
    delivery('m1', { assigneeId: 'agent', taskId: 't1', orgId: 'org-1' }),
    'agent',
  );
  assert.equal(event.content, 'New Ziggs mail (message). It is assigned to you. Read it with ziggs_inbox and follow its rules.');
  assert.deepEqual(event.meta, {
    kind: 'message', resource_id: 'm1', chat_id: 'chat-1', task_id: 't1', org_id: 'org-1', for_you: 'true',
  });
  // Claude Code drops meta keys that are not identifiers.
  for (const key of Object.keys(event.meta)) assert.match(key, /^[A-Za-z0-9_]+$/);
  const other = channelEvent(delivery('m2', { kind: 'task_update', assigneeId: 'someone-else', needsHuman: true }), 'agent');
  assert.equal(other.content, 'New Ziggs mail (task update). It asks for your person. Read it with ziggs_inbox and follow its rules.');
  assert.equal(other.meta.for_you, undefined);
});

it('folds the backlog into one event, then rings each new delivery, and starts over on an expired cursor', async () => {
  const { server, client, seen } = await connect(true);
  const calls: InboxChangesOptions[] = [];
  const replies: Array<() => InboxChangesResult> = [
    () => page([delivery('old-1'), delivery('old-2')], 'c1', true),
    () => page([delivery('old-3')], 'c2'),
    () => page([delivery('new-1', { assigneeId: 'agent' })], 'c3'),
    () => { throw Object.assign(new Error('expired'), { status: 410 }); },
    () => page([], 'c4'),
  ];
  let stop = () => {};
  const observe = async (options: InboxChangesOptions) => {
    calls.push({ ...options, signal: undefined });
    const next = replies.shift();
    if (next) return next();
    // Nothing more arrives: hold until stopped.
    await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve()));
    return page([], 'c-end');
  };
  try {
    stop = startInboxChannel(server, observe, { agentId: 'agent', log: () => {} });
    await until(() => calls.length >= 6);
    assert.deepEqual(seen.map((e) => e.meta.kind), ['backlog', 'message']);
    assert.equal(seen[0].content, '3 items were already waiting in Ziggs when this session started. Read them with ziggs_inbox when you are free.');
    assert.equal(seen[1].meta.for_you, 'true');
    // Catch-up never holds; the watch holds; the expired cursor scans again from nothing.
    assert.deepEqual(calls.map((c) => [c.cursor, c.waitSeconds]), [
      [undefined, undefined], ['c1', undefined], ['c2', 110], ['c3', 110], [undefined, undefined], ['c4', 110],
    ]);
  } finally {
    stop();
    await client.close();
  }
});

it('stays below protocol revision 2026-07-28, which Claude Code will not register as a channel', () => {
  // Claude Code's v2 MCP runtime asks stdio servers for 2026-07-28 and skips
  // the channel when a server agrees. An SDK upgrade that adds it breaks the
  // channel unless the person sets MCP_PROTOCOL_NEGOTIATION=legacy.
  assert.equal(SUPPORTED_PROTOCOL_VERSIONS.includes('2026-07-28'), false);
});
