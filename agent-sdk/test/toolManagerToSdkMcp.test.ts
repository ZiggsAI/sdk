/**
 * ZIG-775: the Claude Agent SDK MCP bridge must route tool execution through
 * the shared `eff({ kind: 'tool-call' })` path (so tools emit operation
 * artifacts + telemetry), NOT call the raw ToolDefinition handler.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSdkToolDefs } from '../src/brain/toolManagerToSdkMcp.js';
import { defineTool } from '../src/tools/defineTool.js';
import { createDeliveryWriteKeys } from '../src/runtime/deliveryWriteKeys.js';
import type { ClaudeSdkToolContext } from '../src/brain/claudeSdkTools.js';
import type { Effect, EffectHandler } from '../src/types.js';

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const toolDef = defineTool(
  'task_set_result',
  { taskId: { type: 'string', required: true } },
  async () => ({ ok: true }),
  { description: 'update a task' },
);

const call = (handler: (a: Record<string, unknown>, extra: unknown) => Promise<unknown>, args: Record<string, unknown>) =>
  handler(args, undefined) as Promise<TextResult>;

describe('buildSdkToolDefs (ZIG-775)', () => {
  it('routes execution through eff({ kind: "tool-call" }) with the invoking user + runId', async () => {
    const effects: Effect[] = [];
    const eff = (async (effect: Effect) => {
      effects.push(effect);
      return { ok: true, result: { done: true } };
    }) as EffectHandler;

    const ctx: ClaudeSdkToolContext = {
      operatorKey: 'op', agentId: 'agent-1', chatId: 'chat-1',
      eff, senderId: 'user-9', senderType: 'USER', runId: 'run-1',
    };
    const [sdkTool] = buildSdkToolDefs([toolDef], () => ctx);
    const result = await call(sdkTool.handler, { taskId: 't1' });

    assert.equal(effects.length, 1);
    const e = effects[0] as Extract<Effect, { kind: 'tool-call' }>;
    assert.equal(e.kind, 'tool-call');
    assert.equal(e.name, 'task_set_result');
    assert.deepEqual(e.args, { taskId: 't1' });
    assert.equal(e.sessionId, 'chat-1');
    assert.equal(e.senderId, 'user-9');
    assert.equal(e.senderType, 'USER');
    assert.equal(e.runId, 'run-1');
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /done/);
  });

  it('threads the wake write keys onto the tool-call effect (delivery law idempotency)', async () => {
    const effects: Effect[] = [];
    const eff = (async (effect: Effect) => {
      effects.push(effect);
      return { ok: true, result: {} };
    }) as EffectHandler;
    const writeKeys = createDeliveryWriteKeys('agent-1:chat-1', { type: 'message', messageId: 'm-1' });
    const ctx: ClaudeSdkToolContext = { operatorKey: 'op', agentId: 'agent-1', chatId: 'chat-1', eff, writeKeys };

    const [sdkTool] = buildSdkToolDefs([toolDef], () => ctx);
    await call(sdkTool.handler, { taskId: 't1' });

    const e = effects[0] as Extract<Effect, { kind: 'tool-call' }>;
    assert.equal(e.writeKeys, writeKeys);
  });

  it('passes a coverage refusal code and its sentence to the model', async () => {
    const refusal = new Error(
      "You have used the 3 free messages this agent's contact setting allows with seo-growth. Hire it to keep talking.",
    );
    (refusal as Error & { code: string }).code = 'CONVERSATION_ALLOWANCE_EXHAUSTED';
    const eff = (async () => {
      throw refusal;
    }) as EffectHandler;
    const ctx: ClaudeSdkToolContext = { operatorKey: 'op', agentId: 'a', chatId: 'c', eff };
    const [sdkTool] = buildSdkToolDefs([toolDef], () => ctx);
    const result = await call(sdkTool.handler, { taskId: 't1' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^CONVERSATION_ALLOWANCE_EXHAUSTED: /);
    assert.match(result.content[0].text, /Hire it to keep talking/);
  });

  it('maps a failed ToolCallResult to an MCP error result', async () => {
    const eff = (async () => ({ ok: false, error: 'boom' })) as EffectHandler;
    const ctx: ClaudeSdkToolContext = { operatorKey: 'op', agentId: 'a', chatId: 'c', eff };
    const [sdkTool] = buildSdkToolDefs([toolDef], () => ctx);
    const result = await call(sdkTool.handler, { taskId: 't1' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /boom/);
  });

  it('returns execution refusal codes as structured MCP errors', async () => {
    const eff = (async () => ({ ok: false, errorCode: 'AGREEMENT_REQUIRED', error: 'Select authorized work.' })) as EffectHandler;
    const ctx: ClaudeSdkToolContext = { operatorKey: 'op', agentId: 'a', chatId: 'c', eff };
    const [sdkTool] = buildSdkToolDefs([toolDef], () => ctx);
    const result = await call(sdkTool.handler, { taskId: 't1' });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { code: 'AGREEMENT_REQUIRED', message: 'Select authorized work.' });
  });

  it('presents the runtime task binding alongside the original tool result', async () => {
    const execution = { agreementId: 'a1', taskId: 't1' };
    const eff = (async () => ({ ok: true, result: 'done', execution })) as EffectHandler;
    const ctx: ClaudeSdkToolContext = { operatorKey: 'op', agentId: 'a', chatId: 'c', eff };
    const [sdkTool] = buildSdkToolDefs([toolDef], () => ctx);
    const result = await call(sdkTool.handler, { taskId: 't1' });
    assert.equal(result.content[0].text, 'done');
    assert.deepEqual(JSON.parse(result.content[1].text), { execution });
  });

  it('errors clearly when the tool context has no eff', async () => {
    const ctx = { operatorKey: 'op', agentId: 'a', chatId: 'c' } as ClaudeSdkToolContext;
    const [sdkTool] = buildSdkToolDefs([toolDef], () => ctx);
    const result = await call(sdkTool.handler, { taskId: 't1' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /missing eff/);
  });

  it('unwraps the no-params `_` envelope before dispatching', async () => {
    const effects: Effect[] = [];
    const eff = (async (effect: Effect) => { effects.push(effect); return { ok: true, result: 'ok' }; }) as EffectHandler;
    const ctx: ClaudeSdkToolContext = { operatorKey: 'op', agentId: 'a', chatId: 'c', eff };
    const noParamTool = defineTool('ziggs_inbox', {}, async () => ({}), { description: 'inbox' });
    const [sdkTool] = buildSdkToolDefs([noParamTool], () => ctx);
    await call(sdkTool.handler, { _: { foo: 'bar' } });
    const e = effects[0] as Extract<Effect, { kind: 'tool-call' }>;
    assert.deepEqual(e.args, { foo: 'bar' });
  });
});
