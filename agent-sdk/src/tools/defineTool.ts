const PRIMITIVES = new Set(['string', 'number', 'boolean', 'integer']);

type FieldDef = string | unknown[] | Record<string, unknown>;

function convertField(value: FieldDef): { schema: Record<string, unknown>; required: boolean } {
  if (typeof value === 'string') {
    if (!PRIMITIVES.has(value)) throw new Error(`Unknown type shorthand: "${value}"`);
    return { schema: { type: value }, required: false };
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error('Array shorthand must have exactly one element describing the item type');
    const inner = value[0] as FieldDef;
    if (typeof inner === 'string') return { schema: { type: 'array', items: { type: inner } }, required: false };
    return { schema: { type: 'array', items: convertObject(inner as Record<string, unknown>) }, required: false };
  }
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    if (v['type'] && PRIMITIVES.has(v['type'] as string)) {
      const { required: isReq, ...rest } = v;
      return { schema: rest, required: !!isReq };
    }
    if (v['type'] === 'array' || v['type'] === 'object') {
      const { required: isReq, ...rest } = v;
      return { schema: rest, required: !!isReq };
    }
    return { schema: convertObject(v), required: false };
  }
  throw new Error(`Cannot convert field value: ${JSON.stringify(value)}`);
}

function convertObject(fields: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'required') continue;
    const { schema, required: isReq } = convertField(value as FieldDef);
    properties[key] = schema;
    if (isReq) required.push(key);
  }
  const result: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) result['required'] = required;
  return result;
}

export interface ToolDefinition {
  /** Host-owned classification. Custom tools require tracked work by default when execution control is enabled. */
  execution?: 'conversation' | 'work';
  schema: { type: 'function'; function: Record<string, unknown> };
  handler: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;
  echoUserSummaryOnSuccess?: boolean;
  /**
   * When true, the runtime will skip a second invocation of this tool in
   * the same assistant message. Use for "create an agreement"-style tools
   * where the model is prone to fire two near-identical create calls.
   */
  isAgreementCreation?: boolean;
  /**
   * When true, the runtime will execute this tool even when no state
   * action is bound to it. Use for discovery tools (e.g. agent search,
   * task board) that should always be callable.
   */
  isGenericFallback?: boolean;
}

export interface DefineToolOptions {
  /** Use conversation only for tools safe to run without a work task. This does not grant backend access. */
  execution?: 'conversation' | 'work';
  description?: string;
  echoUserSummaryOnSuccess?: boolean;
  isAgreementCreation?: boolean;
  isGenericFallback?: boolean;
}

/**
 * The name a tool registers under. `defineTool` always writes
 * `schema.function.name`, but hand-built and capability-adapted schemas have put
 * it at the top level too, so both are read — in one place, rather than at every
 * call site that needs to identify a tool.
 */
export function toolName(tool: ToolDefinition | undefined): string | undefined {
  const fromFunction = tool?.schema?.function?.['name'];
  const fromTop = (tool?.schema as unknown as Record<string, unknown> | undefined)?.['name'];
  const name = fromFunction ?? fromTop;
  return typeof name === 'string' && name ? name : undefined;
}

export function defineTool(
  name: string,
  params: Record<string, unknown>,
  handler: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>,
  options: DefineToolOptions = {},
): ToolDefinition {
  if (!name || typeof name !== 'string') throw new Error('defineTool: name is required');
  if (!handler || typeof handler !== 'function') throw new Error('defineTool: handler function is required');

  // the top level is closed so a misspelled param is rejected by
  // ToolManager's Ajv pass instead of being dropped on the floor. JSON Schema
  // allows unknown keys by default, so without this the validation ran and
  // passed while the handler quietly ignored what the model asked for.
  // Nested objects stay open: the typo class this guards against is at the
  // call surface the model writes, and closing nested payloads (task result,
  // plan) would reject shapes the backend accepts.
  const parameters = { ...convertObject(params || {}), additionalProperties: false };
  const fn: Record<string, unknown> = { name, parameters };
  if (options.description) fn['description'] = options.description;

  return {
    schema: { type: 'function', function: fn },
    handler,
    ...(options.execution ? { execution: options.execution } : {}),
    ...(options.echoUserSummaryOnSuccess ? { echoUserSummaryOnSuccess: true } : {}),
    ...(options.isAgreementCreation ? { isAgreementCreation: true } : {}),
    ...(options.isGenericFallback ? { isGenericFallback: true } : {}),
  };
}
