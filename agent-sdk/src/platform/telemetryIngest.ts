import type { LlmResponse } from '../types.js';
import type { TelemetryClient } from '@ziggs-ai/api-client';

export function isTelemetryIngestEnabled(
  explicit?: boolean,
): boolean {
  if (explicit === false) return false;
  if (explicit === true) return true;
  const env = process.env.ZIGGS_TELEMETRY_INGEST;
  if (env === '0' || env === 'false') return false;
  return true;
}

export function usageFromLlmResponse(response: LlmResponse): {
  tokensTotal: number;
  tokensInput: number;
  tokensOutput: number;
} {
  const u = response.usage;
  const tokensInput =
    Number(u?.prompt_tokens ?? u?.promptTokens ?? 0) || 0;
  const tokensOutput =
    Number(u?.completion_tokens ?? u?.completionTokens ?? 0) || 0;
  const tokensTotal =
    Number(u?.total_tokens ?? u?.totalTokens ?? 0) ||
    tokensInput + tokensOutput;
  return { tokensTotal, tokensInput, tokensOutput };
}

export function buildLlmIngestPayload(
  response: LlmResponse,
  ctx: { sessionId?: string; durationMs: number; runId?: string; stateId?: string },
): Record<string, unknown> {
  const { tokensTotal, tokensInput, tokensOutput } =
    usageFromLlmResponse(response);
  const chatId = ctx.sessionId ?? null;
  return {
    source: 'agent',
    chatId,
    sessionId: chatId,
    execution: {
      llmCallsTotal: 1,
      tokensTotal,
      tokensInput,
      tokensOutput,
      ...(tokensTotal > 0 ? { tokensPerLlmCall: [tokensTotal] } : {}),
    },
    resource: { durationMs: Math.max(0, Math.round(ctx.durationMs)) },
    meta: {
      effect: 'llm-call',
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...(ctx.stateId ? { stateId: ctx.stateId } : {}),
    },
  };
}

export function buildToolIngestPayload(
  ctx: {
    sessionId: string;
    tool: string;
    durationMs: number;
    ok: boolean;
    runId?: string;
    stateId?: string;
  },
): Record<string, unknown> {
  return {
    source: 'agent',
    chatId: ctx.sessionId,
    sessionId: ctx.sessionId,
    execution: { executionLoops: 1 },
    resource: { durationMs: Math.max(0, Math.round(ctx.durationMs)) },
    meta: {
      effect: 'tool-call',
      tool: ctx.tool,
      ok: ctx.ok,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...(ctx.stateId ? { stateId: ctx.stateId } : {}),
    },
  };
}

/** Fire-and-forget; never throws to the effect handler. */
export function sendTelemetry(
  client: TelemetryClient | undefined,
  payload: Record<string, unknown>,
  enabled: boolean,
): void {
  if (!enabled || !client) return;
  void client.send(payload).catch(() => {});
}
