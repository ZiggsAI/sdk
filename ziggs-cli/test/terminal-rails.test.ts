import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInbox } from '../src/commands/inbox.js';
import { Command } from 'commander';
import { messagesRequest, formatChatLine } from '../src/commands/chats.js';
import { readTypeForVia, readTypeError } from '../src/commands/read.js';
import { formatSnapshot } from '../src/commands/context.js';
import { registerAgreementsCommands } from '../src/commands/agreements.js';
import { registerTasksCommands } from '../src/commands/tasks.js';
import { registerChatsCommands } from '../src/commands/chats.js';
import type { ChatSummary, ContextSnapshotResult } from '@ziggs-ai/api-client';

test('messages without a timestamp are the latest page, not a forward delta from the epoch', () => {
  assert.deepEqual(messagesRequest({}), { latest: true, limit: 20 });
  assert.deepEqual(messagesRequest({ limit: 5 }), { latest: true, limit: 5 });
  assert.equal(messagesRequest({ after: '2026-01-01T00:00:00.000Z' }).latest, false);
});

test('a chat line names the room and its newest snippet', () => {
  const line = formatChatLine({
    chatId: 'chat-1',
    name: 'Billing',
    unreadCount: 3,
    lastMessage: { sender: 'ada', at: '2026-01-01T00:00:00.000Z', snippet: 'invoice ready' },
  } as ChatSummary);
  assert.match(line, /Billing/);
  assert.match(line, /invoice ready/);
  assert.match(line, /unread 3/);
  assert.doesNotMatch(line, /members:/);
});

test('read task:id is a task read, and a wrong type names --type', () => {
  assert.equal(readTypeForVia('task:abc'), 'tasks');
  assert.equal(readTypeForVia('agreement:abc'), 'agreements');
  assert.equal(readTypeForVia('artifact:abc'), 'artifacts');
  assert.equal(readTypeForVia('chat:abc'), 'messages');
  assert.equal(readTypeForVia('task:abc', 'artifacts'), 'artifacts');
  const error = readTypeError('task:abc', 'messages');
  assert.match(error ?? '', /--type/);
  assert.equal(readTypeError('task:abc', 'tasks'), null);
});

test('a snapshot is a scan, not a JSON blob', () => {
  const text = formatSnapshot({
    history: [{}, {}],
    agreements: [{ agreementId: 'agr-1', proposalStatus: 'approved', description: 'do the work' }],
    agents: [{ agentId: 'agent-1', role: 'member' }],
    users: [{ userId: 'user-1', role: 'member', isYou: true }],
    artifacts: {
      type: 'artifacts',
      via: { kind: 'chat', id: 'c' },
      items: [{ artifactId: 'art-1', name: 'brief', contentType: 'text', timestamp: null }],
      hasMore: false,
      nextCursor: null,
    },
  } as ContextSnapshotResult);
  assert.match(text, /History: 2/);
  assert.match(text, /user-1 \(you\)/);
  assert.match(text, /agr-1/);
  assert.match(text, /brief/);
  assert.doesNotMatch(text, /^\{/);
});

test('the agreement and task rails are on the command list', () => {
  const program = new Command();
  program.exitOverride();
  registerAgreementsCommands(program);
  registerTasksCommands(program);
  registerChatsCommands(program);
  const agreements = program.commands.find((command) => command.name() === 'agreements');
  const tasks = program.commands.find((command) => command.name() === 'tasks');
  const agreementNames = agreements?.commands.map((command) => command.name()) ?? [];
  const taskNames = tasks?.commands.map((command) => command.name()) ?? [];
  for (const name of ['claim', 'browse', 'counter', 'fulfill', 'revoke']) {
    assert.ok(agreementNames.includes(name), name);
  }
  for (const name of ['list', 'get', 'create', 'set-result']) {
    assert.ok(taskNames.includes(name), name);
  }
  assert.match(agreements?.commands.find((command) => command.name() === 'respond')?.description() ?? '', /claimed/);
  const artifact = program.commands.find((command) => command.name() === 'artifact');
  const artifactNames = artifact?.commands.map((command) => command.name()) ?? [];
  for (const name of ['record', 'list', 'read', 'download', 'share']) {
    assert.ok(artifactNames.includes(name), name);
  }
});

test('inbox text exposes each responsibility and execution even when events share a chat', () => {
  const text = formatInbox({asOf:'now',ackTo:'opaque',chats:[],tasksAwaitingMe:[],proposalsAwaitingMe:[],deliveries:[
    {kind:'message',chatId:'room',resourceId:'same-message',ts:'now',responsibilityId:'receipt-a',executionContext:{contextId:'execution-a'}},
    {kind:'message',chatId:'room',resourceId:'same-message',ts:'now',responsibilityId:'receipt-b',executionContext:{contextId:'execution-b'}},
  ]} as never);
  for (const id of ['receipt-a','receipt-b','execution-a','execution-b']) assert.ok(text.includes(id));
  assert.match(text, /Observe through: --ack opaque/);
});
