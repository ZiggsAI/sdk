import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../src/runtime/runTurn.js';
import { ToolManager } from '../src/tools/ToolManager.js';
import { PromptBuilder } from '../src/runtime/PromptBuilder.js';
import type { Ctx, Identity, Effect, EffectHandler } from '../src/types.js';

const IDENTITY: Identity = { agentId: 'test-agent', sessionId: 'c1', laneKey: 'test-agent:c1' };

function makeCtx(extra: Partial<Ctx> = {}): Ctx {
  return {
    identity: IDENTITY,
    tasks: {},
    activeAgreementId: null,
    activeTaskId: null,
    pendingProposalAgreementId: null,
    pendingSubtasks: {},
    collectedResults: [],
    delegatedAgreementIds: [],
    toolResults: [],
    lastOutcome: { kind: 'enter' },
    ...extra,
  } as Ctx;
}

interface MakeEffOpts {
  llm: { chatMessages: (...args: any[]) => Promise<any> };
  toolManager: ToolManager;
  streamText?: (effect: any) => Promise<{ text: string; usage?: any }>;
  sendMessageImpl?: (effect: any) => Promise<{ ok: true }>;
  onSendMessage?: (text: string, receiverId: string, sessionId: string) => void;
}

function makeEff({ llm, toolManager, streamText, sendMessageImpl, onSendMessage }: MakeEffOpts): EffectHandler {
  const snap = { history: [], agreements: [], agents: [], users: [{ userId: 'u1' }] };
  const handler = async (effect: Effect): Promise<unknown> => {
    switch (effect.kind) {
      case 'read-context':
        return snap;
      case 'llm-call':
        return await llm.chatMessages(effect.messages, effect.tools);
      case 'tool-call': {
        try {
          const result = await toolManager.executeTool(effect.name, (effect.args as any) || {}, {
            operatorKey: 'test-key', agentId: 'test-agent', chatId: effect.sessionId,
            taskService: {}, agreementService: {}, agents: snap.agents || [], turnScratch: {},
          } as any);
          return { ok: true, result };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? String(err) };
        }
      }
      case 'stream-text':
        if (!streamText) throw new Error('stream-text not stubbed');
        return await streamText(effect);
      case 'send-message':
        if (sendMessageImpl) return await sendMessageImpl(effect);
        onSendMessage?.(effect.text, effect.receiverId, effect.sessionId);
        return { ok: true };
      case 'record-event':
        return { ok: true };
      default:
        return undefined;
    }
  };
  return handler as EffectHandler;
}

const RESPOND_ACTIONS = { respond: { prompt: { instruction: 'respond' }, produces: 'message-sent' as const } };
const INCOMING = { type: 'message', text: 'hi', senderId: 'u1', senderType: 'USER' } as any;

