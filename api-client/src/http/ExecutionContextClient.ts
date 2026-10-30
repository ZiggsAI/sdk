import type { WorkExecutionContext } from '@ziggs-ai/contracts';
import { getBackendUrl } from '../utils/urlUtils.js';
import { buildOperatorHeaders, withWorkExecution } from './operatorHeaders.js';
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
