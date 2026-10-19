import { describeOperationError } from '@ziggs-ai/api-client';

/** Keep the same refusal and callable recovery on every agent runtime. */
export function toolFailureText(err: unknown): string {
  const failure = describeOperationError(err, 'sdk');
  if (failure.recovery || failure.choices) return JSON.stringify(failure);
  const message = failure.code === 'TOOL_ERROR' || failure.message.startsWith(`${failure.code}:`)
    ? failure.message : `${failure.code}: ${failure.message}`;
  return failure.hint ? `${message}\n${failure.hint}` : message;
}
