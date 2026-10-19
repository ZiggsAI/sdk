/**
 * ZIG-306: SDK LLM/effect observation seam
 *
 * 1. A fake LLM adapter injected via services.llm is used by the agent
 *    instead of the real OpenAIAdapter.
 * 2. effectTap observes every effect the handler dispatches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createZiggsEffectHandler } from '../src/platform/ZiggsEffectHandler.js';
import { createDeliveryWriteKeys } from '../src/runtime/deliveryWriteKeys.js';
import type { Effect, LlmMessage, LlmToolSchema } from '../src/types.js';

// ── minimal stubs ─────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<Parameters<typeof createZiggsEffectHandler>[0]> = {}) {
  const fakeLlm = {
    chatMessages: async (_messages: LlmMessage[], _tools?: LlmToolSchema[]) => ({
      content: 'hello from fake llm',
      tool_calls: null,
      usage: { total_tokens: 10, prompt_tokens: 7, completion_tokens: 3 },
    }),
  };

  return {
    llm: fakeLlm,
    artifactsClient: { write: async () => ({}), list: async () => ({ artifacts: [], latestSequence: null }), recordThought: async () => ({}) } as any,
    contextReadClient: {
      snapshot: async () => ({
        history: [],
        agreements: [],
        agents: [{ agentId: 'test-agent', role: 'self', isYou: true }],
        users: [],
        latestSequence: null,
      }),
    } as any,
    taskService: {} as any,
    agreementService: {} as any,
    messageSender: async () => {},
    toolManager: { executeTool: async () => ({ ok: true, result: 'done' }), registerAll: () => {}, register: () => {} } as any,
    operatorKey: 'test-key',
    agentId: 'test-agent',
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ZIG-306: effect observation seam', () => {
  it('uses an injected fake LLM adapter for llm-call effects', async () => {
    const deps = makeDeps();
    const eff = createZiggsEffectHandler(deps);

    const result = await eff({ kind: 'llm-call', messages: [], tools: [] });

    assert.equal((result as any).content, 'hello from fake llm');
  });

  it('effectTap is called for llm-call with effect and response', async () => {
    const tapped: Array<{ effect: Effect; response: unknown }> = [];
    const deps = makeDeps({
      effectTap: (effect, response) => tapped.push({ effect, response }),
    });
    const eff = createZiggsEffectHandler(deps);

    await eff({ kind: 'llm-call', messages: [], tools: [] });

    assert.equal(tapped.length, 1);
    assert.equal(tapped[0].effect.kind, 'llm-call');
    assert.equal((tapped[0].response as any).content, 'hello from fake llm');
  });

  it('effectTap observes send-message effects', async () => {
    const tapped: Effect[] = [];
    const deps = makeDeps({
      effectTap: (effect) => tapped.push(effect),
    });
    const eff = createZiggsEffectHandler(deps);

    await eff({ kind: 'send-message', sessionId: 'c1', receiverId: 'u1', text: 'hi' });

    assert.equal(tapped.length, 1);
    assert.equal(tapped[0].kind, 'send-message');
  });

  it('effectTap observes tool-call effects', async () => {
    const tapped: Effect[] = [];
    const deps = makeDeps({
      effectTap: (effect) => tapped.push(effect),
    });
    const eff = createZiggsEffectHandler(deps);

    await eff({ kind: 'tool-call', sessionId: 'c1', name: 'some_tool', args: { x: 1 } });

    assert.equal(tapped.length, 1);
    assert.equal(tapped[0].kind, 'tool-call');
  });

  it('tool-call emits operation_started + operation_completed artifacts (ZIG-775 shared executor)', async () => {
    const writes: Array<{ text?: string; contentType?: string }> = [];
    const deps = makeDeps({
      artifactsClient: {
        write: async (a: any) => { writes.push(a); return {}; },
        list: async () => ({ artifacts: [], latestSequence: null }),
        recordThought: async () => ({}),
      } as any,
    });
    const eff = createZiggsEffectHandler(deps);

    const r = await eff({ kind: 'tool-call', sessionId: 'c1', name: 'some_tool', args: { x: 1 } });

    assert.equal((r as any).ok, true);
    // ZIG-1120: operation breadcrumbs are fire-and-forget — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    const ops = writes.filter((w) => w.contentType === 'operation').map((w) => w.text ?? '');
    assert.equal(ops.length, 2);
    assert.match(ops[0], /^operation_started:/);
    assert.match(ops[1], /^operation_completed:/);
  });

  it('threads eff into the tool context so eff-backed tools resolve on the shared path (ZIG-775)', async () => {
    let receivedCtx: any = null;
    const deps = makeDeps({
      toolManager: {
        executeTool: async (_n: string, _a: any, ctx: any) => { receivedCtx = ctx; return { ok: true }; },
        registerAll: () => {},
        register: () => {},
      } as any,
    });
    const eff = createZiggsEffectHandler(deps);

    await eff({ kind: 'tool-call', sessionId: 'c1', name: 't', args: {} });

    assert.equal(typeof receivedCtx.eff, 'function');
    assert.equal(receivedCtx.chatId, 'c1');
  });

  it('effectTap is not called when not provided', async () => {
    const deps = makeDeps(); // no effectTap
    const eff = createZiggsEffectHandler(deps);

    // should not throw
    await eff({ kind: 'llm-call', messages: [], tools: [] });
    await eff({ kind: 'send-message', sessionId: 'c1', receiverId: 'u1', text: 'ok' });
  });

  it('read-context returns the fenced snapshot via one contextReadClient.snapshot call', async () => {
    let calls = 0;
    let sawChatId: string | undefined;
    const artifacts = {
      type: 'artifacts', via: { kind: 'chat', id: 'c1' },
      items: [{ artifactId: 'dated-note', name: 'Hiring — September 19', contentType: 'note', timestamp: '2026-09-19T00:00:00Z' }],
      hasMore: true, nextCursor: null, latestSequence: '2026-09-19T00:00:00Z',
    };
    const deps = makeDeps({
      contextReadClient: {
        snapshot: async (chatId: string) => {
          calls += 1;
          sawChatId = chatId;
          return {
            history: [{ text: 'hi', sender: { id: 'u1' } }],
            agreements: [],
            artifacts,
            agents: [{ agentId: 'test-agent', role: 'self', isYou: true }],
            users: [{ userId: 'u1', role: 'creator' }],
            latestSequence: '7',
          };
        },
      } as any,
    });
    const eff = createZiggsEffectHandler(deps);

    const snap = await eff({ kind: 'read-context', sessionId: 'c1' });

    assert.equal(calls, 1);
    assert.equal(sawChatId, 'c1');
    assert.equal((snap as any).latestSequence, '7');
    assert.equal((snap as any).history.length, 1);
    assert.equal((snap as any).users[0].userId, 'u1');
    assert.deepEqual(snap.artifacts, artifacts);
  });

  it('keeps each work brief inside its own packet on a mixed-work wake', async () => {
    const deps = makeDeps({ contextReadClient: { snapshot: async (_chat: string, opts: any) => ({
      history: [], agreements: [], agents: [], users: [],
      work: { agreementId: opts.agreementId },
      workBrief: { work: { agreementId: opts.agreementId }, audience: { participantRefs: [opts.agreementId] } },
    }) } as any });
    const eff = createZiggsEffectHandler(deps);
    const snap = await eff({ kind: 'read-context', sessionId: 'shared',
      opts: { workScopes: [{ agreementId: 'a' }, { agreementId: 'b' }] } });
    assert.equal(snap.workBrief, undefined);
    assert.deepEqual((snap.work as any).contexts.map((p: any) => p.workBrief.work.agreementId), ['a', 'b']);
    assert.deepEqual((snap.work as any).contexts.map((p: any) => p.workBrief.audience.participantRefs), [['a'], ['b']]);
  });

  it('read-context surfaces chatMissing from the server without throwing', async () => {
    const deps = makeDeps({
      contextReadClient: {
        snapshot: async () => ({
          history: [],
          agreements: [],
          agents: [{ agentId: 'test-agent', role: 'self', isYou: true }],
          users: [],
          latestSequence: null,
          chatMissing: true,
        }),
      } as any,
    });
    const eff = createZiggsEffectHandler(deps);

    const snap = await eff({ kind: 'read-context', sessionId: 'gone' });

    assert.equal((snap as any).chatMissing, true);
  });

  it('read-context degrades a 403 to chatMissing without throwing (ZIG-1799)', async () => {
    const deps = makeDeps({
      contextReadClient: {
        snapshot: async () => {
          const err = new Error('ContextReadClient.snapshot 403') as Error & { status?: number };
          err.status = 403;
          throw err;
        },
      } as any,
    });
    const eff = createZiggsEffectHandler(deps);

    const snap = await eff({ kind: 'read-context', sessionId: 'no-grant' });

    assert.equal((snap as any).chatMissing, true);
    assert.deepEqual((snap as any).history, []);
    assert.equal((snap as any).agents[0].isYou, true);
  });

  it('read-context degrades a 404 to chatMissing without throwing', async () => {
    const deps = makeDeps({
      contextReadClient: {
        snapshot: async () => {
          const err = new Error('ContextReadClient.snapshot 404') as Error & { status?: number };
          err.status = 404;
          throw err;
        },
      } as any,
    });
    const eff = createZiggsEffectHandler(deps);

    const snap = await eff({ kind: 'read-context', sessionId: 'gone' });

    assert.equal((snap as any).chatMissing, true);
    assert.deepEqual((snap as any).history, []);
    assert.equal((snap as any).agents[0].isYou, true);
  });

  it('read-context degrades a non-404 failure to an empty snapshot without throwing', async () => {
    const deps = makeDeps({
      contextReadClient: {
        snapshot: async () => {
          throw new Error('boom');
        },
      } as any,
    });
    const eff = createZiggsEffectHandler(deps);

    const snap = await eff({ kind: 'read-context', sessionId: 'c1' });

    assert.equal((snap as any).chatMissing, undefined);
    assert.deepEqual((snap as any).history, []);
    assert.equal((snap as any).agents[0].isYou, true);
  });

  it('llm-call and stream-text throw a clear error when no LLM adapter is wired (claude-sdk cognition)', async () => {
    const eff = createZiggsEffectHandler(makeDeps({ llm: undefined }));

    await assert.rejects(
      () => eff({ kind: 'llm-call', messages: [], tools: [] }),
      /llm-call effect requires an LLM adapter/,
    );
    await assert.rejects(
      () => eff({ kind: 'stream-text', sessionId: 'c1', receiverId: 'u1', messageId: 'm1', messages: [] }),
      /stream-text effect requires an LLM adapter/,
    );
  });
});

describe('delivery law: idempotent writes carry wake-derived keys', () => {
  const wakeEvent = { type: 'message', messageId: 'm-crash', senderId: 'u1' };

  it('operation artifacts carry keys that a crash-replay of the wake reproduces', async () => {
    const runWake = async () => {
      const writes: Array<{ contentType?: string; idempotencyKey?: string }> = [];
      const deps = makeDeps({
        artifactsClient: {
          write: async (a: any) => { writes.push(a); return {}; },
          list: async () => ({ artifacts: [], latestSequence: null }),
          recordThought: async () => ({}),
        } as any,
      });
      const eff = createZiggsEffectHandler(deps);
      const writeKeys = createDeliveryWriteKeys('agent-1:c1', wakeEvent);
      await eff({ kind: 'tool-call', sessionId: 'c1', name: 'tool_a', args: {}, writeKeys });
      await eff({ kind: 'tool-call', sessionId: 'c1', name: 'tool_b', args: {}, writeKeys });
      return writes.filter((w) => w.contentType === 'operation').map((w) => w.idempotencyKey);
    };

    const firstRun = await runWake();
    const replay = await runWake();

    assert.equal(firstRun.length, 4); // started+completed × 2 tools
    assert.ok(firstRun.every((k) => typeof k === 'string' && k.startsWith('wk_')));
    assert.equal(new Set(firstRun).size, 4); // unique within the wake
    assert.deepEqual(replay, firstRun); // identical across crash-replay
  });

  it('a keyless wake (no durable event identity) writes without keys, as before', async () => {
    const writes: Array<{ contentType?: string; idempotencyKey?: string }> = [];
    const deps = makeDeps({
      artifactsClient: {
        write: async (a: any) => { writes.push(a); return {}; },
        list: async () => ({ artifacts: [], latestSequence: null }),
        recordThought: async () => ({}),
      } as any,
    });
    const eff = createZiggsEffectHandler(deps);
    const writeKeys = createDeliveryWriteKeys('agent-1:c1', { type: 'state-timeout', state: 'idle', waitedMs: 5 });

    await eff({ kind: 'tool-call', sessionId: 'c1', name: 't', args: {}, writeKeys });

    const ops = writes.filter((w) => w.contentType === 'operation');
    assert.equal(ops.length, 2);
    assert.ok(ops.every((w) => w.idempotencyKey === undefined));
  });

  it('threads writeKeys into the tool context so write tools can derive their keys', async () => {
    let receivedCtx: any = null;
    const deps = makeDeps({
      toolManager: {
        executeTool: async (_n: string, _a: any, ctx: any) => { receivedCtx = ctx; return { ok: true }; },
        registerAll: () => {},
        register: () => {},
      } as any,
    });
    const eff = createZiggsEffectHandler(deps);
    const writeKeys = createDeliveryWriteKeys('agent-1:c1', wakeEvent);

    await eff({ kind: 'tool-call', sessionId: 'c1', name: 't', args: {}, writeKeys });

    assert.equal(receivedCtx.writeKeys, writeKeys);
  });

  it('record-event threads the idempotency key to thought and generic artifact writes', async () => {
    const thoughts: Array<{ opts?: { idempotencyKey?: string } }> = [];
    const writes: Array<{ idempotencyKey?: string }> = [];
    const deps = makeDeps({
      artifactsClient: {
        write: async (a: any) => { writes.push(a); return {}; },
        list: async () => ({ artifacts: [], latestSequence: null }),
        recordThought: async (_chatId: string, _text: string, opts: any) => { thoughts.push({ opts }); return {}; },
      } as any,
    });
    const eff = createZiggsEffectHandler(deps);

    await eff({ kind: 'record-event', sessionId: 'c1', entry: { kind: 'thought', text: 'thinking' }, idempotencyKey: 'wk_x_a0' });
    await eff({ kind: 'record-event', sessionId: 'c1', entry: { kind: 'decision', note: 'n' }, idempotencyKey: 'wk_x_a1' });

    assert.equal(thoughts[0].opts?.idempotencyKey, 'wk_x_a0');
    assert.equal(writes[0].idempotencyKey, 'wk_x_a1');
  });
});
