/**
 * ZIG-360: production telemetry ingest from ZiggsEffectHandler
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createZiggsEffectHandler } from '../src/platform/ZiggsEffectHandler.js';
import {
  buildLlmIngestPayload,
  usageFromLlmResponse,
  isTelemetryIngestEnabled,
} from '../src/platform/telemetryIngest.js';
import type { LlmMessage, LlmToolSchema } from '../src/types.js';

function makeDeps(overrides: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const telemetryClient = {
    send: async (payload: unknown) => {
      sent.push(payload);
    },
  };
  const fakeLlm = {
    chatMessages: async () => ({
      content: 'ok',
      usage: { total_tokens: 42, prompt_tokens: 30, completion_tokens: 12 },
    }),
  };
  return {
    deps: {
      llm: fakeLlm,
      artifactsClient: {
        write: async () => ({}),
        list: async () => ({ artifacts: [], latestSequence: null }),
        recordThought: async () => ({}),
      },
      taskService: {},
      agreementService: {},
      messageSender: async () => {},
      toolManager: {
        executeTool: async () => ({ ok: true, result: 'done' }),
        registerAll: () => {},
        register: () => {},
      },
      operatorKey: 'test-key',
      agentId: 'agent-telemetry',
      telemetryClient,
      telemetryIngest: true,
      ...overrides,
    },
    sent,
  };
}

describe('telemetryIngest helpers', () => {
  it('usageFromLlmResponse normalizes snake and camel usage', () => {
    const u = usageFromLlmResponse({
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
    assert.equal(u.tokensInput, 5);
    assert.equal(u.tokensOutput, 2);
    assert.equal(u.tokensTotal, 7);
  });

  it('isTelemetryIngestEnabled respects env and explicit override', () => {
    const prev = process.env.ZIGGS_TELEMETRY_INGEST;
    try {
      process.env.ZIGGS_TELEMETRY_INGEST = '0';
      assert.equal(isTelemetryIngestEnabled(), false);
      assert.equal(isTelemetryIngestEnabled(true), true);
      assert.equal(isTelemetryIngestEnabled(false), false);
    } finally {
      if (prev === undefined) delete process.env.ZIGGS_TELEMETRY_INGEST;
      else process.env.ZIGGS_TELEMETRY_INGEST = prev;
    }
  });

  it('buildLlmIngestPayload includes chatId and token fields', () => {
    const p = buildLlmIngestPayload(
      { usage: { total_tokens: 10, prompt_tokens: 6, completion_tokens: 4 } },
      { sessionId: 'chat-99', durationMs: 120 },
    );
    assert.equal(p.chatId, 'chat-99');
    assert.equal((p.execution as Record<string, unknown>).llmCallsTotal, 1);
    assert.equal((p.execution as Record<string, unknown>).tokensTotal, 10);
    assert.deepEqual((p.execution as Record<string, unknown>).tokensPerLlmCall, [10]);
  });

  it('buildLlmIngestPayload includes runId and stateId in meta when provided', () => {
    const p = buildLlmIngestPayload(
      { usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 } },
      { sessionId: 'chat-1', durationMs: 50, runId: 'run-abc', stateId: 'understanding' },
    );
    const meta = p.meta as Record<string, unknown>;
    assert.equal(meta.runId, 'run-abc');
    assert.equal(meta.stateId, 'understanding');
  });

  it('buildLlmIngestPayload omits runId/stateId when not provided', () => {
    const p = buildLlmIngestPayload(
      { usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 } },
      { sessionId: 'chat-1', durationMs: 50 },
    );
    const meta = p.meta as Record<string, unknown>;
    assert.equal('runId' in meta, false);
    assert.equal('stateId' in meta, false);
  });
});

describe('ZIG-360: ZiggsEffectHandler telemetry', () => {
  it('sends ingest after llm-call when telemetryClient is present', async () => {
    const { deps, sent } = makeDeps();
    const eff = createZiggsEffectHandler(deps as never);
    await eff({
      kind: 'llm-call',
      messages: [] as LlmMessage[],
      tools: [] as LlmToolSchema[],
      sessionId: 'chat-1',
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 1);
    const p = sent[0] as Record<string, unknown>;
    assert.equal(p.chatId, 'chat-1');
    assert.equal((p.execution as Record<string, number>).tokensTotal, 42);
  });

  it('sends ingest after tool-call', async () => {
    const { deps, sent } = makeDeps();
    const eff = createZiggsEffectHandler(deps as never);
    await eff({
      kind: 'tool-call',
      sessionId: 'chat-2',
      name: 'agent_search',
      args: { query: 'x' },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 1);
    assert.equal((sent[0] as Record<string, unknown>).chatId, 'chat-2');
  });

  it('skips ingest when telemetryIngest is false', async () => {
    const { deps, sent } = makeDeps({ telemetryIngest: false });
    const eff = createZiggsEffectHandler(deps as never);
    await eff({ kind: 'llm-call', messages: [], tools: [] });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 0);
  });
});
