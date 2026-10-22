import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ClaudeBrain, isNoticeOnlyWake, isPublishProbeChat, wakeAgreementOf } from '../src/brain/ClaudeBrain.js';
import * as claudeBrainModule from '../src/brain/ClaudeBrain.js';
import { ToolManager } from '../src/tools/ToolManager.js';
import { defineTool } from '../src/tools/defineTool.js';
import { CLAUDE_SDK_TOOLS } from '../src/brain/claudeSdkTools.js';
import { assertHostedAgentZiggsTools } from '../src/brain/hostedAgentConnection.js';
import { PROTOCOL_TOOLS } from '../src/platform/tools/tier1/protocolTools.js';
import type { Effect, EffectHandler } from '../src/types.js';
import { InMemoryStore } from '../src/memory/MemoryStore.js';
import type { MemoryStore } from '../src/memory/MemoryStore.js';

const WORKFLOW = {
  id: 'claude-test',
  description: 'test',
  initial: 'ready',
  states: {
    ready: { kind: 'parked' as const, transitions: [] },
  },
};

describe('ClaudeBrain.tick (mocked query)', () => {
  it('resumes only while work and audience remain the same', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll([...PROTOCOL_TOOLS, ...CLAUDE_SDK_TOOLS]);
    let audience = ['customer-a'];
    const resumes: (string | undefined)[] = [];
    const queryFn = async function* (input: { options: { resume?: string } }) {
      resumes.push(input.options.resume);
      yield { type: 'result', subtype: 'success', result: 'handled', session_id: `session-${resumes.length}`,
        usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, num_turns: 1 };
    };
    const brain = new ClaudeBrain({ workflow: WORKFLOW, toolManager, description: 'worker',
      anthropicKey: 'test', operatorKey: 'test', agentId: 'worker', queryFn: queryFn as never,
      readAgreement: async id => ({ agreementId: id, status: 'active', terms: {} }) });
    const eff: EffectHandler = async effect => effect.kind === 'read-context'
      ? { history: [], agreements: [], users: [], agents: [], workBrief: { audience: { participantRefs: audience } } }
      : {};
    const identity = { agentId: 'worker', sessionId: 'room', laneKey: 'worker:room' };
    let ctx: any;
    for (const agreementId of ['a', 'a', 'b', 'b']) {
      const result = await brain.tick({ identity, ctx, eff, event: { type: 'message', text: 'continue', agreementId } });
      ctx = result.ctx;
    }
    audience = ['customer-a', 'guest'];
    await brain.tick({ identity, ctx, eff, event: { type: 'message', text: 'continue', agreementId: 'b' } });
    assert.deepEqual(resumes, [undefined, 'session-1', undefined, 'session-3', undefined]);
  });
  it('resumes Claude session and returns parked output', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll([...PROTOCOL_TOOLS, ...CLAUDE_SDK_TOOLS]);

    const readContext = mock.fn(async () => ({
      history: [],
      agreements: [],
      agents: [{ agentId: 'claude-test', isYou: true }],
      users: [{ userId: 'user-1' }],
    }));

    const eff: EffectHandler = async (effect: Effect) => {
      if (effect.kind === 'read-context') return readContext();
      if (effect.kind === 'send-message') return { ok: true };
      return {};
    };

    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        duration_ms: 10,
        duration_api_ms: 8,
        is_error: false,
        num_turns: 2,
        result: 'handled',
        stop_reason: null,
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-4000-8000-000000000001',
        session_id: 'sess-claude-abc',
      };
    });

    const agent = new ClaudeBrain({
      workflow: WORKFLOW,
      toolManager,
      description: 'Test Claude SDK agent',
      model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key',
      operatorKey: 'op-key',
      agentId: 'claude-test',
      queryFn: queryFn as never,
    });

    const out = await agent.tick({
      event: { type: 'message', text: 'hello', senderId: 'user-1', senderType: 'USER' },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });

    assert.equal(out.parked, true);
    assert.equal(out.state, 'ready');
    assert.equal(out.ctx.claudeSessionId, 'sess-claude-abc');
    assert.equal(readContext.mock.callCount(), 1);
    assert.equal(queryFn.mock.callCount(), 1);
    const call = queryFn.mock.calls[0]?.arguments?.[0] as {
      options?: { resume?: string; mcpServers?: Record<string, unknown> };
    };
    assert.equal(call?.options?.resume, undefined);
    assert.doesNotThrow(() => assertHostedAgentZiggsTools(call?.options?.mcpServers));
  });

  it('puts the host-scoped memory on the lane tool context', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll([...PROTOCOL_TOOLS, ...CLAUDE_SDK_TOOLS]);
    const readContext = mock.fn(async () => ({
      history: [],
      agreements: [],
      agents: [{ agentId: 'claude-test', isYou: true }],
      users: [{ userId: 'user-1' }],
    }));
    const eff: EffectHandler = async (effect: Effect) => {
      if (effect.kind === 'read-context') return readContext();
      if (effect.kind === 'send-message') return { ok: true };
      return {};
    };
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
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-4000-8000-000000000002',
        session_id: 'sess-claude-mem',
      };
    });
    const agent = new ClaudeBrain({
      workflow: WORKFLOW,
      toolManager,
      description: 'Test Claude SDK agent',
      model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key',
      operatorKey: 'op-key',
      agentId: 'claude-test',
      queryFn: queryFn as never,
    });
    const memory = new InMemoryStore();
    await memory.put('note', 'hire-scoped');

    await agent.tick({
      event: { type: 'message', text: 'hello', senderId: 'user-1', senderType: 'USER' },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
      memory,
    });

    const ctx = (
      agent as unknown as {
        toolContextByLane: Map<string, { memory?: MemoryStore }>;
      }
    ).toolContextByLane.get('claude-test:chat-1');
    assert.equal(await ctx?.memory?.get('note'), 'hire-scoped');
  });

  it('ZIG-1762: a store publish probe spends a model turn, not a canned line', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    const sent: Effect[] = [];
    const readContext = mock.fn(async () => ({ history: [], agreements: [], agents: [], users: [] }));
    const eff: EffectHandler = async (effect: Effect) => {
      sent.push(effect);
      if (effect.kind === 'read-context') return readContext();
      if (effect.kind === 'send-message') return { ok: true };
      return {};
    };
    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'I review how a team works and can recommend automations.',
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-4000-8000-0000000000bb',
        session_id: 'sess-probe',
      };
    });
    const agent = new ClaudeBrain({
      workflow: WORKFLOW,
      toolManager,
      description: 'Reviews how a team works and recommends automations.',
      systemPrompt: 'A very long skill body that would time out a probe.',
      model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key',
      operatorKey: 'op-key',
      agentId: 'automation-recommender',
      queryFn: queryFn as never,
    });
    const chatId = 'probe_automation-recommender_1788840000';
    const out = await agent.tick({
      event: {
        type: 'message',
        text: "Hi! I'm trying out agents on Ziggs — could you briefly introduce yourself?",
        senderId: 'user-1',
        senderType: 'USER',
      },
      identity: {
        agentId: 'automation-recommender',
        sessionId: chatId,
        laneKey: `automation-recommender:${chatId}`,
      },
      eff,
    });
    assert.equal(out.parked, true);
    assert.equal(queryFn.mock.callCount(), 1);
    assert.ok(readContext.mock.callCount() >= 1);
    const canned = sent.find(
      (e) =>
        e.kind === 'send-message' &&
        /I received your message/.test(String(e.text ?? '')),
    );
    assert.equal(canned, undefined);
  });

  it('ZIG-1762: leftover mail does not park a store probe before the model runs', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    const sent: Effect[] = [];
    const eff: EffectHandler = async (effect: Effect) => {
      sent.push(effect);
      if (effect.kind === 'read-context') {
        return { history: [], agreements: [], agents: [], users: [] };
      }
      return {};
    };
    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'I am online and can take the job.',
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-4000-8000-0000000000cc',
        session_id: 'sess-probe-breaker',
      };
    });
    const agent = new ClaudeBrain({
      workflow: WORKFLOW,
      toolManager,
      description: 'Online listing blurb.',
      systemPrompt: 'skill body',
      model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key',
      operatorKey: 'op-key',
      agentId: 'automation-recommender',
      queryFn: queryFn as never,
    });
    const chatId = 'probe_automation-recommender_1788840001';
    const now = Date.now();
    const out = await agent.tick({
      event: {
        type: 'message',
        text: 'Hi — probe?',
        senderId: 'user-1',
        senderType: 'USER',
      },
      ctx: {
        recentDeliveries: Array.from({ length: 40 }, (_, i) => now - i * 1000),
      },
      identity: {
        agentId: 'automation-recommender',
        sessionId: chatId,
        laneKey: `automation-recommender:${chatId}`,
      },
      eff,
    });
    assert.equal(out.parked, true);
    assert.equal(queryFn.mock.callCount(), 1);
    const canned = sent.find(
      (e) =>
        e.kind === 'send-message' &&
        /I received your message/.test(String(e.text ?? '')),
    );
    assert.equal(canned, undefined);
  });

  it('ZIG-1035: notification-only wakes park without spending a model turn', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);

    const readContext = mock.fn(async () => ({ history: [], agreements: [], agents: [], users: [] }));
    const eff: EffectHandler = async (effect: Effect) => {
      if (effect.kind === 'read-context') return readContext();
      return {};
    };
    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'should-not-run',
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-4000-8000-0000000000aa',
        session_id: 'sess-notice',
      };
    });

    const agent = new ClaudeBrain({
      workflow: WORKFLOW,
      toolManager,
      description: 'Test',
      model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key',
      operatorKey: 'op-key',
      agentId: 'claude-test',
      queryFn: queryFn as never,
    });

    const out = await agent.tick({
      event: {
        type: 'notification',
        entryType: 'notification',
        text: 'Task created: t1',
        result: { taskId: 't1', state: 'active' },
      },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });

    assert.equal(out.parked, true);
    assert.equal(out.metrics?.llmCalls, 0);
    assert.equal(queryFn.mock.callCount(), 0);
    assert.equal(readContext.mock.callCount(), 0);
  });

  it('ZIG-1052: hire approval (agreement_lifecycle) spends a model turn', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    const readContext = mock.fn(async () => ({
      history: [],
      agreements: [{ agreementId: 'agr-1', status: 'active' }],
      agents: [{ agentId: 'claude-test', isYou: true }],
      users: [],
    }));
    const eff: EffectHandler = async (effect: Effect) => {
      if (effect.kind === 'read-context') return readContext();
      return {};
    };
    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'spawned first task',
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-4000-8000-0000000000ab',
        session_id: 'sess-hire',
      };
    });
    const agent = new ClaudeBrain({
      workflow: WORKFLOW,
      toolManager,
      description: 'Test',
      model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key',
      operatorKey: 'op-key',
      agentId: 'claude-test',
      queryFn: queryFn as never,
    });
    const out = await agent.tick({
      event: {
        type: 'agreement_lifecycle',
        operation: 'proposal_approved',
        agreementId: 'agr-1',
        text: 'Proposal approved: agr-1',
      },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });
    assert.equal(queryFn.mock.callCount(), 1);
    assert.equal(out.metrics?.llmCalls, 1);
    assert.equal(readContext.mock.callCount(), 1);
    const prompt = (queryFn.mock.calls[0]?.arguments?.[0] as { prompt?: string })?.prompt ?? '';
    assert.match(prompt, /Work signal: proposal approved/);
    assert.match(prompt, /agr-1/);
  });

  it('skips an agent-formed hire activation notice (no model call)', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    const readContext = mock.fn(async () => ({
      history: [],
      agreements: [{ agreementId: 'agr-1', status: 'active', formedBy: 'agent' }],
      agents: [{ agentId: 'claude-test', isYou: true }],
      users: [],
    }));
    const eff: EffectHandler = async (effect: Effect) => {
      if (effect.kind === 'read-context') return readContext();
      return {};
    };
    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result', subtype: 'success', num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 }, session_id: 's',
      };
    });
    const agent = new ClaudeBrain({
      workflow: WORKFLOW, toolManager, description: 'Test', model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key', operatorKey: 'op-key', agentId: 'claude-test',
      queryFn: queryFn as never,
    });
    const out = await agent.tick({
      event: {
        type: 'agreement_lifecycle',
        operation: 'proposal_approved_execute',
        agreementId: 'agr-1',
        formedBy: 'agent',
        text: 'Agreement agr-1 is now active — tasks may be spawned.',
      },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });
    assert.equal(queryFn.mock.callCount(), 0);
    assert.equal(readContext.mock.callCount(), 0);
    assert.equal(out.metrics?.llmCalls, 0);
    assert.equal(out.skippedReason, 'agent_formed_hire_activation');
  });

  it('a person-formed hire approval still spends a model turn', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result', subtype: 'success', num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 }, session_id: 's',
      };
    });
    const agent = new ClaudeBrain({
      workflow: WORKFLOW, toolManager, description: 'Test', model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key', operatorKey: 'op-key', agentId: 'claude-test',
      queryFn: queryFn as never,
    });
    await agent.tick({
      event: {
        type: 'agreement_lifecycle',
        operation: 'proposal_approved_execute',
        agreementId: 'agr-1',
        formedBy: 'principal',
        text: 'Agreement agr-1 is now active — tasks may be spawned.',
      },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff: (async () => ({ history: [], agreements: [], agents: [], users: [] })) as EffectHandler,
    });
    assert.equal(queryFn.mock.callCount(), 1);
  });

  it('manifest opt-in still spends a model turn on an agent-formed activation', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result', subtype: 'success', num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 }, session_id: 's',
      };
    });
    const agent = new ClaudeBrain({
      workflow: WORKFLOW, toolManager, description: 'Test', model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key', operatorKey: 'op-key', agentId: 'claude-test',
      actsOnHireActivation: true,
      queryFn: queryFn as never,
    });
    await agent.tick({
      event: {
        type: 'agreement_lifecycle',
        operation: 'proposal_approved_execute',
        agreementId: 'agr-1',
        formedBy: 'agent',
      },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff: (async () => ({ history: [], agreements: [], agents: [], users: [] })) as EffectHandler,
    });
    assert.equal(queryFn.mock.callCount(), 1);
  });

  it('ZIG-1052: empty / missing batch does not spend a model turn', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'nope',
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-4000-8000-0000000000ac',
        session_id: 'sess-empty',
      };
    });
    const agent = new ClaudeBrain({
      workflow: WORKFLOW,
      toolManager,
      description: 'Test',
      model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key',
      operatorKey: 'op-key',
      agentId: 'claude-test',
      queryFn: queryFn as never,
    });
    const out = await agent.tick({
      event: { type: 'batch', events: [] },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff: async () => ({}),
    });
    assert.equal(out.metrics?.llmCalls, 0);
    assert.equal(queryFn.mock.callCount(), 0);
  });

  it('ZIG-1052: isNoticeOnlyWake — notifications only; lifecycle is work; empty is notice', () => {
    assert.equal(isNoticeOnlyWake(undefined), true);
    assert.equal(isNoticeOnlyWake({ type: 'batch', events: [] }), true);
    assert.equal(
      isNoticeOnlyWake({ type: 'notification', text: 'Task created: t1' }),
      true,
    );
    assert.equal(
      isNoticeOnlyWake({
        type: 'agreement_lifecycle',
        operation: 'proposal_approved',
        agreementId: 'agr-1',
      }),
      false,
    );
    assert.equal(
      isNoticeOnlyWake({
        type: 'batch',
        events: [
          { type: 'notification', text: 'noise' },
          { type: 'agreement_lifecycle', operation: 'proposal_approved', agreementId: 'agr-1' },
        ],
      }),
      false,
    );
    // Document intentional FSM difference: Claude skips notification-only;
    // FSM never had a parallel filter (it no-ops enter-only outcomes instead).
    assert.equal(isNoticeOnlyWake({ type: 'message', text: 'hi' }), false);
  });

  it('names the store publish chat so a hired job is not confused with it', () => {
    assert.equal(isPublishProbeChat('probe_automation-recommender_1'), true);
    assert.equal(isPublishProbeChat('chat-1'), false);
    assert.equal(isPublishProbeChat(undefined), false);
    assert.equal('isCapabilityProbeSession' in claudeBrainModule, false);
  });

  it('a delivered message is a turn whoever it names: the backend already picked (ZIG-2034)', () => {
    // The inbox hands this agent only rows assigned to it, so a named receiver
    // on the frame is not the SDK's to second-guess.
    assert.equal(
      isNoticeOnlyWake({ type: 'message', text: 'hi', receiverId: 'agent-B' }),
      false,
    );
  });

  it('does not resume a legacy transcript without a verified work scope', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);

    const eff: EffectHandler = async (effect: Effect) => {
      if (effect.kind === 'read-context') return { history: [], agreements: [], agents: [], users: [] };
      return {};
    };

    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        duration_ms: 5,
        duration_api_ms: 4,
        is_error: false,
        num_turns: 1,
        result: 'ok',
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-4000-8000-000000000002',
        session_id: 'sess-existing',
      };
    });

    const agent = new ClaudeBrain({
      workflow: WORKFLOW,
      toolManager,
      description: 'Test',
      model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key',
      operatorKey: 'op-key',
      agentId: 'claude-test',
      queryFn: queryFn as never,
    });

    await agent.tick({
      event: { type: 'message', text: 'follow-up' },
      ctx: {
        identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
        tasks: {},
        activeAgreementId: null,
        activeTaskId: null,
        pendingProposalAgreementId: null,
        pendingSubtasks: {},
        collectedResults: [],
        delegatedAgreementIds: [],
        toolResults: [],
        lastOutcome: { kind: 'enter' },
        claudeSessionId: 'sess-existing',
      },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });

    const call = queryFn.mock.calls[0]?.arguments?.[0] as { options?: { resume?: string } };
    assert.equal(call?.options?.resume, undefined);
  });

  it('statelessPerWake never resumes and never persists the session id (ZIG-860)', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);

    const eff: EffectHandler = async (effect: Effect) => {
      if (effect.kind === 'read-context') return { history: [], agreements: [], agents: [], users: [] };
      return {};
    };

    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        duration_ms: 5,
        duration_api_ms: 4,
        is_error: false,
        num_turns: 1,
        result: 'ok',
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-4000-8000-000000000003',
        session_id: 'sess-fresh',
      };
    });

    const agent = new ClaudeBrain({
      workflow: WORKFLOW,
      toolManager,
      description: 'Test',
      model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key',
      operatorKey: 'op-key',
      agentId: 'claude-test',
      statelessPerWake: true,
      queryFn: queryFn as never,
    });

    const out = await agent.tick({
      event: { type: 'message', text: 'follow-up' },
      ctx: {
        identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
        tasks: {},
        activeAgreementId: null,
        activeTaskId: null,
        pendingProposalAgreementId: null,
        pendingSubtasks: {},
        collectedResults: [],
        delegatedAgreementIds: [],
        toolResults: [],
        lastOutcome: { kind: 'enter' },
        claudeSessionId: 'sess-existing',
      },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });

    const call = queryFn.mock.calls[0]?.arguments?.[0] as { options?: { resume?: string } };
    // never resumes the prior transcript, even with a session id in ctx…
    assert.equal(call?.options?.resume, undefined);
    // …and does not carry a session id forward, so the next wake is fresh too.
    assert.equal(out.ctx.claudeSessionId, undefined);
  });

  // ZIG-1327: the cap is a runaway backstop, not a budget — cost is bounded by
  // the (now correctly priced) spend guard. 12 sat below the honest length of a
  // real job and cut every wake off with the gathering done and nothing filed.
  it('uses the default maxTurns (30) when none is passed', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    const eff: EffectHandler = async (effect: Effect) =>
      effect.kind === 'read-context' ? { history: [], agreements: [], agents: [], users: [] } : {};
    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result', subtype: 'success', duration_ms: 1, duration_api_ms: 1, is_error: false,
        num_turns: 1, result: 'ok', stop_reason: null, total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
        uuid: '00000000-0000-4000-8000-000000000003', session_id: 'sess-turns',
      };
    });
    const agent = new ClaudeBrain({
      workflow: WORKFLOW, toolManager, description: 'Test', model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key', operatorKey: 'op-key', agentId: 'claude-test', queryFn: queryFn as never,
    });
    await agent.tick({
      event: { type: 'message', text: 'x' },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });
    const call = queryFn.mock.calls[0]?.arguments?.[0] as { options?: { maxTurns?: number } };
    assert.equal(call?.options?.maxTurns, 30);
  });

  // ZIG-1080: `description` became the store-facing blurb, so the role block has
  // to read `systemPrompt` — with a fallback for agents written before the split.
  it('builds the role block from systemPrompt, falling back to description', async () => {
    const roleOf = async (opts: { description: string; systemPrompt?: string }) => {
      const toolManager = new ToolManager();
      toolManager.registerAll(CLAUDE_SDK_TOOLS);
      const eff: EffectHandler = async (effect: Effect) =>
        effect.kind === 'read-context' ? { history: [], agreements: [], agents: [], users: [] } : {};
      const queryFn = mock.fn(async function* () {
        yield {
          type: 'result', subtype: 'success', duration_ms: 1, duration_api_ms: 1, is_error: false,
          num_turns: 1, result: 'ok', stop_reason: null, total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
          uuid: '00000000-0000-4000-8000-000000000009', session_id: 'sess-role',
        };
      });
      const agent = new ClaudeBrain({
        workflow: WORKFLOW, toolManager, model: 'claude-sonnet-5-5',
        anthropicKey: 'test-key', operatorKey: 'op-key', agentId: 'claude-test',
        queryFn: queryFn as never, ...opts,
      });
      await agent.tick({
        event: { type: 'message', text: 'x' },
        identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
        eff,
      });
      const call = queryFn.mock.calls[0]?.arguments?.[0] as { options?: { systemPrompt?: string | string[] } };
      // ZIG-788: the system prompt is now cache-ordered blocks; the role
      // block is what this test is about, so join them back for matching.
      const prompt = call?.options?.systemPrompt;
      return Array.isArray(prompt) ? prompt.join('\n\n') : (prompt ?? '');
    };

    const split = await roleOf({
      description: 'Store blurb a buyer reads.',
      systemPrompt: 'You are a test agent. Follow these internal instructions.',
    });
    assert.match(split, /You are a test agent\./);
    assert.doesNotMatch(split, /Store blurb a buyer reads\./);

    const legacy = await roleOf({ description: 'You are a legacy agent with no split.' });
    assert.match(legacy, /You are a legacy agent with no split\./);
  });

  it('aborts the query when the per-task input-token budget is exceeded', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    const eff: EffectHandler = async (effect: Effect) =>
      effect.kind === 'read-context' ? { history: [], agreements: [], agents: [], users: [] } : {};

    let yielded = 0;
    const queryFn = mock.fn(async function* () {
      yielded += 1;
      // One over-budget assistant turn (>500K default billable input) must trip the guard.
      yield {
        type: 'assistant',
        message: { usage: { input_tokens: 600_000, output_tokens: 5 } },
        session_id: 'sess-runaway',
        uuid: '00000000-0000-4000-8000-000000000004',
      };
      yielded += 1; // must NOT run — the for-await should have broken
      yield {
        type: 'result', subtype: 'success', duration_ms: 1, duration_api_ms: 1, is_error: false,
        num_turns: 9, result: 'late', stop_reason: null, total_cost_usd: 9,
        usage: { input_tokens: 600_000, output_tokens: 5 }, modelUsage: {}, permission_denials: [],
        uuid: '00000000-0000-4000-8000-000000000005', session_id: 'sess-runaway',
      };
    });

    const agent = new ClaudeBrain({
      workflow: WORKFLOW, toolManager, description: 'Test', model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key', operatorKey: 'op-key', agentId: 'claude-test', queryFn: queryFn as never,
    });

    const out = await agent.tick({
      event: { type: 'message', text: 'loop' },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });

    assert.equal(yielded, 1, 'generator stopped after the over-budget message');
    assert.equal(out.parked, true);
    // A wake that blew past the budget (600K) also trips the ZIG-816 resume
    // ceiling, so the oversized session is forgotten rather than carried
    // forward — the next wake starts fresh.
    assert.equal(out.ctx.claudeSessionId, undefined);
  });

  /**
   * ZIG-1327 — the shape that was being killed as a runaway.
   *
   * A real job replays its transcript on every turn, and that replay is a cache
   * READ: 20 turns over a 40K context bills like ~80K of input, not the 800K the
   * raw sum reported. Counting it raw meant the guard fired mid-job on every
   * multi-step wake — gathering finished, the deliverable never got filed, and
   * the wake reported a clean park.
   */
  it('ZIG-1327: a long wake over a cached transcript is not a runaway', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    const eff: EffectHandler = async (effect: Effect) =>
      effect.kind === 'read-context' ? { history: [], agreements: [], agents: [], users: [] } : {};

    let turns = 0;
    const queryFn = mock.fn(async function* () {
      // 20 turns, each re-reading a 40K transcript out of cache.
      for (let i = 0; i < 20; i++) {
        turns += 1;
        yield {
          type: 'assistant',
          message: { usage: { input_tokens: 200, cache_read_input_tokens: 40_000, output_tokens: 60 } },
          session_id: 'sess-long',
          uuid: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
        };
      }
      yield {
        type: 'result', subtype: 'success', duration_ms: 1, duration_api_ms: 1, is_error: false,
        num_turns: 20, result: 'filed', stop_reason: null, total_cost_usd: 1,
        usage: { input_tokens: 4_000, cache_read_input_tokens: 800_000, output_tokens: 1_200 },
        modelUsage: {}, permission_denials: [],
        uuid: '00000000-0000-4000-8000-000000000199', session_id: 'sess-long',
      };
    });

    const agent = new ClaudeBrain({
      workflow: WORKFLOW, toolManager, description: 'Test', model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key', operatorKey: 'op-key', agentId: 'claude-test',
      queryFn: queryFn as never,
    });

    const out = await agent.tick({
      event: { type: 'message', text: 'do the digest' },
      ctx: { claudeSessionId: 'sess-long' } as never,
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });

    assert.equal(turns, 20, 'the wake must run to completion, not be cut off mid-job');
    // 40K of transcript is 40K of transcript however many turns read it, so the
    // lane keeps its session and the next wake resumes instead of re-gathering.
    assert.equal(out.ctx.claudeSessionId, 'sess-long');
  });

  /**
   * The guard still has to stop a real runaway: fresh input, not cached replay.
   */
  it('ZIG-1327: uncached input still trips the guard', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    const eff: EffectHandler = async (effect: Effect) =>
      effect.kind === 'read-context' ? { history: [], agreements: [], agents: [], users: [] } : {};

    const recorded: string[] = [];
    const recordingEff: EffectHandler = async (effect: Effect) => {
      if (effect.kind === 'record-event') {
        recorded.push(String((effect as { entry?: { text?: string } }).entry?.text ?? ''));
        return {};
      }
      return eff(effect);
    };

    let turns = 0;
    const queryFn = mock.fn(async function* () {
      for (let i = 0; i < 10; i++) {
        turns += 1;
        yield {
          type: 'assistant',
          message: { usage: { input_tokens: 120_000, output_tokens: 60 } },
          session_id: 'sess-runaway-2',
          uuid: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`,
        };
      }
    });

    const agent = new ClaudeBrain({
      workflow: WORKFLOW, toolManager, description: 'Test', model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key', operatorKey: 'op-key', agentId: 'claude-test',
      queryFn: queryFn as never,
    });

    await agent.tick({
      event: { type: 'message', text: 'loop' },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff: recordingEff,
    });

    assert.ok(turns < 10, 'fresh input past the budget must still abort the query');
    // And the cut-off must be on the record — a wake that stopped mid-job used
    // to be indistinguishable from one that finished.
    assert.ok(
      recorded.some((t) => /Wake stopped early/.test(t)),
      'an aborted wake records why it stopped',
    );
  });

  /**
   * ZIG-1327 — the wall behind the spend guard. Turn exhaustion arrives as a
   * thrown error result rather than a break, so it needs its own note; the
   * throw still propagates, because the wake really did fail.
   */
  it('ZIG-1327: turn exhaustion is recorded, and still raised', async () => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    const recorded: string[] = [];
    const eff: EffectHandler = async (effect: Effect) => {
      if (effect.kind === 'record-event') {
        recorded.push(String((effect as { entry?: { text?: string } }).entry?.text ?? ''));
        return {};
      }
      return effect.kind === 'read-context'
        ? { history: [], agreements: [], agents: [], users: [] }
        : {};
    };

    const queryFn = mock.fn(async function* () {
      yield {
        type: 'assistant',
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 1_000, output_tokens: 10 } },
        session_id: 'sess-turns-out',
        uuid: '00000000-0000-4000-8000-000000000300',
      };
      throw new Error('Claude Code returned an error result: Reached maximum number of turns (30)');
    });

    const agent = new ClaudeBrain({
      workflow: WORKFLOW, toolManager, description: 'Test', model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key', operatorKey: 'op-key', agentId: 'claude-test',
      queryFn: queryFn as never,
    });

    await assert.rejects(
      agent.tick({
        event: { type: 'message', text: 'long job' },
        identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
        eff,
      }),
      /maximum number of turns/,
    );
    assert.ok(
      recorded.some((t) => /Wake stopped early: the turn cap \(30\)/.test(t)),
      'the lane records that the wake ran out of turns',
    );
  });
});

describe('ClaudeBrain assistant-text → thoughts (ZIG-787)', () => {
  const makeAgent = (queryFn: unknown) => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    return new ClaudeBrain({
      workflow: WORKFLOW,
      toolManager,
      description: 'Test',
      model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key',
      operatorKey: 'op-key',
      agentId: 'claude-test',
      queryFn: queryFn as never,
    });
  };

  const assistantMsg = (content: unknown[]) => ({
    type: 'assistant',
    session_id: 'sess-1',
    message: { content },
  });
  const resultMsg = (num_turns = 1) => ({
    type: 'result',
    subtype: 'success',
    num_turns,
    usage: { input_tokens: 1, output_tokens: 1 },
    session_id: 'sess-1',
  });

  const collectingEff = (effects: Effect[]): EffectHandler => (async (effect: Effect) => {
    effects.push(effect);
    if (effect.kind === 'read-context') {
      return { history: [], agreements: [], agents: [], users: [{ userId: 'user-1' }] };
    }
    return { ok: true };
  }) as EffectHandler;

  const thoughts = (effects: Effect[]) =>
    effects.filter((e): e is Extract<Effect, { kind: 'record-event' }> =>
      e.kind === 'record-event' && (e.entry as { kind?: string })?.kind === 'thought');

  const tick = (agent: ClaudeBrain, eff: EffectHandler) => agent.tick({
    event: { type: 'message', text: 'hi', senderId: 'user-1', senderType: 'USER' },
    identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
    eff,
  });

  it('records each assistant turn\'s text as an agent-private thought (not a chat message)', async () => {
    const effects: Effect[] = [];
    const queryFn = mock.fn(async function* () {
      yield assistantMsg([{ type: 'text', text: 'Let me check the inbox.' }, { type: 'tool_use', name: 'ziggs_inbox', input: {} }]);
      yield assistantMsg([{ type: 'text', text: 'Done — replied to the client.' }]);
      yield resultMsg(2);
    });

    await tick(makeAgent(queryFn), collectingEff(effects));

    const th = thoughts(effects);
    assert.equal(th.length, 2);
    assert.deepEqual(th.map((t) => (t.entry as { text: string }).text), [
      'Let me check the inbox.',
      'Done — replied to the client.',
    ]);
    th.forEach((t) => assert.equal(t.sessionId, 'chat-1'));
    // Narration must NOT leak into the counterparty chat.
    assert.equal(effects.filter((e) => e.kind === 'send-message').length, 0);
  });

  it('records nothing for a pure tool-use turn (no text)', async () => {
    const effects: Effect[] = [];
    const queryFn = mock.fn(async function* () {
      yield assistantMsg([{ type: 'tool_use', name: 'ziggs_inbox', input: {} }]);
      yield resultMsg();
    });

    await tick(makeAgent(queryFn), collectingEff(effects));

    assert.equal(thoughts(effects).length, 0);
    assert.equal(effects.filter((e) => e.kind === 'send-message').length, 0);
  });

  it('captures metrics and session_id alongside thought recording', async () => {
    const effects: Effect[] = [];
    const queryFn = mock.fn(async function* () {
      yield assistantMsg([{ type: 'text', text: 'working on it' }]);
      yield resultMsg(3);
    });

    const out = await tick(makeAgent(queryFn), collectingEff(effects));

    assert.equal(thoughts(effects).length, 1);
    assert.equal(out.metrics?.llmCalls, 3);
    assert.equal(out.ctx.claudeSessionId, 'sess-1');
  });

  it('a failed thought record does not abort the run (metrics still returned)', async () => {
    const eff: EffectHandler = (async (effect: Effect) => {
      if (effect.kind === 'read-context') return { history: [], agreements: [], agents: [], users: [] };
      if (effect.kind === 'record-event') throw new Error('artifacts down');
      return { ok: true };
    }) as EffectHandler;
    const queryFn = mock.fn(async function* () {
      yield assistantMsg([{ type: 'text', text: 'will fail to record' }]);
      yield resultMsg();
    });

    const out = await tick(makeAgent(queryFn), eff);

    assert.equal(out.parked, true);
    assert.equal(out.metrics?.llmCalls, 1);
  });

  it('does not block the query stream on a hung artifacts backend (fire-and-forget)', async () => {
    // record-event never resolves; the wake must still complete. Under a blocking
    // `await` this test would hang. Recording is fire-and-forget, so the loop
    // consumes every message and the tick returns regardless.
    const eff: EffectHandler = (async (effect: Effect) => {
      if (effect.kind === 'read-context') return { history: [], agreements: [], agents: [], users: [] };
      if (effect.kind === 'record-event') return new Promise(() => {}); // never settles
      return { ok: true };
    }) as EffectHandler;
    const queryFn = mock.fn(async function* () {
      yield assistantMsg([{ type: 'text', text: 'turn 1' }]);
      yield assistantMsg([{ type: 'text', text: 'turn 2' }]);
      yield resultMsg(2);
    });

    const out = await tick(makeAgent(queryFn), eff);

    assert.equal(out.parked, true);
    assert.equal(out.metrics?.llmCalls, 2);
    assert.equal(out.ctx.claudeSessionId, 'sess-1');
  });
});

describe('ClaudeBrain api-key handling (cleanup)', () => {
  it('passes the key via query options.env and does not mutate global process.env', async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = 'sentinel-unchanged';
      const toolManager = new ToolManager();
      toolManager.registerAll(CLAUDE_SDK_TOOLS);
      const eff: EffectHandler = (async (effect: Effect) => {
        if (effect.kind === 'read-context') return { history: [], agreements: [], agents: [], users: [] };
        return { ok: true };
      }) as EffectHandler;
      const queryFn = mock.fn(async function* () {
        yield { type: 'result', subtype: 'success', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 's' };
      });
      const agent = new ClaudeBrain({
        workflow: WORKFLOW,
        toolManager,
        description: 'Test',
        model: 'claude-sonnet-5-5',
        anthropicKey: 'agent-key-xyz',
        operatorKey: 'op-key',
        agentId: 'claude-test',
        queryFn: queryFn as never,
      });

      await agent.tick({
        event: { type: 'message', text: 'hi' },
        identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
        eff,
      });

      const opts = (queryFn.mock.calls[0]?.arguments?.[0] as { options?: { env?: Record<string, string> } })?.options;
      assert.equal(opts?.env?.ANTHROPIC_API_KEY, 'agent-key-xyz');
      // The agent's key must NOT leak into the shared process environment.
      assert.equal(process.env.ANTHROPIC_API_KEY, 'sentinel-unchanged');
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });
});

describe('ClaudeBrain token accounting + wake breaker (ZIG-759 follow-up)', () => {
  const makeAgent = (queryFn: unknown) => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    return new ClaudeBrain({
      workflow: WORKFLOW, toolManager, description: 'Test', model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key', operatorKey: 'op-key', agentId: 'claude-test', queryFn: queryFn as never,
    });
  };
  const eff: EffectHandler = (async (effect: Effect) =>
    effect.kind === 'read-context' ? { history: [], agreements: [], agents: [], users: [] } : { ok: true }) as EffectHandler;

  it('metrics count cache read/creation tokens (what the key actually pays for)', async () => {
    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result', subtype: 'success', num_turns: 2, session_id: 'sess-cache',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 1_000,
          cache_creation_input_tokens: 100,
          output_tokens: 5,
        },
      };
    });
    const out = await makeAgent(queryFn).tick({
      event: { type: 'message', text: 'hi' },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });
    assert.equal(out.metrics?.tokens.input, 1_110);
    assert.equal(out.metrics?.tokens.total, 1_115);
  });

  it('skips the LLM entirely when the lane wakes faster than the window allows', async () => {
    const queryFn = mock.fn(async function* () {
      yield { type: 'result', subtype: 'success', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 's' };
    });
    const now = Date.now();
    const stormed = Array.from({ length: 40 }, () => now - 1_000);
    const out = await makeAgent(queryFn).tick({
      event: { type: 'resource_changed' },
      ctx: { recentDeliveries: stormed } as never,
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });
    assert.equal(queryFn.mock.calls.length, 0, 'breaker must skip query()');
    assert.equal(out.parked, true);
    assert.equal(out.metrics?.llmCalls, 0);
  });

  it('prunes stale wake timestamps — old activity does not trip the breaker', async () => {
    const queryFn = mock.fn(async function* () {
      yield { type: 'result', subtype: 'success', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 's' };
    });
    const stale = Array.from({ length: 40 }, () => Date.now() - 11 * 60_000);
    const out = await makeAgent(queryFn).tick({
      event: { type: 'message', text: 'hi' },
      ctx: { recentDeliveries: stale } as never,
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });
    assert.equal(queryFn.mock.calls.length, 1, 'stale wakes must not block a real wake');
    assert.equal(out.ctx.recentDeliveries?.length, 1);
  });

  it('resets the Claude session when the resumed transcript grows too large (ZIG-816)', async () => {
    const queryFn = mock.fn(async function* () {
      // ZIG-1327: the ceiling reads the transcript — one turn's input — not the
      // wake's running total, so the fixture states it per turn. Two turns of a
      // 255K context is the same lane this always meant to catch; what it no
      // longer catches is a modest transcript that merely took many turns.
      yield {
        type: 'assistant',
        message: { usage: { input_tokens: 5_000, cache_read_input_tokens: 250_000, output_tokens: 20 } },
        session_id: 'sess-big',
        uuid: '00000000-0000-4000-8000-000000000010',
      };
      yield {
        type: 'result', subtype: 'success', num_turns: 2, session_id: 'sess-big',
        // Billable input (mostly resumed-transcript cache reads) over the 200K ceiling.
        usage: { input_tokens: 10_000, cache_read_input_tokens: 500_000, output_tokens: 40 },
      };
    });
    const out = await makeAgent(queryFn).tick({
      event: { type: 'message', text: 'hi' },
      ctx: { claudeSessionId: 'sess-big' } as never,
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });
    assert.equal(out.ctx.claudeSessionId, undefined, 'oversized session must be forgotten so the next wake is fresh');
  });

  it('keeps resuming a modestly-sized session (ZIG-816 does not over-reset)', async () => {
    const queryFn = mock.fn(async function* () {
      yield {
        type: 'result', subtype: 'success', num_turns: 2, session_id: 'sess-small',
        usage: { input_tokens: 2_000, cache_read_input_tokens: 30_000, output_tokens: 20 },
      };
    });
    const out = await makeAgent(queryFn).tick({
      event: { type: 'message', text: 'hi' },
      ctx: { claudeSessionId: 'sess-small' } as never,
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff,
    });
    assert.equal(out.ctx.claudeSessionId, 'sess-small', 'a small session must persist for resume');
  });
});

describe('ClaudeBrain chat-missing guard (deleted-chat wakes)', () => {
  const makeAgent = (queryFn: unknown, readAgreement: (id: string) => Promise<unknown> = async () => null) => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    return new ClaudeBrain({
      workflow: WORKFLOW, toolManager, description: 'Test', model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key', operatorKey: 'op-key', agentId: 'claude-test', queryFn: queryFn as never,
      readAgreement,
    });
  };
  const effWithChatMissing: EffectHandler = (async (effect: Effect) =>
    effect.kind === 'read-context'
      ? { history: [], agreements: [], agents: [], users: [], chatMissing: true }
      : { ok: true }) as EffectHandler;
  const okQuery = () => mock.fn(async function* () {
    yield { type: 'result', subtype: 'success', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 's' };
  });

  it('skips query() on a message wake when the chat no longer resolves', async () => {
    const queryFn = okQuery();
    const out = await makeAgent(queryFn).tick({
      event: { type: 'message', text: 'stale replay', senderId: 'ziggs-agent', senderType: 'AGENT' },
      identity: { agentId: 'claude-test', sessionId: 'chat-deleted', laneKey: 'claude-test:chat-deleted' },
      eff: effWithChatMissing,
    });
    assert.equal(queryFn.mock.calls.length, 0, 'dead-chat message wake must not reach the model');
    assert.equal(out.parked, true);
    assert.equal(out.metrics?.llmCalls, 0);
    assert.equal(out.skippedReason, 'chat_unreadable:chat-deleted');
  });

  it('skips query() on a resource wake when the room is unreadable (ZIG-1799)', async () => {
    const queryFn = okQuery();
    const out = await makeAgent(queryFn, async (agreementId) => ({ agreementId })).tick({
      event: { type: 'task_result', receiverId: 'claude-test', result: { state: 'active', taskId: 't1', agreementId: 'agr_1' } },
      identity: { agentId: 'claude-test', sessionId: 'chat-no-grant', laneKey: 'claude-test:chat-no-grant' },
      eff: effWithChatMissing,
    });
    assert.equal(queryFn.mock.calls.length, 0, 'unread-room resource wake must not reach the model');
    assert.equal(out.parked, true);
    assert.equal(out.metrics?.llmCalls, 0);
    assert.equal(out.skippedReason, 'chat_unreadable:chat-no-grant');
  });

  it('still runs task wakes even when chatMissing (legacy bare-agreement lane)', async () => {
    // ZIG-975: wakes should key on agrn-/origin chat, not bare agr_. A leftover
    // agreement-keyed lane still runs (task work must not stall) but is a mis-key.
    const queryFn = okQuery();
    const out = await makeAgent(queryFn, async (agreementId) => ({ agreementId })).tick({
      event: { type: 'task_result', receiverId: 'claude-test', result: { state: 'active', taskId: 't1', agreementId: 'agr_1' } },
      identity: { agentId: 'claude-test', sessionId: 'agr_1', laneKey: 'claude-test:agr_1' },
      eff: effWithChatMissing,
    });
    assert.equal(queryFn.mock.calls.length, 1, 'task wakes must still run even on a mis-keyed lane');
    assert.equal(out.parked, true);
  });

  it('runs a verified customer approval through its missing agreement mailbox with one authoritative read', async () => {
    const queryFn = okQuery();
    const read = mock.fn(async (agreementId: string) => ({ agreementId, status: 'active' }));
    const out = await makeAgent(queryFn, read).tick({
      event: { type: 'resource_changed', agreementId: 'agr_approved', resource: { kind: 'agreement', reason: 'approval:approved', agreementId: 'agr_approved' } },
      identity: { agentId: 'claude-test', sessionId: 'agrn-agr_approved', laneKey: 'claude-test:agrn-agr_approved' },
      eff: effWithChatMissing,
    });
    assert.equal(read.mock.callCount(), 1);
    assert.equal(queryFn.mock.callCount(), 1);
    assert.equal(out.skippedReason, undefined);
  });

  it('skips the phantom seller greeting without running query or opening a room', async () => {
    const queryFn = okQuery();
    const effects: Effect[] = [];
    const out = await makeAgent(queryFn, async (agreementId) => ({ agreementId, status: 'open', providerPinned: true,
      parties: { provider: { actor: 'claude-test' }, payer: { principal: 'everyone' } },
    })).tick({
      event: { type: 'resource_changed', agreementId: 'agr_listing', resource: { kind: 'agreement', reason: 'approval:approved', agreementId: 'agr_listing' } },
      identity: { agentId: 'claude-test', sessionId: 'agrn-agr_listing', laneKey: 'claude-test:agrn-agr_listing' },
      eff: async (effect) => { effects.push(effect); return {}; },
    });
    assert.equal(queryFn.mock.callCount(), 0);
    assert.equal(out.metrics?.llmCalls, 0);
    assert.equal(out.skippedReason, 'standing_listing_acceptance');
    assert.deepEqual(effects, []);
  });

  it('rejects a mismatched agreement lane even when its prefix looks valid', async () => {
    const queryFn = okQuery();
    const read = mock.fn(async (agreementId: string) => ({ agreementId, status: 'active' }));
    const out = await makeAgent(queryFn, read).tick({
      event: { type: 'task_result', result: { agreementId: 'agr_actual', state: 'active', taskId: 'task1' } },
      identity: { agentId: 'claude-test', sessionId: 'agrn-agr_forged', laneKey: 'claude-test:agrn-agr_forged' },
      eff: effWithChatMissing,
    });
    assert.equal(read.mock.callCount(), 0);
    assert.equal(queryFn.mock.callCount(), 0);
    assert.equal(out.skippedReason, 'chat_unreadable:agrn-agr_forged');
  });
});

describe('ClaudeBrain wake-derived idempotency keys (delivery law)', () => {
  const makeAgent = (queryFn: unknown) => {
    const toolManager = new ToolManager();
    toolManager.registerAll(CLAUDE_SDK_TOOLS);
    return new ClaudeBrain({
      workflow: WORKFLOW, toolManager, description: 'Test', model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key', operatorKey: 'op-key', agentId: 'claude-test', queryFn: queryFn as never,
    });
  };
  const thinkingQuery = () => mock.fn(async function* () {
    yield {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'working on it' }], usage: { input_tokens: 1, output_tokens: 1 } },
    };
    yield { type: 'result', subtype: 'success', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 's' };
  });
  const captureEff = (recorded: Array<Extract<Effect, { kind: 'record-event' }>>): EffectHandler =>
    (async (effect: Effect) => {
      if (effect.kind === 'record-event') recorded.push(effect);
      if (effect.kind === 'read-context') return { history: [], agreements: [], agents: [], users: [] };
      return { ok: true };
    }) as EffectHandler;

  it('thought artifacts carry a key that a crash-replay of the same wake reproduces', async () => {
    const runWake = async () => {
      const recorded: Array<Extract<Effect, { kind: 'record-event' }>> = [];
      await makeAgent(thinkingQuery()).tick({
        event: { type: 'message', text: 'hi', messageId: 'm-77', senderId: 'user-1', senderType: 'USER' },
        identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
        eff: captureEff(recorded),
      });
      return recorded;
    };

    const first = await runWake();
    const replay = await runWake();

    assert.equal(first.length, 1);
    assert.equal(first[0].entry.kind, 'thought');
    // Content-derived since ZIG-1083 (`_a_<hash>`), not a per-wake ordinal —
    // a redelivered wake that re-thinks differently must not collide.
    assert.match(String(first[0].idempotencyKey), /^wk_[0-9a-f]{40}_a_[0-9a-f]{16}$/);
    assert.equal(replay[0].idempotencyKey, first[0].idempotencyKey);
  });

  it('a wake with no durable event identity records thoughts keyless', async () => {
    const recorded: Array<Extract<Effect, { kind: 'record-event' }>> = [];
    await makeAgent(thinkingQuery()).tick({
      // Message with no messageId — nothing replay-stable to anchor on.
      event: { type: 'message', text: 'hi', senderId: 'user-1', senderType: 'USER' },
      identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
      eff: captureEff(recorded),
    });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].idempotencyKey, undefined);
  });

  it('ZIG-1725: overlapping wakes keep their own room, sender, and write keys', async () => {
    const toolManager = new ToolManager();
    toolManager.register(
      defineTool('probe_ctx', {}, async () => ({ ok: true }), { description: 'probe wake context' }),
    );

    const toolCalls: Array<Extract<Effect, { kind: 'tool-call' }>> = [];
    let releaseAlice: () => void;
    const aliceMayCall = new Promise<void>((resolve) => {
      releaseAlice = resolve;
    });

    const queryFn = mock.fn(async function* (req: {
      prompt?: unknown;
      options?: { mcpServers?: { ziggs?: { instance?: { connect: (t: unknown) => Promise<void> } } } };
    }) {
      const prompt = typeof req.prompt === 'string' ? req.prompt : JSON.stringify(req.prompt ?? '');
      const isAlice = prompt.includes('hello-alice');
      if (isAlice) {
        await aliceMayCall;
      } else {
        releaseAlice();
      }

      const server = req.options?.mcpServers?.ziggs;
      if (!server?.instance) throw new Error('expected in-process ziggs MCP server');
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'probe', version: '0.0.0' });
      await Promise.all([
        server.instance.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = await client.callTool({ name: 'probe_ctx', arguments: {} });
      if ((result as { isError?: boolean }).isError) {
        throw new Error(`probe_ctx failed: ${JSON.stringify(result)}`);
      }
      await client.close();

      yield {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'ok',
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-4000-8000-000000000172',
        session_id: isAlice ? 'sess-a' : 'sess-b',
      };
    });

    const agent = new ClaudeBrain({
      workflow: WORKFLOW,
      toolManager,
      description: 'Test',
      model: 'claude-sonnet-5-5',
      anthropicKey: 'test-key',
      operatorKey: 'op-key',
      agentId: 'claude-test',
      queryFn: queryFn as never,
    });

    const eff: EffectHandler = async (effect: Effect) => {
      if (effect.kind === 'read-context') {
        return { history: [], agreements: [], agents: [], users: [] };
      }
      if (effect.kind === 'tool-call') {
        toolCalls.push(effect);
        return { ok: true, result: { ok: true } };
      }
      return {};
    };

    await Promise.all([
      agent.tick({
        event: { type: 'message', text: 'hello-alice', senderId: 'alice', senderType: 'USER', messageId: 'm-a' },
        identity: { agentId: 'claude-test', sessionId: 'chat-a', laneKey: 'claude-test:chat-a' },
        eff,
      }),
      agent.tick({
        event: { type: 'message', text: 'hello-bob', senderId: 'bob', senderType: 'USER', messageId: 'm-b' },
        identity: { agentId: 'claude-test', sessionId: 'chat-b', laneKey: 'claude-test:chat-b' },
        eff,
      }),
    ]);

    assert.equal(toolCalls.length, 2);
    const byRoom = Object.fromEntries(toolCalls.map((call) => [call.sessionId, call]));
    assert.equal(byRoom['chat-a']?.senderId, 'alice');
    assert.equal(byRoom['chat-b']?.senderId, 'bob');
    assert.ok(byRoom['chat-a']?.writeKeys);
    assert.ok(byRoom['chat-b']?.writeKeys);
    assert.notEqual(byRoom['chat-a']?.writeKeys, byRoom['chat-b']?.writeKeys);
  });
});

describe('wakeAgreementOf', () => {
  it('takes the agreement the delivery is under', () => {
    assert.equal(wakeAgreementOf({ resource: { agreementId: 'agr_1' } }), 'agr_1');
  });

  it('names nothing when a batch spans agreements, or none names one', () => {
    assert.equal(
      wakeAgreementOf({
        events: [{ resource: { agreementId: 'agr_1' } }, { resource: { agreementId: 'agr_2' } }],
      }),
      undefined,
    );
    assert.equal(wakeAgreementOf({ resource: {} }), undefined);
    assert.equal(wakeAgreementOf(undefined), undefined);
  });
});
