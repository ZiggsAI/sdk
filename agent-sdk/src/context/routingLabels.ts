import { isProtocolToolName } from '../tasks/protocolRegistry.js';
import { getBatchEvents, isTaskResultRelevantToAgent, partiesOf } from './batch.js';

export function unwrapBatchEvent(event: unknown): unknown {
  const e = event as Record<string, unknown> | null | undefined;
  if (e?.['type'] === 'batch' && Array.isArray(e['events']) && e['events'][0]) return e['events'][0];
  return event;
}

export function classifyWorkflowEvent(event: unknown, ownAgentId: string | null = null): string {
  const events = getBatchEvents(event);
  if (events.length === 0) return 'message';

  let sawTaskResult = false, sawOwnTaskResult = false;

  for (const ev of events) {
    const e = ev as Record<string, unknown> | null | undefined;
    if (e?.['type'] !== 'task_result') continue;
    sawTaskResult = true;
    const result = (e['result'] as Record<string, unknown>) || {};
    if (!isTaskResultRelevantToAgent(result, ownAgentId)) continue;
    sawOwnTaskResult = true;
    const state = result['state'] as string | undefined;
    const ag = result['agreement'] as Record<string, unknown> | undefined;
    const proposalStatus = ag?.['proposal'] ? (ag['proposal'] as Record<string, unknown>)['status'] : undefined;
    const isProvider = result['providerIsYou'] || partiesOf(result)?.provider?.actor === ownAgentId;
    if (isProvider && (state === 'active' || state === 'in-progress')) return 'task_assignment';
    if (proposalStatus === 'approved' || (state === 'active' && proposalStatus === 'pending')) return 'task_approved';
    if (proposalStatus === 'rejected' || state === 'cancelled') return 'task_rejected';
  }
  if (sawOwnTaskResult || sawTaskResult) return 'task_set_result';
  return 'message';
}

export function findTaskResult(output: Record<string, unknown> | null | undefined): unknown {
  const events = (output?.['emittedEvents'] as unknown[]) ?? [];
  return events.find(e => {
    const ev = e as Record<string, unknown>;
    return ev['type'] === 'task_result' || (ev['type'] === 'tool_result' && isProtocolToolName(ev['tool'] as string));
  }) ?? null;
}

export function findIncomingTaskResult(incomingEvent: unknown): unknown {
  return getBatchEvents(incomingEvent).find(e => (e as Record<string, unknown>)?.['type'] === 'task_result') ?? null;
}
