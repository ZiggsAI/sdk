import type { ActionRef, WorkExecutionContext } from '@ziggs-ai/contracts';
import { getBackendUrl } from '../utils/urlUtils.js';
import { buildOperatorHeaders, withWorkExecution, withoutExecution } from './operatorHeaders.js';
import { throwApiError } from '../shared/apiError.js';

/** Fail closed before resuming model state, including timers and recorded wakes. */
export async function validateWorkExecution(context: WorkExecutionContext, operatorKey: string, baseUrl = getBackendUrl()): Promise<void> {
  await withWorkExecution(context, async () => {
    const response = await fetch(`${baseUrl}/execution/context`, {
      headers: buildOperatorHeaders(operatorKey, context.actorId),
    });
    const text = await response.text();
    if (!response.ok) throwApiError(response, text, 'Execution context is no longer valid');
    const body = JSON.parse(text) as WorkExecutionContext;
    if (body.contextId !== context.contextId) throw new Error('Execution preflight returned a different context');
  });
}

/** Explicit admission, outside an existing execution. Never retries a refused context. */
export async function prepareWorkExecution(action: ActionRef, operatorKey: string, agentId: string, baseUrl = getBackendUrl()): Promise<WorkExecutionContext> {
  const response = await fetch(`${baseUrl}/execution/prepare`, {
    method: 'POST', headers: { ...buildOperatorHeaders(operatorKey, agentId), 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
  const text = await response.text();
  if (!response.ok) throwApiError(response, text, 'Action execution is unavailable');
  const context = JSON.parse(text) as WorkExecutionContext;
  if (!context.contextId || context.actorId !== agentId) throw new Error('Invalid action execution response');
  return context;
}

/** The host holds a fenced lease while it runs; release is not domain completion. */
export async function runWorkExecution<T>(context: WorkExecutionContext, operatorKey: string, run: (context: WorkExecutionContext) => Promise<T>, baseUrl = getBackendUrl()): Promise<T> {
  const call = async (body: Record<string, unknown>, selected = context): Promise<unknown> => withWorkExecution(selected, async () => {
    const finish = body.operation === 'finish';
    const headers = buildOperatorHeaders(operatorKey, context.actorId);
    const response = await fetch(`${baseUrl}/execution/attempt`, { method: 'POST',
      headers: { ...(finish ? withoutExecution(headers) : headers), 'content-type': 'application/json' },
      body: JSON.stringify(finish ? { ...body, contextId: selected.contextId, attemptId: selected.attemptId } : body) });
    const text = await response.text();
    if (!response.ok) throwApiError(response, text, 'Execution attempt refused');
    return JSON.parse(text);
  });
  const attempt = await call({ operation: 'claim' }) as WorkExecutionContext;
  if (attempt.contextId !== context.contextId || !attempt.attemptId) throw new Error('Invalid execution attempt response');
  let lost: unknown;
  const timer = setInterval(() => { void call({ operation: 'renew' }, attempt).catch(error => { lost = error; }); }, 20_000);
  timer.unref();
  try {
    const result = await withWorkExecution(attempt, () => run(attempt));
    if (lost) throw lost;
    return result;
  } finally {
    clearInterval(timer);
    // A stale worker never releases its replacement. Failure here keeps durable
    // inputs pending; it must not transform an execution refusal into a retry
    // without its selected authority.
    await call({ operation: 'finish' }, attempt);
  }
}
