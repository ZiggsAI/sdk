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

  it('ZIG-1278: chat_open is on the default Claude tool surface', () => {
    assert.ok(CLAUDE_SDK_TOOLS.some((t) => t.schema.function['name'] === 'chat_open'));
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

/**
 * ZIG-1081: an agent told to "start by reading your scope with context_snapshot"
 * has no way to know its own addressId, so the model filled the optional field with
 * "". `??` let the blank beat the lane default and the tool then rejected it as
 * missing — one failed tool call plus a recovery turn at the top of every wake.
 */
describe('blank string arguments fall back to the lane default (ZIG-1081)', () => {
  it('context_snapshot: addressId "" uses the lane session instead of throwing', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({ addressId: '' }, ctxWith({ eff }));
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as { sessionId?: string };
    assert.equal(effect.sessionId, 'chat-1');
  });

  it('context_snapshot: whitespace-only addressId is treated the same as absent', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({ addressId: '   ' }, ctxWith({ eff }));
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as { sessionId?: string };
    assert.equal(effect.sessionId, 'chat-1');
  });

  it('context_snapshot: a real addressId still wins over the lane session', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({ addressId: 'chat-other' }, ctxWith({ eff }));
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as { sessionId?: string; opts?: { addressId?: string } };
    assert.equal(effect.sessionId, 'chat-other');
    // Read as the named conversation, not by looking the session name up.
    assert.equal(effect.opts?.addressId, 'chat-other');
  });

  it('context_snapshot: with no lane and no argument, the error names the lever', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await assert.rejects(
      () => contextSnapshotTool.handler({ addressId: '' }, { operatorKey: 'op', agentId: 'a', eff } as never),
      /no selected resource.*messageId/s,
    );
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
  const command = {operationId:'stable',content:{text:'Hello'},audience:{kind:'explicit',principalIds:['person','silent']},deliveries:{kind:'explicit',principalIds:['person']},effect:{kind:'none'}};
  it('forwards the explicit command unchanged without deriving anything from a session or wake sender', async()=>{
    const eff=mock.fn(async()=>({ok:true}));
    await messageSendTool.handler({command},ctxWith({eff,senderId:'unrelated'}));
    assert.deepEqual(eff.mock.calls[0].arguments[0],{kind:'send-message',sessionId:'chat-1',command});
  });
  for(const invalid of [{text:'old'}, {command:{...command,operationId:''}}, {command:{...command,addressId:'room'}}]) it(`rejects a missing or superseded command ${JSON.stringify(invalid)}`,async()=>{
    const eff=mock.fn(async()=>({ok:true}));await assert.rejects(()=>messageSendTool.handler(invalid,ctxWith({eff})));assert.equal(eff.mock.calls.length,0);
  });
  it('keeps exact answer resolution separate from a causal reply',async()=>{
    const eff=mock.fn(async()=>({ok:true}));
    const answer={...command,effect:{kind:'answer',action:{kind:'message',id:'question',slot:'answer',requestId:'reply'},artifacts:[]},relationships:{replyToMessageId:'question'}};
    await messageSendTool.handler({command:answer},ctxWith({eff}));assert.deepEqual((eff.mock.calls[0].arguments[0] as any).command,answer);
  });
});
