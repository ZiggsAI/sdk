import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeBrain } from '../src/brain/ClaudeBrain.js';
import { backendWakeGate, gateableMessages, type AskWakeGate } from '../src/brain/wakeGate.js';
import { ToolManager } from '../src/tools/ToolManager.js';
import { CLAUDE_SDK_TOOLS } from '../src/brain/claudeSdkTools.js';
import { PROTOCOL_TOOLS } from '../src/platform/tools/tier1/protocolTools.js';
import type { Effect, EffectHandler } from '../src/types.js';

const WORKFLOW = {
  id: 'claude-test',
  description: 'test',
  initial: 'ready',
  states: { ready: { kind: 'parked' as const, transitions: [] } },
};

const IDENTITY = { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' };

function brain(askWakeGate?: AskWakeGate) {
  const toolManager = new ToolManager();
  toolManager.registerAll([...PROTOCOL_TOOLS, ...CLAUDE_SDK_TOOLS]);
  const queryFn = mock.fn(async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      result: 'handled',
      stop_reason: null,
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: {},
      permission_denials: [],
      uuid: '00000000-0000-4000-8000-000000000001',
      session_id: 'sess-1',
    };
  });
  const eff: EffectHandler = async (effect: Effect) => {
    if (effect.kind === 'read-context') {
      return { history: [], agreements: [], agents: [{ agentId: 'claude-test', isYou: true }], users: [] };
    }
    return { ok: true };
  };
  const b = new ClaudeBrain({
    workflow: WORKFLOW,
    toolManager,
    description: 'Test agent',
    model: 'claude-sonnet-5-5',
    anthropicKey: 'test-key',
    operatorKey: 'op-key',
    agentId: 'claude-test',
    queryFn: queryFn as never,
    ...(askWakeGate ? { askWakeGate } : {}),
  });
  return { b, queryFn, eff };
}

const thanks = {
  type: 'message',
  text: 'thanks, great work',
  senderId: 'user-1',
  agreementId: 'agr_1',
};

describe('gateableMessages (ZIG-1990)', () => {
  it('asks only about a wake made entirely of chat speech with text', () => {
    assert.deepEqual(gateableMessages(thanks), [{ text: 'thanks, great work', senderId: 'user-1' }]);
    assert.deepEqual(
      gateableMessages({ type: 'batch', events: [thanks, { type: 'message', text: 'ok' }] }),
      [{ text: 'thanks, great work', senderId: 'user-1' }, { text: 'ok' }],
    );
  });

  it('never asks about work, lifecycle or control, even beside a message', () => {
    for (const other of [
      { type: 'task_result', result: { taskId: 't1', state: 'assigned' } },
      { type: 'agreement_lifecycle', operation: 'proposal_created' },
      { type: 'notification', text: 'task paused' },
    ]) {
      assert.equal(gateableMessages(other), null);
      assert.equal(gateableMessages({ type: 'batch', events: [thanks, other] }), null);
    }
    assert.equal(gateableMessages({ type: 'message', text: '  ' }), null);
    assert.equal(gateableMessages(undefined), null);
  });
});

describe('ClaudeBrain wake gate (ZIG-1990)', () => {
  it('skips the turn on a confident "context"', async () => {
    const ask = mock.fn<AskWakeGate>(async () => ({ wake: false, how: 'context', confidence: 0.93 }));
    const { b, queryFn, eff } = brain(ask);
    const out = await b.tick({ event: thanks, identity: IDENTITY, eff });
    assert.equal(out.parked, true);
    assert.equal(out.skippedReason, 'wake_gate_context');
    assert.equal(out.metrics?.llmCalls, 0);
    assert.equal(queryFn.mock.callCount(), 0);
    assert.deepEqual(ask.mock.calls[0]?.arguments[0], {
      messages: [{ text: 'thanks, great work', senderId: 'user-1' }],
      chatId: 'chat-1',
      agreementId: 'agr_1',
    });
  });

  it('takes the turn when the gate says wake, has no answer, or throws nothing useful', async () => {
    for (const answer of [{ wake: true, how: 'act' }, { wake: true, how: 'unsure' }, null]) {
      const { b, queryFn, eff } = brain(async () => answer);
      const out = await b.tick({ event: thanks, identity: IDENTITY, eff });
      assert.notEqual(out.skippedReason, 'wake_gate_context');
      assert.equal(queryFn.mock.callCount(), 1);
    }
  });

  it('does not ask about a task wake', async () => {
    const ask = mock.fn<AskWakeGate>(async () => ({ wake: false }));
    const { b, eff } = brain(ask);
    await b.tick({
      event: { type: 'task_result', result: { taskId: 't1', state: 'assigned' }, agreementId: 'agr_1' },
      identity: IDENTITY,
      eff,
    });
    assert.equal(ask.mock.callCount(), 0);
  });

  it('has no gate unless one is given', async () => {
    const { b, queryFn, eff } = brain();
    await b.tick({ event: thanks, identity: IDENTITY, eff });
    assert.equal(queryFn.mock.callCount(), 1);
  });
});

describe('backendWakeGate (ZIG-1990)', () => {
  afterEach(() => mock.restoreAll());

  it('posts to the internal route with the agent key and returns the answer', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ wake: false, how: 'context', confidence: 0.9 }), { status: 200 }),
    );
    const ask = backendWakeGate({ operatorKey: 'op-key', agentId: 'claude-test' });
    const out = await ask({ messages: [{ text: 'thanks' }], chatId: 'chat-1' });
    assert.deepEqual(out, { wake: false, how: 'context', confidence: 0.9 });
    const [url, init] = fetchMock.mock.calls[0]!.arguments as [string, RequestInit];
    assert.match(url, /\/internal\/wake-gate$/);
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer op-key');
    assert.equal(headers['X-Agent-Id'], 'claude-test');
  });

  it('answers null on a refusal, a bad body or a network error', async () => {
    const ask = backendWakeGate({ operatorKey: 'op-key', agentId: 'claude-test' });
    mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 404 }));
    assert.equal(await ask({ messages: [{ text: 'hi' }] }), null);
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
    assert.equal(await ask({ messages: [{ text: 'hi' }] }), null);
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });
    assert.equal(await ask({ messages: [{ text: 'hi' }] }), null);
  });
});
