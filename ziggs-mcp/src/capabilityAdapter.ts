import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import type {
  CapabilityDefinition,
  CapabilityEnv,
  CapabilityParam,
  Creds,
} from '@ziggs-ai/api-client';
import { readOnly, write, destructive } from './toolAnnotations.js';
import { registerStrictTool } from './strictParams.js';
import { toolError } from './toolError.js';

/** One JSON text-content result shape for every MCP tool (was copied 3×). */
export function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * the MCP surface adapter for shared capability definitions
 * (api-client `capabilities/`). Lowers the neutral param DSL to zod v3 (the
 * MCP SDK's ZodRawShape; api-client itself carries no zod, and agent-sdk is on
 * zod v4, so the schema is defined once and lowered per surface).
 */
function zodParam(param: CapabilityParam): ZodTypeAny {
  let t: ZodTypeAny;
  switch (param.type) {
    case 'string':
      t = param.enum ? z.enum(param.enum as [string, ...string[]]) : z.string();
      break;
    case 'number':
      t = z.number();
      break;
    case 'boolean':
      t = z.boolean();
      break;
    case 'object':
      t = z.record(z.unknown());
      break;
    case 'array': {
      const items = param.items;
      if (items?.type === 'string') {
        const inner: ZodTypeAny = items.enum
          ? z.enum(items.enum as [string, ...string[]])
          : z.string();
        // A list of strings also takes one string, as a list of one: agents
        // write `scopeKind: "chat"` as often as `["chat"]`, and refusing it
        // costs a round trip for nothing. The schema still advertises a list.
        t = z.preprocess(
          (value) => (typeof value === 'string' ? [value] : value),
          z.array(inner),
        );
      } else {
        t = z.array(z.record(z.unknown()));
      }
      break;
    }
  }
  if (param.description) t = t.describe(param.description);
  if (!param.required) t = t.optional();
  return t;
}

export function toZodShape(params: Record<string, CapabilityParam>): ZodRawShape {
  const shape: ZodRawShape = {};
  for (const [name, param] of Object.entries(params)) {
    shape[name] = zodParam(param);
  }
  return shape;
}

export interface RegisterCapabilityOptions {
  /** Web-app origin for human-facing URLs (claim links etc.). */
  webUrl?: string;
  /** Surface-local response decoration (e.g. the read-plan on ziggs_context_read). */
  transformResult?: (result: unknown, args: Record<string, unknown>) => unknown;
}

export function registerCapability(
  server: McpServer,
  cap: CapabilityDefinition,
  creds: Creds,
  opts: RegisterCapabilityOptions = {},
): void {
  const annotations =
    cap.annotation === 'read-only'
      ? readOnly(cap.title)
      : cap.annotation === 'destructive'
        ? destructive(cap.title)
        : write(cap.title);
  registerStrictTool(
    server,
    cap.names.mcp,
    toZodShape(cap.params),
    annotations,
    async (args: Record<string, unknown>) => {
      try {
        const env: CapabilityEnv = { creds, webUrl: opts.webUrl, surface: 'mcp' };
        const result = await cap.handler(args, env);
        return textResult(
          opts.transformResult ? opts.transformResult(result, args) : result,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );
}

export function registerCapabilities(
  server: McpServer,
  caps: CapabilityDefinition[],
  creds: Creds,
  opts: RegisterCapabilityOptions = {},
): void {
  for (const cap of caps) registerCapability(server, cap, creds, opts);
}
