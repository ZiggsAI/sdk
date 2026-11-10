/**
 * Claude-brain chat tool ergonomics: replying to whoever woke you must not
 * require the model to restate the recipient (a missing receiverId cost a
 * failed tool call + a full extra LLM turn per reply).
 */
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { messageSendTool } from '../src/brain/claudeSdkTools.js';

type SendEffect = { kind: string; receiverId?: string; text?: string; sessionId?: string };

// As the shared executor builds it: the processing lane routes effects; the
// wake's address, when it has one, is only ever its explicit destination.
const ctxWith = (over: Record<string, unknown>) => ({
  operatorKey: 'op-key',
  agentId: 'agent-me',
  sessionId: 'chat-1',
  ...over,
});

import { createDeliveryWriteKeys } from '../src/runtime/deliveryWriteKeys.js';

import { contextSnapshotTool, listTasksTool, CLAUDE_SDK_TOOLS } from '../src/brain/claudeSdkTools.js';

describe('task_list (ZIG-977)', () => {
  it('is registered on the hosted Claude tool surface', () => {
    assert.ok(CLAUDE_SDK_TOOLS.some((t) => t.schema.function['name'] === 'task_list'));
  });

  it('ZIG-1278: retired chat_open is absent from the Claude tool surface', () => {
    assert.equal(CLAUDE_SDK_TOOLS.some((t) => t.schema.function['name'] === 'chat_open'), false);
  });

  it('requires operatorKey in tool context', async () => {
    await assert.rejects(
      () => listTasksTool.handler({ assignedToMe: true }, { agentId: 'agent-me' } as never),
      /operatorKey/,
    );
  });
});

describe('context_snapshot default cap (ZIG-860)', () => {
  it('caps message history at 12 by default — an uncapped snapshot ballooned every wake', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({}, ctxWith({ eff }));
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as { opts?: { maxMessages?: number } };
    assert.equal(effect.opts?.maxMessages, 12);
  });

  it('honors an explicit larger maxMessages', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({ maxMessages: 50 }, ctxWith({ eff }));
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as { opts?: { maxMessages?: number } };
    assert.equal(effect.opts?.maxMessages, 50);
  });
});

describe('explicit resource selection', () => {
  it('blank retained selectors use the current wake without naming a room', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({ messageId: '  ' }, ctxWith({ eff }));
    const effect = eff.mock.calls[0].arguments[0] as any;
    assert.equal(effect.sessionId, 'chat-1');
    assert.equal(effect.opts.addressId, undefined);
    assert.equal(effect.opts.via, undefined);
  });
  it('an explicit task wins over the processing session', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({ taskId: 'task-other', agreementId: 'work' }, ctxWith({ eff }));
    const effect = eff.mock.calls[0].arguments[0] as any;
    assert.equal(effect.sessionId, 'task-other');
    assert.equal(effect.opts.via, 'task:task-other');
    assert.deepEqual(effect.opts.workScopes, [{agreementId:'work',taskId:'task-other'}]);
  });
  it('rejects retired address arguments rather than reading a fallback', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    for (const addressId of ['', 'room']) await assert.rejects(() => contextSnapshotTool.handler({addressId}, ctxWith({eff})), /addressId is not supported/);
    assert.equal(eff.mock.calls.length, 0);
    assert.equal(JSON.stringify(contextSnapshotTool.schema).includes('via=address:'), false);
    assert.equal('addressId' in ((contextSnapshotTool.schema.function.parameters as any).properties ?? {}), false);
  });
  it('with no wake or resource, the error names the retained selectors', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await assert.rejects(() => contextSnapshotTool.handler({}, {operatorKey:'op',agentId:'a',eff} as never), /no selected resource.*messageId/s);
    assert.equal(eff.mock.calls.length, 0);
  });
});

describe('exact-resource snapshots', () => {
  it('selects a message independently of the wake address and agreement', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({ messageId: 'question' }, ctxWith({ eff }));
    const effect = eff.mock.calls[0].arguments[0] as any;
    assert.equal(effect.sessionId, 'question');
    assert.equal(effect.opts.via, 'message:question');
    assert.deepEqual(effect.opts.workScopes, [{ messageId: 'question', artifactId: undefined }]);
  });
  it('rejects competing exact and work selectors before reading', async () => {
    const eff = mock.fn(async () => ({}));
    await assert.rejects(() => contextSnapshotTool.handler({ messageId: 'question', agreementId: 'deal' }, ctxWith({ eff })), /select one exact/);
    assert.equal(eff.mock.calls.length, 0);
  });
});

describe('canonical message command', () => {
  const command = {operationId:'stable',content:{text:'Hello'},audience:{kind:'explicit',principalIds:['person','silent']},deliveries:{kind:'explicit',principalIds:['person']},intent:'fyi'};
  it('forwards the explicit command unchanged without deriving anything from a session or wake sender', async()=>{
    const eff=mock.fn(async()=>({ok:true}));
    await messageSendTool.handler({command},ctxWith({eff,senderId:'unrelated'}));
    assert.deepEqual(eff.mock.calls[0].arguments[0],{kind:'send-message',sessionId:'chat-1',command});
  });
  for(const invalid of [{text:'old'}, {command:{...command,operationId:''}}, {command:{...command,addressId:'room'}}]) it(`rejects a missing or superseded command ${JSON.stringify(invalid)}`,async()=>{
    const eff=mock.fn(async()=>({ok:true}));await assert.rejects(()=>messageSendTool.handler(invalid,ctxWith({eff})));assert.equal(eff.mock.calls.length,0);
  });
  it('forwards a request with its reply link unchanged: the flag wakes, the link only points',async()=>{
    const eff=mock.fn(async()=>({ok:true}));
    const request={...command,intent:'request',relationships:{replyToMessageId:'question'}};
    await messageSendTool.handler({command:request},ctxWith({eff}));
    assert.deepEqual((eff.mock.calls[0].arguments[0] as any).command, request);
  });
  it('rejects the retired effect field',async()=>{
    const eff=mock.fn(async()=>({ok:true}));
    await assert.rejects(()=>messageSendTool.handler({command:{...command,effect:{kind:'none'}}},ctxWith({eff})),/unknown field/);
    assert.equal(eff.mock.calls.length,0);
  });
});

describe('bucket tools every hosted agent has', () => {
  const names = () => CLAUDE_SDK_TOOLS.map((tool) => String(tool.schema.function.name));
  it('start a conversation, send in it, and put a file in a bucket with someone', () => {
    for (const name of ['bucket_create', 'bucket_send', 'bucket_insert']) {
      assert.ok(names().includes(name), `${name} is a default tool`);
    }
  });
  it('leave the rest of the bucket tools opt-in', () => {
    for (const name of ['bucket_delete', 'bucket_remove', 'bucket_add_members', 'bucket_remove_member']) {
      assert.ok(!names().includes(name), `${name} stays opt-in`);
    }
  });
});
