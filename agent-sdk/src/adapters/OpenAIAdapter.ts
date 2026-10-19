import OpenAI from 'openai';
import type { ToolDefinition } from '../tools/defineTool.js';
import { runtimeLog } from '../shared/runtimeLog.js';

interface ChatResult {
  content: string | null;
  tool_calls: OpenAI.Chat.ChatCompletionMessageToolCall[] | null;
  message: OpenAI.Chat.ChatCompletionMessage;
  usage: OpenAI.CompletionUsage | undefined;
}

interface AdapterOptions {
  key?: string;
  model?: string;
}

/** OpenAI completion-token cap varies by model family (e.g. gpt-4o-mini max 16384). */
export function maxCompletionTokensForModel(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('gpt-4o')) return 16384;
  return 25000;
}

export class OpenAIAdapter {
  private client: OpenAI;
  model: string;

  constructor({ key, model = 'gpt-5.4' }: AdapterOptions) {
    this.client = new OpenAI({ apiKey: key });
    this.model = model;
  }

  async chat(
    prompt: string,
    tools: ToolDefinition[] = [],
    temperature = 0.2,
    systemHints: OpenAI.Chat.ChatCompletionMessageParam[] = [],
    options: Record<string, unknown> = {},
  ): Promise<ChatResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'Respond with valid JSON.' },
      ...systemHints,
      { role: 'user', content: prompt },
    ];
    return this.chatMessages(messages, tools, { ...options, temperature });
  }

  async chatMessages(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    tools: ToolDefinition[] = [],
    options: Record<string, unknown> = {},
  ): Promise<ChatResult> {
    const openAITools: OpenAI.Chat.ChatCompletionTool[] | undefined = tools.length > 0
      ? tools.map(t => {
          const fn = (t.schema.function || t.schema) as Record<string, unknown>;
          const tAny = t as unknown as Record<string, unknown>;
          const usageWhen = tAny['usage']
            ? ` Use when: ${(tAny['usage'] as Record<string, unknown>)['when']}`
            : '';
          return {
            type: 'function' as const,
            function: {
              name: fn['name'] as string,
              description: ((fn['description'] as string) || '') + usageWhen,
              parameters: fn['parameters'] as Record<string, unknown>,
            },
          };
        })
      : undefined;

    try {
      const { usage: _u, response_format: _explicitResponseFormat, ...restOptions } = options as Record<string, unknown>;
      const responseFormat = openAITools
        ? undefined
        : ((_explicitResponseFormat as OpenAI.ResponseFormatJSONObject) ?? { type: 'json_object' });

      // OpenAI 400s response_format:{type:'json_object'} unless the word "json"
      // appears somewhere in the messages. Callers are expected to mention it
      // in their system prompt, but that's an implicit cross-file contract —
      // guarantee it here instead of trusting every call site to remember.
      let finalMessages = messages;
      if (
        responseFormat?.type === 'json_object' &&
        !messages.some(m => {
          const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
          return /json/i.test(c);
        })
      ) {
        finalMessages = [...messages, { role: 'system', content: 'Respond with valid JSON.' }];
      }

      // Verbose LLM request/response logging — enabled for debugging.
      // Comment out again to reduce log noise.
      const divider = '─'.repeat(80);
      console.log(`\n${divider}`);
      console.log(`📤 LLM REQUEST → ${this.model}  (${finalMessages.length} msg${finalMessages.length === 1 ? '' : 's'})`);
      console.log(divider);
      for (const m of finalMessages) {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const len = content?.length ?? 0;
        console.log(`\n[${m.role.toUpperCase()}]  ${len} chars`);
        console.log(content ?? '');
      }
      console.log(`${divider}\n`);
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: finalMessages,
        stream: false,
        // Reasoning models (gpt-5.x/o-series) need a high cap for hidden
        // reasoning tokens; gpt-4o family is capped lower by the API.
        max_completion_tokens: maxCompletionTokensForModel(this.model),
        response_format: responseFormat,
        ...(openAITools && { tools: openAITools }),
        ...restOptions,
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

      const msg = res.choices[0].message;
      const finishReason = res.choices[0].finish_reason;
      const content = msg.content?.trim() ?? null;
      const toolCalls = msg.tool_calls?.length ? msg.tool_calls : null;
      // Verbose LLM response logging — enabled for debugging.
      // Comment out again to reduce log noise.
      console.log(`\n${divider}`);
      console.log(`📥 LLM RESPONSE ← ${this.model}  finish=${finishReason}`);
      console.log(divider);
      if (content) {
        console.log(`\n[CONTENT]  ${content.length} chars`);
        console.log(content);
      }
      if (toolCalls) {
        console.log(`\n[TOOL CALLS]  ${toolCalls.length}`);
        for (const tc of toolCalls) {
          console.log(`  → ${tc.function.name}(${tc.function.arguments})`);
        }
      }
      if (!content && !toolCalls) console.log('\n(no content, no tool calls)');
      if (res.usage) {
        const u = res.usage as OpenAI.CompletionUsage & { completion_tokens_details?: { reasoning_tokens?: number } };
        console.log(`\n[USAGE]  prompt=${u.prompt_tokens} completion=${u.completion_tokens}${u.completion_tokens_details?.reasoning_tokens != null ? ` (reasoning=${u.completion_tokens_details.reasoning_tokens})` : ''} total=${u.total_tokens}`);
      }
      console.log(`${divider}\n`);
      if (!content && !toolCalls && finishReason === 'length') {
        const u = res.usage as (OpenAI.CompletionUsage & { completion_tokens_details?: { reasoning_tokens?: number } }) | undefined;
        throw new Error(
          `LLM returned no usable output — completion token budget exhausted before any content ` +
          `(finish_reason=length, reasoning_tokens=${u?.completion_tokens_details?.reasoning_tokens ?? 'unknown'})`,
        );
      }
      return {
        content,
        tool_calls: toolCalls,
        message: msg,
        usage: res.usage,
      };
    } catch (error) {
      const err = error as Error & { status?: number; code?: string };
      runtimeLog.error('OpenAIAdapter', `LLM API call failed: ${err.message}`, {
        model: this.model,
        error: err.message,
        status: err.status || 'unknown',
        code: err.code || 'unknown',
      });
      throw error;
    }
  }

  async chatMessagesStream(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    onChunk: (text: string) => void,
  ): Promise<{ text: string; usage: OpenAI.CompletionUsage | undefined }> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
      // Without this, a streamed completion never returns a usage block — the
      // streamed reply (often the largest output) would bill tokens that are
      // counted nowhere. The usage arrives on a final chunk whose
      // `choices` is empty.
      stream_options: { include_usage: true },
      max_completion_tokens: maxCompletionTokensForModel(this.model),
    });
    let text = '';
    let usage: OpenAI.CompletionUsage | undefined;
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        text += delta;
        onChunk(delta);
      }
    }
    return { text, usage };
  }
}
