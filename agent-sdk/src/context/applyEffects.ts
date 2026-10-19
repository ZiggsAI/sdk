import { isProtocolToolName, mapProtocolToolToOperation } from '../tasks/protocolRegistry.js';

function applyTaskOperationResultToContext(updates: Record<string, unknown>, operation: string | null, result: Record<string, unknown>): void {
  const r = result || {};
  const agreement = (r['agreement'] as Record<string, unknown>) ||
    (r['agreementId'] ? r : null);
  const task = (r['task'] as Record<string, unknown>) || (r['taskId'] ? r : null);

  if (operation === 'agreement-propose' || operation === 'agreement-subcontract') {
    // Agreement creation no longer spawns a task. The caller has made a
    // proposal that the proposedTo party still needs to approve.
    if (agreement) updates['proposal'] = r;
  }
  if (operation === 'task-spawn') {
    if (task) {
      updates['delegatedTask'] = r;
      if (task['taskId']) {
        if (!updates['_delegatedTaskIds']) updates['_delegatedTaskIds'] = [];
        (updates['_delegatedTaskIds'] as string[]).push(task['taskId'] as string);
      }
    }
  }
  if (operation === 'task-update') {
    // `state` only cut `status` from the wire.
    const state = (task?.['state'] || r['state']) as string | undefined;
    if (state === 'completed') updates['taskCompleted'] = true;
    if (state === 'failed') updates['taskFailed'] = true;
  }
  if (operation === 'agreement-respond') updates['respondedProposal'] = r;
}

export const CONTEXT_RESET: Record<string, unknown> = Object.freeze({
  messageSent: false, activeWait: false, proposal: null, taskCompleted: false,
  taskFailed: false, subtaskResult: null, subtaskFailed: false, toolResults: null,
  lastError: null, lastAction: null, lastActionResult: null, approval: false,
  rejection: false, taskAssignment: null, incomingMessage: false,
  respondedProposal: null, searchCompleted: false, boardResults: null, taskPublished: false,
});

export function buildContextUpdates(actionName: string, emittedEvents: unknown[]): Record<string, unknown> {
  const updates: Record<string, unknown> = { ...CONTEXT_RESET, lastAction: actionName };
  if (!Array.isArray(emittedEvents)) return updates;
  const toolResults: unknown[] = [];

  for (const ev of emittedEvents) {
    if (!ev || typeof ev !== 'object') continue;
    const events = Array.isArray(ev) ? ev : [ev];
    for (const e of events) {
      const event = e as Record<string, unknown>;
      switch (event['type']) {
        case 'tool_result':
          toolResults.push({ tool: event['tool'], result: event['result'] });
          updates['lastActionResult'] = event;
          if (isProtocolToolName(event['tool'] as string)) {
            applyTaskOperationResultToContext(updates, mapProtocolToolToOperation(event['tool'] as string), (event['result'] as Record<string, unknown>) || {});
          }
          break;
        case 'tool_error':
          toolResults.push({ tool: event['tool'], error: event['error'] });
          updates['lastActionResult'] = event;
          updates['lastError'] = event['error'];
          break;
        case 'message_sent':
          updates['messageSent'] = true; updates['lastActionResult'] = event; break;
        case 'message_duplicate_skipped':
          updates['messageSent'] = true; break;
        case 'waited':
          updates['activeWait'] = true; break;
        case 'task_result': {
          updates['lastActionResult'] = event;
          applyTaskOperationResultToContext(updates, (event['operation'] as string) || null, (event['result'] as Record<string, unknown>) || {});
          break;
        }
        case 'task_error':
          updates['lastError'] = event['error']; updates['lastActionResult'] = event; break;
      }
    }
  }
  if (toolResults.length > 0) updates['toolResults'] = toolResults;
  return updates;
}
