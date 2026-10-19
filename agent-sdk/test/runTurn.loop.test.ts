import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../src/runtime/runTurn.js';
import { ToolManager } from '../src/tools/ToolManager.js';
import { defineTool } from '../src/tools/defineTool.js';
import { PromptBuilder } from '../src/runtime/PromptBuilder.js';
import type { Ctx, Identity, Effect, EffectHandler } from '../src/types.js';

const MAX_TOOL_LOOP_ITERS = 20;

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
  };
}

interface MakeEffOpts {
  llm: { chatMessages: (...args: any[]) => Promise<any> };
  toolManager: ToolManager;
  contextSnap?: any;
  onRecordEvent?: (sessionId: string, entry: any) => void;
  onSendMessage?: (text: string, receiverId: string, sessionId: string) => void;
}

/**
 * Test-side EffectHandler. Mirrors what ZiggsEffectHandler does for tool-call
 * (delegate to toolManager.executeTool) but feeds in caller-provided stubs
 * for llm-call, read-context, send-message, record-event.
 */
function makeEff({ llm, toolManager, contextSnap, onRecordEvent, onSendMessage }: MakeEffOpts): EffectHandler {
  const snap = contextSnap || { history: [], agreements: [], agents: [], users: [{ userId: 'u1' }] };
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
          });
          return { ok: true, result };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? String(err) };
        }
      }
      case 'send-message':
        onSendMessage?.(effect.text, effect.receiverId, effect.sessionId);
        return { ok: true };
      case 'record-event':
        onRecordEvent?.(effect.sessionId, effect.entry);
        return { ok: true };
      default:
        return undefined;
    }
  };
  return handler as EffectHandler;
}