describe('runTurn send-path honesty', () => {
  it('A1: stream failure falls back to non-streaming send', async () => {
    const toolManager = new ToolManager();
    let call = 0;
    const llm = {
      async chatMessages() {
        call++;
        if (call === 1) return { content: JSON.stringify({ thought: 't', action: 'respond', receiverId: 'u1' }) };
        return { content: 'hello from fallback' };
      },
    };
    const sends: Array<{ text: string; receiverId: string }> = [];
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      streamRespondActions: true,
      eff: makeEff({ llm, toolManager, streamText: async () => { throw new Error('ws torn down'); }, onSendMessage: (text, receiverId) => sends.push({ text, receiverId }) }),
    });
    assert.equal(sends.length, 1);
    assert.equal(sends[0].text, 'hello from fallback');
    assert.equal(sends[0].receiverId, 'u1');
    assert.equal(out.outcome.kind, 'message-sent');
    assert.equal(out.llmCalls, 2);
  });

  it('A2: stream failure + fallback send failure → send-failed error outcome', async () => {
    const toolManager = new ToolManager();
    let call = 0;
    const llm = {
      async chatMessages() {
        call++;
        if (call === 1) return { content: JSON.stringify({ thought: 't', action: 'respond', receiverId: 'u1' }) };
        return { content: 'hello from fallback' };
      },
    };
    const sends: any[] = [];
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      streamRespondActions: true,
      eff: makeEff({ llm, toolManager, streamText: async () => { throw new Error('ws torn down'); }, sendMessageImpl: async () => { throw new Error('backend 503'); } }),
    });
    assert.deepEqual(out.outcome, { kind: 'error', source: 'protocol', cause: 'send-failed', retryable: false });
    assert.equal(sends.length, 0);
  });

  it('A3: stream resolves empty text → fallback llm-call used', async () => {
    const toolManager = new ToolManager();
    let call = 0;
    const llm = {
      async chatMessages() {
        call++;
        if (call === 1) return { content: JSON.stringify({ thought: 't', action: 'respond', receiverId: 'u1' }) };
        return { content: 'hello from fallback' };
      },
    };
    const sends: Array<{ text: string }> = [];
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      streamRespondActions: true,
      eff: makeEff({ llm, toolManager, streamText: async () => ({ text: '' }), onSendMessage: (text) => sends.push({ text }) }),
    });
    assert.equal(sends.length, 1);
    assert.equal(sends[0].text, 'hello from fallback');
    assert.equal(out.llmCalls, 2);
    assert.equal(out.outcome.kind, 'message-sent');
  });

  it('A4: streamed reply usage is counted into the turn tokens (ZIG-813)', async () => {
    const toolManager = new ToolManager();
    const llm = {
      async chatMessages() {
        return {
          content: JSON.stringify({ thought: 't', action: 'respond', receiverId: 'u1' }),
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        };
      },
    };
    const sends: Array<{ text: string }> = [];
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      streamRespondActions: true,
      eff: makeEff({
        llm, toolManager,
        // The streamed reply (call 2) is a real billed completion. Before the
        // fix its tokens vanished from every sink.
        streamText: async () => ({ text: 'hello there', usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }),
        onSendMessage: (text) => sends.push({ text }),
      }),
    });
    assert.equal(out.outcome.kind, 'message-sent');
    assert.equal(sends[0].text, 'hello there');
    // decision call (12) + streamed reply (140) both counted into the tick total
    assert.equal(out.tokens.total, 152);
    assert.equal(out.tokens.output, 42);
    assert.equal(out.tokens.input, 110);
    assert.equal(out.llmCalls, 2);
  });

  it('A5: streaming is the default for a user-facing respond (ZIG-838)', async () => {
    const prev = process.env.ENABLE_LLM_STREAMING;
    delete process.env.ENABLE_LLM_STREAMING; // unset → default on
    try {
      const toolManager = new ToolManager();
      const llm = {
        async chatMessages() {
          return { content: JSON.stringify({ thought: 't', action: 'respond', receiverId: 'u1' }) };
        },
      };
      const streamed: string[] = [];
      const sends: Array<{ text: string }> = [];
      const out = await runTurn({
        stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
        ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
        // no streamRespondActions — the default must stream
        eff: makeEff({ llm, toolManager, streamText: async () => { streamed.push('called'); return { text: 'streamed reply' }; }, onSendMessage: (text) => sends.push({ text }) }),
      });
      assert.deepEqual(streamed, ['called']);
      assert.equal(sends.length, 1);
      assert.equal(sends[0].text, 'streamed reply');
      assert.equal(out.outcome.kind, 'message-sent');
    } finally {
      if (prev === undefined) delete process.env.ENABLE_LLM_STREAMING;
      else process.env.ENABLE_LLM_STREAMING = prev;
    }
  });

  it('A6: ENABLE_LLM_STREAMING=false is a kill-switch — no stream-text effect', async () => {
    const prev = process.env.ENABLE_LLM_STREAMING;
    process.env.ENABLE_LLM_STREAMING = 'false';
    try {
      const toolManager = new ToolManager();
      const llm = {
        async chatMessages() {
          return { content: JSON.stringify({ thought: 't', action: 'respond', receiverId: 'u1', message: 'plain reply' }) };
        },
      };
      const streamed: string[] = [];
      const sends: Array<{ text: string }> = [];
      const out = await runTurn({
        stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
        ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
        eff: makeEff({ llm, toolManager, streamText: async () => { streamed.push('called'); return { text: 'should not be used' }; }, onSendMessage: (text) => sends.push({ text }) }),
      });
      assert.deepEqual(streamed, []); // stream-text never invoked
      assert.deepEqual(sends, [{ text: 'plain reply' }]);
      assert.equal(out.outcome.kind, 'message-sent');
    } finally {
      if (prev === undefined) delete process.env.ENABLE_LLM_STREAMING;
      else process.env.ENABLE_LLM_STREAMING = prev;
    }
  });

  it('B1: partial multi-send failure keeps successes and stays message-sent', async () => {
    const toolManager = new ToolManager();
    const llm = {
      async chatMessages() {
        return { content: JSON.stringify({ thought: 't', action: 'respond', messages: [{ receiverId: 'u1', message: 'a' }, { receiverId: 'u2', message: 'b' }] }) };
      },
    };
    const sends: string[] = [];
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      eff: makeEff({ llm, toolManager, sendMessageImpl: async (e: any) => { if (e.receiverId === 'u2') throw new Error('u2 down'); sends.push(e.receiverId); return { ok: true }; } }),
    });
    assert.deepEqual(sends, ['u1']);
    assert.equal(out.outcome.kind, 'message-sent');
  });

  it('B2: all multi-sends fail → send-failed error outcome', async () => {
    const toolManager = new ToolManager();
    const llm = {
      async chatMessages() {
        return { content: JSON.stringify({ thought: 't', action: 'respond', messages: [{ receiverId: 'u1', message: 'a' }, { receiverId: 'u2', message: 'b' }] }) };
      },
    };
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      eff: makeEff({ llm, toolManager, sendMessageImpl: async () => { throw new Error('all down'); } }),
    });
    assert.deepEqual(out.outcome, { kind: 'error', source: 'protocol', cause: 'send-failed', retryable: false });
  });

  // A 409 on a wake-derived messageId means this wake's reply already exists —
  // persisted by a crash-replay predecessor or by a second host racing the same
  // at-least-once delivery. The re-run LLM produces different text, so the
  // backend rejects rather than no-ops (ZIG-932); the turn must treat that as
  // delivered-by-the-other-attempt, never as a send failure.
  const conflict409 = () =>
    Object.assign(
      new Error('messageId sdk_idem_wk_x_m1 was already used in chat c1 with different content'),
      { status: 409 },
    );

  it('F1: streaming send 409 → duplicate dropped, turn ends message-sent', async () => {
    const toolManager = new ToolManager();
    let call = 0;
    const llm = {
      async chatMessages() {
        call++;
        if (call === 1) return { content: JSON.stringify({ thought: 't', action: 'respond', receiverId: 'u1' }) };
        return { content: 'regenerated reply' };
      },
    };
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      streamRespondActions: true,
      eff: makeEff({ llm, toolManager, streamText: async () => ({ text: 'streamed reply' }), sendMessageImpl: async () => { throw conflict409(); } }),
    });
    assert.equal(out.outcome.kind, 'message-sent');
  });

  it('F2: non-streaming send 409 → duplicate dropped, turn ends message-sent', async () => {
    const toolManager = new ToolManager();
    const llm = {
      async chatMessages() {
        return { content: JSON.stringify({ thought: 't', action: 'respond', receiverId: 'u1', message: 'hello again' }) };
      },
    };
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      streamRespondActions: false,
      eff: makeEff({ llm, toolManager, sendMessageImpl: async () => { throw conflict409(); } }),
    });
    assert.equal(out.outcome.kind, 'message-sent');
  });

  it('F3: multi-send with one 409 → skipped as duplicate, others delivered, message-sent', async () => {
    const toolManager = new ToolManager();
    const llm = {
      async chatMessages() {
        return { content: JSON.stringify({ thought: 't', action: 'respond', messages: [{ receiverId: 'u1', message: 'a' }, { receiverId: 'u2', message: 'b' }] }) };
      },
    };
    const sends: string[] = [];
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      eff: makeEff({ llm, toolManager, sendMessageImpl: async (e: any) => { if (e.receiverId === 'u1') throw conflict409(); sends.push(e.receiverId); return { ok: true }; } }),
    });
    assert.deepEqual(sends, ['u2']);
    assert.equal(out.outcome.kind, 'message-sent');
  });

  it('C1: garbage decision → reprompt once → success', async () => {
    const toolManager = new ToolManager();
    let call = 0;
    const seenMessages: any[][] = [];
    const llm = {
      async chatMessages(messages: any[]) {
        call++;
        seenMessages.push(messages);
        if (call === 1) return { content: 'lol not json at all' };
        return { content: JSON.stringify({ thought: 't', action: 'respond', receiverId: 'u1', message: 'recovered' }) };
      },
    };
    const sends: string[] = [];
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      streamRespondActions: false, // reprompt semantics under test, not streaming
      eff: makeEff({ llm, toolManager, onSendMessage: (text) => sends.push(text) }),
    });
    assert.equal(out.llmCalls, 2);
    const secondCallMsgs = seenMessages[1];
    assert.ok(secondCallMsgs.some((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Your last output was not a valid action')));
    assert.deepEqual(sends, ['recovered']);
    assert.equal(out.outcome.kind, 'message-sent');
  });

  it('C2: garbage twice → unparseable-decision error, exactly 2 llm calls', async () => {
    const toolManager = new ToolManager();
    let call = 0;
    const llm = { async chatMessages() { call++; return { content: 'still not json' }; } };
    const sends: string[] = [];
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      eff: makeEff({ llm, toolManager, onSendMessage: (text) => sends.push(text) }),
    });
    assert.equal(call, 2);
    assert.equal(sends.length, 0);
    assert.deepEqual(out.outcome, { kind: 'error', source: 'llm', cause: 'unparseable-decision', retryable: false });
  });

  it('D1: a message without receiverId is sent without one', async () => {
    const toolManager = new ToolManager();
    let call = 0;
    const llm = {
      async chatMessages() {
        call++;
        return { content: JSON.stringify({ thought: 't', action: 'respond', message: 'hi there' }) };
      },
    };
    const sends: Array<{ text: string; receiverId: string | undefined }> = [];
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      streamRespondActions: false,
      eff: makeEff({ llm, toolManager, onSendMessage: (text, receiverId) => sends.push({ text, receiverId }) }),
    });
    assert.equal(call, 1);
    assert.equal(out.llmCalls, 1);
    assert.deepEqual(sends, [{ text: 'hi there', receiverId: undefined }]);
    assert.equal(out.outcome.kind, 'message-sent');
  });

  it('D2: respond missing message twice → unparseable-decision', async () => {
    const toolManager = new ToolManager();
    const llm = { async chatMessages() { return { content: JSON.stringify({ thought: 't', action: 'respond' }) }; } };
    const sends: string[] = [];
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      eff: makeEff({ llm, toolManager, onSendMessage: (text) => sends.push(text) }),
    });
    assert.equal(out.llmCalls, 2);
    assert.equal(sends.length, 0);
    assert.deepEqual(out.outcome, { kind: 'error', source: 'llm', cause: 'unparseable-decision', retryable: false });
  });

  it('D3: pause-style action with produces wait ends as wait, not reprompt', async () => {
    const toolManager = new ToolManager();
    let call = 0;
    const llm = { async chatMessages() { call++; return { content: '{"thought":"nothing to do","action":"hold"}' }; } };
    const out = await runTurn({
      stateId: 's', statePrompt: { goal: 'g' },
      actions: { hold: { prompt: { instruction: 'hold' }, produces: 'wait' as const } },
      incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      eff: makeEff({ llm, toolManager }),
    });
    assert.equal(call, 1);
    assert.equal(out.outcome.kind, 'wait');
  });
});

