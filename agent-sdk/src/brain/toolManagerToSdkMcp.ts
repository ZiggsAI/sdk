import { z } from 'zod';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { ToolDefinition } from '../tools/defineTool.js';
import type { ClaudeSdkToolContext } from './claudeSdkTools.js';
import { withDeclaredMandate } from '../runtime/mandateDeclaration.js';
import { toolFailureText } from './toolFailureText.js';

type JsonSchema = Record<string, unknown>;

type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function jsonTypeToZod(field: JsonSchema): z.ZodTypeAny {
  const t = field['type'];
  if (t === 'string') {
    let s: z.ZodTypeAny = z.string();
    if (Array.isArray(field['enum'])) {
      const vals = field['enum'] as string[];
      if (vals.length > 0) s = z.enum(vals as [string, ...string[]]);
    }
    if (typeof field['description'] === 'string') s = s.describe(field['description']);
    return s;
  }
  if (t === 'number' || t === 'integer') {
    let n: z.ZodTypeAny = z.number();
    if (typeof field['description'] === 'string') n = n.describe(field['description']);
    return n;
  }
  if (t === 'boolean') return z.boolean();
  if (t === 'array') {
    const items = (field['items'] as JsonSchema | undefined) ?? { type: 'string' };
    return z.array(jsonTypeToZod(items));
  }
  if (t === 'object') {
    const props = (field['properties'] as Record<string, JsonSchema> | undefined) ?? {};
    const required = new Set((field['required'] as string[] | undefined) ?? []);
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, val] of Object.entries(props)) {
      let node = jsonTypeToZod(val);
      if (!required.has(key)) node = node.optional();
      shape[key] = node;
    }
    return z.object(shape).passthrough();
  }
  return z.unknown();
}

function parametersToZodShape(parameters: JsonSchema | undefined): z.ZodRawShape {
  if (!parameters || parameters['type'] !== 'object') return {};
  const props = (parameters['properties'] as Record<string, JsonSchema> | undefined) ?? {};
  const required = new Set((parameters['required'] as string[] | undefined) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, val] of Object.entries(props)) {
    let node = jsonTypeToZod(val);
    if (!required.has(key)) node = node.optional();
    shape[key] = node;
  }
  return shape;
}

/**
 * the Claude brain's args are validated here, before `eff` hands
 * them to the shared executor, so a plain shape means an unknown param is
 * stripped at this layer and ToolManager's own check never sees it. Closing
 * the object is what makes the rejection reach the brain: the call fails with
 * the offending key named, instead of succeeding on a request it silently
 * altered. The published schema also carries `additionalProperties: false`,
 * so the typo is usually caught before the call is made at all.
 */
function strictParams(toolName: string, shape: z.ZodRawShape): z.ZodTypeAny {
  const accepted = Object.keys(shape).join(', ') || '(none)';
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `Unknown parameter(s) ${issue.keys.map((k) => `"${k}"`).join(', ')} — ` +
          `${toolName} did not run. Accepted params: ${accepted}. ` +
          `Check for a typo and call again; nothing was changed.`
        : undefined,
  });
}

function toCallToolResult(value: unknown): CallToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

function toCallToolError(err: unknown): CallToolResult {
  return { content: [{ type: 'text', text: toolFailureText(err) }], isError: true };
}

/**
 * Map Ziggs `ToolDefinition`s to Claude Agent SDK MCP tools. Each handler routes
 * execution through `eff({ kind: 'tool-call' })` — the shared executor.
 */
export function buildSdkToolDefs(
  toolDefs: ToolDefinition[],
  getContext: () => ClaudeSdkToolContext,
  /** Which tools load on every wake; the rest wait for tool search. Default: all. */
  alwaysLoad: (name: string) => boolean = () => true,
): Array<SdkMcpToolDefinition> {
  return toolDefs.map((def) => {
    const fn = def.schema.function;
    const name = String(fn['name'] ?? '');
    const description = String(fn['description'] ?? name);
    const shape = parametersToZodShape(fn['parameters'] as JsonSchema | undefined);
    // A zero-param tool keeps the `_` envelope the Claude SDK needs, but the
    // envelope itself is closed too — its free-form payload is still checked
    // against the tool's own schema downstream in ToolManager.
    const inputSchema = strictParams(
      name,
      Object.keys(shape).length > 0 ? shape : { _: z.record(z.string(), z.unknown()).optional() },
    ) as unknown as z.ZodRawShape;

    return {
      name,
      description,
      inputSchema,
      _meta: { 'anthropic/alwaysLoad': alwaysLoad(name) },
      handler: async (args: Record<string, unknown>) => {
        try {
          const ctx = getContext();
          const payloadRaw =
            args._ != null && Object.keys(args).length === 1
              ? (args._ as Record<string, unknown>)
              : args;
          const payload = withDeclaredMandate(
            payloadRaw ?? {},
            name,
            {
              getTool: (toolName: string) => {
                const found = toolDefs.find(
                  (d) => String(d.schema.function['name'] ?? '') === toolName,
                );
                return found ? { schema: found.schema } : undefined;
              },
            } as never,
            typeof ctx.onBehalfOfAgreementId === 'string'
              ? ctx.onBehalfOfAgreementId
              : null,
            ctx.allowAutomaticMandate !== false,
          );
          const eff = ctx.eff;
          if (!eff) return toCallToolError(`tool "${name}": missing eff in tool context`);
          const sessionId = ctx.chatId ?? ctx.sessionId;
          if (!sessionId) return toCallToolError(`tool "${name}": missing sessionId in tool context`);
          const r = await eff({
            kind: 'tool-call',
            sessionId,
            name,
            args: payload ?? {},
            senderId: ctx.senderId,
            senderType: ctx.senderType,
            onBehalfOfAgreementId: ctx.onBehalfOfAgreementId as string | undefined,
            runId: ctx.runId,
            writeKeys: ctx.writeKeys,
            ...(ctx.checkout ? { checkout: ctx.checkout as import('../checkout/tools.js').CheckoutSession } : {}),
          });
          if (r.ok) return toCallToolResult(r.result);
          return toCallToolError(r.error ?? `tool "${name}" failed`);
        } catch (err) {
          return toCallToolError(err);
        }
      },
    };
  });
}

export function buildZiggsSdkMcpServer(
  toolDefs: ToolDefinition[],
  getContext: () => ClaudeSdkToolContext,
  options: {
    name?: string;
    instructions?: string;
    /** Per tool; a tool it returns false for is deferred behind tool search. */
    alwaysLoad?: (name: string) => boolean;
  } = {},
) {
  return createSdkMcpServer({
    name: options.name ?? 'ziggs',
    version: '1.0.0',
    instructions: options.instructions,
    tools: buildSdkToolDefs(toolDefs, getContext, options.alwaysLoad),
  });
}