describe('runTurn (mocked LLM)', () => {
  it('stops after MAX_TOOL_LOOP_ITERS when every tool round is non-terminal', async () => {
    const toolManager = new ToolManager();
    toolManager.register(defineTool('spin_tool', {}, async () => ({ ok: true, n: 1 })));

    let llmCalls = 0;
    const llm = {
      async chatMessages() {
        llmCalls += 1;
        return { tool_calls: [{ id: `tc-${llmCalls}`, type: 'function', function: { name: 'spin_tool', arguments: '{}' } }] };
      },
    };

    const out = await runTurn({
      stateId: 'loopState',
      statePrompt: { goal: 'test' },
      actions: { spin: { prompt: { instruction: 'spin' }, tool: 'spin_tool', produces: 'wait' as const } },
      incomingEvent: null,
      ctx: makeCtx(),
      eff: makeEff({ llm, toolManager }),
      toolManager,
      promptBuilder: new PromptBuilder(),
      definition: { description: 'd' },
    });

    assert.equal(llmCalls, MAX_TOOL_LOOP_ITERS);
    assert.ok(out?.toolResults);
  });

  it('executes agent_network in delegating via GENERIC_FALLBACK when action list omits it', async () => {
    const toolManager = new ToolManager();
    toolManager.register(
      defineTool('agent_network', { operation: { type: 'string', required: true } }, async (args) => ({
        operation: args['operation'], success: true, data: { agents: [{ agentId: 'found-x' }] },
      })),
    );

    let call = 0;
    const llm = {
      async chatMessages() {
        call += 1;
        if (call === 1) return { tool_calls: [{ id: 'g1', type: 'function', function: { name: 'agent_network', arguments: JSON.stringify({ operation: 'search', query: 'q' }) } }] };
        return { content: '{"action":"pause","thought":"done"}' };
      },
    };

    const out = await runTurn({
      stateId: 'delegating',
      statePrompt: { goal: 'delegate only' },
      actions: {
        delegate: { prompt: { instruction: 'use agreement_propose' }, tool: 'agreement_propose', produces: 'wait' as const },
        pause: { prompt: { instruction: 'pause' }, produces: 'wait' as const },
      },
      incomingEvent: null,
      ctx: makeCtx({ activeTaskId: 'root-1' }),
      eff: makeEff({ llm, toolManager }),
      toolManager,
      promptBuilder: new PromptBuilder(),
      definition: { description: 'd' },
    });

    assert.ok(out.toolResults.some(r => r.tool === 'agent_network'));
  });

  it('terminates loop immediately after agent_search when terminatesLoop is set, preventing extra tool calls', async () => {
    const toolManager = new ToolManager();
    toolManager.register(defineTool('agent_search', { query: { type: 'string', required: true } }, async () => ({
      success: true, agents: [{ agentId: 'specialist-1' }],
    })));
    toolManager.register(defineTool('agreement_subcontract', { executorId: { type: 'string', required: true } }, async () => ({
      success: true, agreementId: 'ag-1',
    })));

    const toolsCalled: string[] = [];
    let llmCall = 0;
    const llm = {
      async chatMessages() {
        llmCall += 1;
        if (llmCall === 1) {
          // LLM wants to call agent_search then immediately agreement_subcontract
          return {
            tool_calls: [
              { id: 'tc1', type: 'function', function: { name: 'agent_search', arguments: JSON.stringify({ query: 'web dev' }) } },
              { id: 'tc2', type: 'function', function: { name: 'agreement_subcontract', arguments: JSON.stringify({ executorId: 'specialist-1' }) } },
            ],
          };
        }
        return { content: '{"action":"wait","thought":"done"}' };
      },
    };

    await runTurn({
      stateId: 'understanding',
      statePrompt: { goal: 'understand' },
      actions: {
        search: { prompt: { instruction: 'search' }, tool: 'agent_search', produces: 'tool-result' as const, terminatesLoop: true },
        delegate: { prompt: { instruction: 'delegate' }, tool: 'agreement_subcontract', produces: 'proposal-made' as const },
        wait: { prompt: { instruction: 'wait' }, produces: 'wait' as const },
      },
      incomingEvent: null,
      ctx: makeCtx(),
      eff: makeEff({
        llm, toolManager,
        onSendMessage: () => {},
      }),
      toolManager,
      promptBuilder: new PromptBuilder(),
      definition: { description: 'd' },
    });

    // agent_search ran but agreement_subcontract must NOT have run (loop terminated)
    const tr = await Promise.resolve(toolManager.getTool('agreement_subcontract'));
    // Verify by checking llmCall count: if terminatesLoop works, only 1 LLM call
    assert.equal(llmCall, 1, 'loop must terminate after agent_search — no second LLM call');
  });

  it('sends message when LLM puts receiverId/message inside args instead of top-level (ZIG-401)', async () => {
    const toolManager = new ToolManager();
    toolManager.register(defineTool('agent_search', { query: { type: 'string', required: true } }, async () => ({
      success: true, agents: [{ agentId: 'specialist-1', name: 'Specialist' }],
    })));

    const sent: { text: string; receiverId: string }[] = [];
    let call = 0;
    const llm = {
      async chatMessages() {
        call += 1;
        if (call === 1) {
          // iter 0: LLM calls agent_search via tool_calls
          return { tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'agent_search', arguments: JSON.stringify({ query: 'website development' }) } }] };
        }
        // iter 1: LLM emits args-wrapped message instead of top-level fields
        return { content: JSON.stringify({ thought: 'will respond', action: 'respond', args: { receiverId: 'u1', message: 'I found a specialist for you!' } }) };
      },
    };

    await runTurn({
      stateId: 'understanding',
      statePrompt: { goal: 'understand request' },
      actions: {
        search: { prompt: { instruction: 'search' }, tool: 'agent_search', produces: 'tool-result' as const },
        respond: { prompt: { instruction: 'respond' }, produces: 'message-sent' as const },
      },
      incomingEvent: { type: 'message', text: 'i want a website', senderId: 'u1', senderType: 'USER' },
      ctx: makeCtx(),
      eff: makeEff({ llm, toolManager, onSendMessage: (text, receiverId) => sent.push({ text, receiverId }) }),
      toolManager,
      promptBuilder: new PromptBuilder(),
      definition: { description: 'd' },
    });

    assert.equal(sent.length, 1, 'expected exactly one message to be sent');
    assert.equal(sent[0].receiverId, 'u1');
    assert.ok(sent[0].text.length > 0);
  });

  it('unregistered tool bound to action: no crash, tool_error in context, runTurn completes', async () => {
    const toolManager = new ToolManager();
    toolManager.register(defineTool('only_other', {}, async () => ({ ok: true })));

    let llmCalls = 0;
    const llm = {
      async chatMessages() {
        llmCalls += 1;
        if (llmCalls === 1) return { tool_calls: [{ id: 'tc-unreg', type: 'function', function: { name: 'not_registered_in_tool_manager', arguments: '{}' } }] };
        return { content: '{"action":"after_fail","thought":"continue after tool failure"}' };
      },
    };

    const out = await runTurn({
      stateId: 's1',
      statePrompt: { goal: 'call the bound tool once' },
      actions: {
        invoke: { prompt: { instruction: 'invoke' }, tool: 'not_registered_in_tool_manager', produces: 'wait' as const },
        after_fail: { prompt: { instruction: 'recover' }, produces: 'wait' as const },
      },
      incomingEvent: null,
      ctx: makeCtx(),
      eff: makeEff({ llm, toolManager }),
      toolManager,
      promptBuilder: new PromptBuilder(),
      definition: { description: 'd' },
    });

    assert.equal(llmCalls, 2);
    assert.ok(out?.toolResults.some(r => r.tool === 'not_registered_in_tool_manager' && r.error));
    assert.match(
      String(out.toolResults.find(r => r.tool === 'not_registered_in_tool_manager')?.error || ''),
      /Tool not found/i,
    );
  });

  it('skips the LLM on a message wake when the chat no longer resolves (chatMissing)', async () => {
    const toolManager = new ToolManager();
    let llmCalls = 0;
    const llm = {
      async chatMessages() {
        llmCalls += 1;
        return { content: '{"action":"wait","thought":"should never run"}' };
      },
    };

    const out = await runTurn({
      stateId: 'listening',
      statePrompt: { goal: 'test' },
      actions: { wait: { prompt: { instruction: 'wait' }, produces: 'wait' as const } },
      incomingEvent: { type: 'message', senderId: 'ziggs-agent', text: 'stale replay' },
      ctx: makeCtx({ lastOutcome: { kind: 'message-received' } }),
      eff: makeEff({
        llm,
        toolManager,
        contextSnap: { history: [], agreements: [], agents: [], users: [], chatMissing: true },
      }),
      toolManager,
      promptBuilder: new PromptBuilder(),
      definition: { description: 'd' },
    });

    assert.equal(llmCalls, 0);
    assert.equal(out.outcome.kind, 'wait');
    assert.equal(out.llmCalls, 0);
    assert.equal(out.skippedReason, 'chat_unreadable:c1');
  });

  it('skips the LLM on a resource wake when the room is unreadable (ZIG-1799)', async () => {
    const toolManager = new ToolManager();
    let llmCalls = 0;
    const llm = {
      async chatMessages() {
        llmCalls += 1;
        return { content: '{"action":"wait","thought":"should never run"}' };
      },
    };

    const out = await runTurn({
      stateId: 'executing',
      statePrompt: { goal: 'test' },
      actions: { wait: { prompt: { instruction: 'wait' }, produces: 'wait' as const } },
      incomingEvent: { type: 'task_result' },
      ctx: makeCtx({
        lastOutcome: { kind: 'task-assigned', task: { taskId: 't1' } },
        activeTaskId: 't1',
      }),
      eff: makeEff({
        llm,
        toolManager,
        contextSnap: { history: [], agreements: [], agents: [], users: [], chatMissing: true },
      }),
      toolManager,
      promptBuilder: new PromptBuilder(),
      definition: { description: 'd' },
    });

    assert.equal(llmCalls, 0);
    assert.equal(out.outcome.kind, 'wait');
    assert.equal(out.llmCalls, 0);
    assert.equal(out.skippedReason, 'chat_unreadable:c1');
  });

  it('still runs task wakes when chatMissing on a legacy bare-agreement lane (ZIG-975)', async () => {
    const toolManager = new ToolManager();
    let llmCalls = 0;
    const llm = {
      async chatMessages() {
        llmCalls += 1;
        return { content: '{"action":"wait","thought":"task lane runs"}' };
      },
    };

    const out = await runTurn({
      stateId: 'executing',
      statePrompt: { goal: 'test' },
      actions: { wait: { prompt: { instruction: 'wait' }, produces: 'wait' as const } },
      incomingEvent: { type: 'task_result' },
      ctx: makeCtx({
        identity: { agentId: 'test-agent', sessionId: 'agr_1', laneKey: 'test-agent:agr_1' },
        lastOutcome: { kind: 'task-assigned', task: { taskId: 't1' } },
        activeTaskId: 't1',
      }),
      eff: makeEff({
        llm,
        toolManager,
        contextSnap: { history: [], agreements: [], agents: [], users: [], chatMissing: true },
      }),
      toolManager,
      promptBuilder: new PromptBuilder(),
      definition: { description: 'd' },
    });

    assert.equal(llmCalls, 1);
    assert.equal(out.outcome.kind, 'wait');
    assert.equal(out.skippedReason, undefined);
  });
});