import { createDeliveryWriteKeys } from '../src/runtime/deliveryWriteKeys.js';

// Delivery law, idempotent writes: every user-visible send of a wake carries a
// wake-derived messageId, so a crash-replay of the wake re-sends under the
// SAME id and the backend's (chatId, messageId) dedup drops the duplicate.
describe('runTurn wake-derived messageIds', () => {
  const WAKE = { type: 'message', messageId: 'm-1' };

  it('E1: streaming respond persists under a wake-derived id; a replayed wake re-derives it', async () => {
    const run = async () => {
      const toolManager = new ToolManager();
      const llm = { async chatMessages() { return { content: JSON.stringify({ thought: 't', action: 'respond', receiverId: 'u1' }) }; } };
      const ids: Array<string | undefined> = [];
      await runTurn({
        stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
        ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
        streamRespondActions: true,
        writeKeys: createDeliveryWriteKeys('test-agent:c1', WAKE),
        eff: makeEff({ llm, toolManager, streamText: async () => ({ text: 'streamed reply' }), sendMessageImpl: async (e: any) => { ids.push(e.messageId); return { ok: true }; } }),
      });
      return ids;
    };
    const first = await run();
    const replay = await run();
    assert.equal(first.length, 1);
    assert.match(String(first[0]), /^sdk_idem_wk_[0-9a-f]{40}_m_[0-9a-f]{16}$/);
    assert.deepEqual(replay, first);
  });

  it('E2: non-streaming sends get the content-derived id stamped by the effect wrapper (ZIG-1045)', async () => {
    const toolManager = new ToolManager();
    const llm = {
      async chatMessages() {
        return { content: JSON.stringify({ thought: 't', action: 'respond', messages: [{ receiverId: 'u1', message: 'a' }, { receiverId: 'u2', message: 'b' }] }) };
      },
    };
    const ids: Array<string | undefined> = [];
    await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      streamRespondActions: false,
      writeKeys: createDeliveryWriteKeys('test-agent:c1', WAKE),
      eff: makeEff({ llm, toolManager, sendMessageImpl: async (e: any) => { ids.push(e.messageId); return { ok: true }; } }),
    });
    assert.equal(ids.length, 2);
    assert.match(String(ids[0]), /^sdk_idem_wk_[0-9a-f]{40}_m_[0-9a-f]{16}$/);
    assert.match(String(ids[1]), /^sdk_idem_wk_[0-9a-f]{40}_m_[0-9a-f]{16}$/);
    assert.notEqual(ids[0], ids[1]); // distinct texts / receivers → distinct keys
  });

  it('E3: a keyless wake (timer) leaves messageId undefined — transport generates as before', async () => {
    const toolManager = new ToolManager();
    const llm = {
      async chatMessages() {
        return { content: JSON.stringify({ thought: 't', action: 'respond', receiverId: 'u1', message: 'plain reply' }) };
      },
    };
    const ids: Array<string | undefined> = [];
    await runTurn({
      stateId: 's', statePrompt: { goal: 'g' }, actions: RESPOND_ACTIONS, incomingEvent: INCOMING,
      ctx: makeCtx(), toolManager, promptBuilder: new PromptBuilder(), definition: { description: 'd' },
      streamRespondActions: false,
      writeKeys: createDeliveryWriteKeys('test-agent:c1', { type: 'state-timeout', state: 'idle', waitedMs: 5 }),
      eff: makeEff({ llm, toolManager, sendMessageImpl: async (e: any) => { ids.push(e.messageId); return { ok: true }; } }),
    });
    assert.deepEqual(ids, [undefined]);
  });
});
