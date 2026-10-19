import AjvModule from 'ajv';
import { ToolProvider } from './ToolProvider.js';
import { toolName, type ToolDefinition } from './defineTool.js';

// Ajv ships as CJS; handle both ESM default-import shapes
type ValidateFn = ((data: unknown) => boolean) & { errors?: unknown[] };
type AjvInstance = { compile: (schema: object) => ValidateFn; errorsText: (errors: unknown) => string };
const AjvClass = (AjvModule as unknown as { default?: unknown }).default ?? AjvModule;
const ajv = new (AjvClass as new (opts: object) => AjvInstance)({ allErrors: true, strict: false });

interface ToolError extends Error {
  type: string;
  cause?: unknown;
  data?: unknown;
}

function makeError(message: string, type: string, extra?: Partial<ToolError>): ToolError {
  const err = new Error(message) as ToolError;
  err.type = type;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * Ajv's own wording for a rejected unknown param is "must NOT have
 * additional properties", which names neither the offending key nor the ones
 * that would have worked. An agent reading that has nothing to correct against,
 * so the typo is named alongside the menu it should have come from.
 */
function describeErrors(parameters: object, errors: unknown[] | undefined | null): string {
  const unknown = (errors ?? [])
    .map((e) => (e as { keyword?: string; params?: { additionalProperty?: string } }))
    .filter((e) => e.keyword === 'additionalProperties')
    .map((e) => e.params?.additionalProperty)
    .filter((k): k is string => typeof k === 'string');
  if (unknown.length === 0) return ajv.errorsText(errors);
  const props = (parameters as { properties?: Record<string, unknown> }).properties ?? {};
  const accepted = Object.keys(props).join(', ') || '(none)';
  return (
    `unknown parameter(s) ${unknown.map((k) => `"${k}"`).join(', ')} — ` +
    `accepted params: ${accepted}. Check for a typo and call again; nothing was changed.`
  );
}

function stripNullish(args: Record<string, unknown>): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

export class ToolManager extends ToolProvider {
  private tools: Map<string, ToolDefinition>;

  constructor() {
    super();
    this.tools = new Map();
  }

  register(tool: ToolDefinition): string {
    if (!tool?.schema) throw makeError('Tool must have a schema', 'invalid_tool');
    if (typeof tool.handler !== 'function') throw makeError('Tool must have a handler function', 'invalid_tool');
    const name = toolName(tool);
    if (!name) throw makeError('Tool schema must have a name', 'invalid_tool');
    this.tools.set(name, tool);
    return name;
  }

  registerAll(tools: ToolDefinition[] = []): void {
    for (const tool of tools) this.register(tool);
  }

  async getAvailableTools(): Promise<ToolDefinition[]> {
    return Array.from(this.tools.values());
  }

  getTool(name: string): ToolDefinition | null {
    const normalized = this._normalizeName(name) as string;
    return this.tools.get(normalized) ?? null;
  }

  async executeTool(
    name: string,
    args: Record<string, unknown> = {},
    context: Record<string, unknown> = {},
  ): Promise<unknown> {
    const normalized = this._normalizeName(name) as string;
    const tool = this.tools.get(normalized);
    if (!tool) throw makeError(`Tool not found: ${name}`, 'tool_not_found');

    const cleanedArgs = stripNullish(args);
    this._validateArgs(tool, cleanedArgs);

    try {
      return await tool.handler(cleanedArgs, context);
    } catch (error) {
      throw makeError(`Tool "${name}" failed: ${(error as Error).message}`, 'tool_error', { cause: error });
    }
  }

  private _validateArgs(tool: ToolDefinition, args: Record<string, unknown>): void {
    const parameters = tool.schema.function?.['parameters'] || (tool.schema as unknown as Record<string, unknown>)['parameters'];
    if (!parameters) return;
    const validate = ajv.compile(parameters as object);
    if (!validate(args)) {
      const name = tool.schema.function?.['name'];
      throw makeError(
        `Invalid args for "${name}": ${describeErrors(parameters as object, validate.errors)}`,
        'validation_error',
        { data: { errors: validate.errors } },
      );
    }
  }
}
