import { parseScope } from '../src/commands/grants.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInbox } from '../src/commands/inbox.js';
import { Command } from 'commander';
import { readTypeForVia, readTypeError } from '../src/commands/read.js';
import { registerContextCommands, formatSnapshot } from '../src/commands/context.js';
import { registerAgreementsCommands } from '../src/commands/agreements.js';
import { registerTasksCommands } from '../src/commands/tasks.js';
import { registerChatsCommands } from '../src/commands/chats.js';
import type { ContextSnapshotResult } from '@ziggs-ai/api-client';

test('messages uses explicit canonical query filters and send accepts one command', () => {
  const program = new Command();registerChatsCommands(program);
  const query=program.commands.find(c=>c.name()==='messages')!;
  assert.deepEqual(query.registeredArguments, []);
  assert.ok(query.options.some(o=>o.long==='--participants'));
  assert.ok(query.options.some(o=>o.long==='--agreement'));
  assert.deepEqual(program.commands.find(c=>c.name()==='send')!.registeredArguments.map(a=>a.name()), ['commandJson']);
});

test('read task:id is a task read, and a wrong type names --type', () => {
  assert.equal(readTypeForVia('task:abc'), 'tasks');
  assert.equal(readTypeForVia('agreement:abc'), 'agreements');
  assert.equal(readTypeForVia('artifact:abc'), 'artifacts');
  assert.throws(()=>readTypeForVia('address:abc'),/Use agreement/);
  assert.equal(readTypeForVia('task:abc', 'artifacts'), 'artifacts');
  const error = readTypeError('task:abc', 'agreements');
  assert.match(error ?? '', /--type/);
  assert.equal(readTypeError('task:abc', 'tasks'), null);
  assert.equal(readTypeError('message:exact', 'artifacts'), 'Use snapshot message:exact for exact message context');
  assert.match(readTypeError('address:retired', 'artifacts') ?? '', /room entries are retired/);
});

test('a snapshot is a scan, not a JSON blob', () => {
  const text = formatSnapshot({
    history: [{}, {}],
    agreements: [{ agreementId: 'agr-1', proposalStatus: 'approved', description: 'do the work' }],
    agents: [{ agentId: 'agent-1', role: 'member' }],
    users: [{ userId: 'user-1', role: 'member', isYou: true }],
    artifacts: {
      type: 'artifacts',
      via: { kind: 'agreement', id: 'a' },
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
  for (const name of ['record', 'list', 'read', 'download']) {
    assert.ok(artifactNames.includes(name), name);
  }
  // An artifact is shared by adding it to a bucket, not from the terminal.
  assert.equal(artifactNames.includes('share'), false);
});

test('inbox text exposes each responsibility and execution even when events share a chat', () => {
  const text = formatInbox({asOf:'now',ackTo:'opaque',chats:[],tasksAwaitingMe:[],proposalsAwaitingMe:[],deliveries:[
    {kind:'message',addressId:'room',resourceId:'same-message',ts:'now',receiptId:'receipt-a',executionContext:{contextId:'execution-a'}},
    {kind:'message',addressId:'room',resourceId:'same-message',ts:'now',receiptId:'receipt-b',executionContext:{contextId:'execution-b'}},
  ]} as never);
  for (const id of ['receipt-a','receipt-b','execution-a','execution-b']) assert.ok(text.includes(id));
  assert.match(text, /Observe through: --ack opaque/);
});

test('agreement formation has no mandatory room or hire-admission option', () => {
  const program = new Command(); registerAgreementsCommands(program);
  const agreements = program.commands.find(c => c.name() === 'agreements')!;
  for (const name of ['propose', 'delegate', 'claim']) {
    const command = agreements.commands.find(c => c.name() === name)!;
    assert.equal(command.options.some(o => o.long === '--chat' && o.mandatory), false);
    if (name !== 'propose') assert.equal(command.options.some(o => o.long === '--chat'), false);
  }
});

test('snapshot CLI forwards an exact resource without creating or joining a room', async t => {
  const priorKey=process.env.ZIGGS_OPERATOR_KEY, priorAgent=process.env.ZIGGS_AGENT_ID;
  process.env.ZIGGS_OPERATOR_KEY='fixture-key';process.env.ZIGGS_AGENT_ID='fixture-agent';
  t.after(()=>{if(priorKey===undefined)delete process.env.ZIGGS_OPERATOR_KEY;else process.env.ZIGGS_OPERATOR_KEY=priorKey;if(priorAgent===undefined)delete process.env.ZIGGS_AGENT_ID;else process.env.ZIGGS_AGENT_ID=priorAgent;});
  const urls:string[]=[];
  t.mock.method(globalThis,'fetch',async(url:unknown)=>{urls.push(String(url));return Response.json({history:[],agreements:[],agents:[],users:[]});});
  t.mock.method(console,'log',()=>{});
  const program=new Command();program.exitOverride();registerContextCommands(program);
  assert.deepEqual(program.commands.find(command=>command.name()==='snapshot')!.registeredArguments.map(arg=>arg.name()),['via']);
  await program.parseAsync(['snapshot','message:exact-message','--max-messages','12'],{from:'user'});
  assert.equal(urls.length,1);assert.equal(new URL(urls[0]).pathname,'/context/snapshot');
  assert.equal(new URL(urls[0]).searchParams.get('via'),'message:exact-message');
  assert.equal(new URL(urls[0]).searchParams.get('maxMessages'),'12');
});

test('grant mutation selectors reject room and malformed scopes without narrowing historical grant types',()=>{
 assert.deepEqual(parseScope('artifact:exact'),{kind:'artifact',id:'exact'});
 assert.deepEqual(parseScope('agreement:work'),{kind:'agreement',id:'work'});
 for(const value of ['address:old','person:room-directory','made-up:scope','task:']) assert.throws(()=>parseScope(value),/retained resource/);
});
