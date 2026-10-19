import { describeOperationError, type OperationError } from '@ziggs-ai/api-client';
export type ToolErrorShape = OperationError;
export const classifyToolError = (input: unknown): OperationError => describeOperationError(input, 'mcp');

/**
 * MCP tool error result: machine-readable code + cleaned message (+ hint).
 *
 * Pass the caught error itself, not `err.message` — an `ApiError` carries the
 * HTTP status and server `code` that decide the hint.
 * A plain string is still accepted for refusals this layer raises on its own.
 */
/** A refused read, answered as open would: its outcome, and any request to make. */
export function refusalError(refusal: {
  code: string;
  message: string;
  outcome?: string;
  ref?: { kind: string; id: string };
  actions?: unknown[];
}) {
  const shape: ToolErrorShape = { ...refusal };
  return {
    structuredContent: { error: shape },
    content: [
      { type: 'text' as const, text: JSON.stringify({ error: shape }, null, 2) },
    ],
    isError: true,
  };
}

export function toolError(input: unknown) {
  const shape = classifyToolError(input);
  return {
    // Keep the native structured result identical to the text payload so hosts
    // do not need to infer an error category from isError or parse its prose.
    structuredContent: { error: shape },
    content: [
      { type: 'text' as const, text: JSON.stringify({ error: shape }, null, 2) },
    ],
    isError: true,
  };
}
