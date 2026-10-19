import Anthropic from '@anthropic-ai/sdk';
import type { LlmMessage, LlmResponse, LlmToolCall, LlmToolSchema } from '../types.js';
import { runtimeLog } from '../shared/runtimeLog.js';

interface AdapterOptions {
  key?: string;
  model?: string;
}

// Claude 4.7+ models reject sampling params (temperature/top_p/top_k) with a
// 400 and run without thinking when the `thinking` param is omitted. We omit
// both on purpose: the SDK's LlmMessage history cannot round-trip thinking
// blocks through the tool loop, so thinking must stay off.
const MAX_COMPLETION_TOKENS = 16000;

/**
 * Anthropic adapter satisfying the same LlmAdapter contract as OpenAIAdapter:
 * OpenAI-wire-shaped LlmMessage[] in, { content, tool_calls, usage } out.
 * Selected by Agent when the configured model id starts with "claude".
 */
export class AnthropicAdapter {
  private client: Anthropic;
  model: string;

  constructor({ key, model = 'claude-opus-4-8' }: AdapterOptions) {
    this.client = new Anthropic({ apiKey: key });
    this.model = model;
  }

  async chat(
    prompt: string,
    tools: LlmToolSchema[] = [],
    _temperature = 0,
    systemHints: LlmMessage[] = [],
    options: Record<string, unknown> = {},
  ): Promise<LlmResponse> {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'Respond with valid JSON.' },
      ...systemHints,
      { role: 'user', content: prompt },
    ];
    return this.chatMessages(messages, tools, options);
  }

  async chatMessages(
    messages: LlmMessage[],
    tools: LlmToolSchema[] = [],
    _options: Record<string, unknown> = {},
  ): Promise<LlmResponse> {
    const { system, anthropicMessages } = translateMessages(messages);
    const anthropicTools = toAnthropicTools(tools);

    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_COMPLETION_TOKENS,
        ...(system ? { system } : {}),
        messages: anthropicMessages,
        ...(anthropicTools ? { tools: anthropicTools } : {}),
      });

      if (res.stop_reason === 'refusal') {
        throw new Error(`LLM refused the request (stop_reason=refusal)`);
      }

      const content = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim() || null;
      const toolCalls: LlmToolCall[] | null = (() => {
        const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (!uses.length) return null;
        return uses.map(u => ({
          id: u.id,
          function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
        }));
      })();

      if (!content && !toolCalls && res.stop_reason === 'max_tokens') {
        throw new Error(
          `LLM returned no usable output — completion token budget exhausted before any content (stop_reason=max_tokens)`,
        );
      }

      return {
        content: content ?? undefined,
        tool_calls: toolCalls ?? undefined,
        usage: res.usage
          ? {
              prompt_tokens: res.usage.input_tokens,
              completion_tokens: res.usage.output_tokens,
              total_tokens: res.usage.input_tokens + res.usage.output_tokens,
            }
          : undefined,
      };
    } catch (error) {
      const err = error as Error & { status?: number };
      runtimeLog.error('AnthropicAdapter', `LLM API call failed: ${err.message}`, {
        model: this.model,
        error: err.message,
        status: err.status ?? 'unknown',
      });
      throw error;
    }
  }

  async chatMessagesStream(
    messages: LlmMessage[],
    onChunk: (text: string) => void,
  ): Promise<{ text: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined }> {
    const { system, anthropicMessages } = translateMessages(messages);
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: MAX_COMPLETION_TOKENS,
      ...(system ? { system } : {}),
      messages: anthropicMessages,
    });
    let text = '';
    stream.on('text', (delta) => {
      text += delta;
      onChunk(delta);
    });
    const final = await stream.finalMessage();
    const u = final.usage;
    // Fold cache read/creation into prompt tokens so the streamed reply is not
    // undercounted (cache traffic was the bulk of the drain).
    const usage = u
      ? {
          prompt_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          completion_tokens: u.output_tokens ?? 0,
          total_tokens:
            (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0),
        }
      : undefined;
    return { text, usage };
  }
}

/**
 * Convert the runtime's tool list into Anthropic's `tools` param.
 *
 * The declared `LlmToolSchema` type (`{ type, function }`) is a lie at runtime:
 * `runTurn` launders `ToolDefinition[]` (shape `{ schema: { function } }`)
 * through an `as unknown as LlmToolSchema[]` cast before it reaches any adapter.
 * OpenAIAdapter already reads `t.schema.function || t.schema`; this must do the
 * same, or every claude-backed agent whose state exposes ≥1 tool crashes on
 * `t.function` being undefined ("Cannot read properties of undefined (reading
 * 'name')"). Both shapes are accepted so raw wire-shaped tools also work.
 */
export function toAnthropicTools(tools: LlmToolSchema[] = []): Anthropic.Tool[] | undefined {
  if (!tools.length) return undefined;
  return tools.map(t => {
    const td = t as unknown as {
      schema?: { function?: Record<string, unknown> };
      function?: Record<string, unknown>;
    };
    const fn = (td.schema?.function ?? td.function ?? {}) as Record<string, unknown>;
    return {
      name: fn['name'] as string,
      description: (fn['description'] as string) ?? '',
      input_schema: (fn['parameters'] ?? { type: 'object' }) as Anthropic.Tool.InputSchema,
    };
  });
}

/**
 * OpenAI-wire-shaped LlmMessage[] → Anthropic { system, messages }.
 * - system messages concatenate into the top-level system param
 * - assistant tool_calls become tool_use blocks (arguments JSON-parsed)
 * - role:"tool" results become user-turn tool_result blocks
 * Consecutive same-role turns are merged (Anthropic requires alternation to
 * start with user; the API tolerates consecutive same-role, but tool_result
 * blocks must open the user turn that answers a tool_use turn).
 */
function translateMessages(messages: LlmMessage[]): {
  system: string | undefined;
  anthropicMessages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: m.content ?? '',
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as Anthropic.ContentBlockParam[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeParseJson(tc.function.arguments),
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role, content: m.content ?? '' });
  }

  if (!out.length || out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '(session start)' });
  }

  return {
    system: systemParts.length ? systemParts.join('\n\n') : undefined,
    anthropicMessages: out,
  };
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? v : {};
  } catch {
    // Malformed arguments string from a prior turn's history: replaying it as
    // an empty input beats crashing the whole turn on someone else's output.
    return {};
  }
}
