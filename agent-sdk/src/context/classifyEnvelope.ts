import { CONTEXT_RESET } from './applyEffects.js';
import { getBatchEvents, isTaskResultRelevantToAgent, partiesOf } from './batch.js';

function isTaskAssignment(result: Record<string, unknown>, ownAgentId: string | null): boolean {
  const isProvider = result['providerIsYou'] || partiesOf(result)?.provider?.actor === ownAgentId;
  return !!(isProvider && (result['state'] === 'active' || result['state'] === 'in-progress'));
}

export function classifyIncomingEvent(rawEvent: unknown, ownAgentId: string | null): Record<string, unknown> {
  const flags: Record<string, unknown> = { ...CONTEXT_RESET };
  if (!rawEvent) return flags;

  for (const ev of getBatchEvents(rawEvent)) {
    if (!ev) continue;
    const e = ev as Record<string, unknown>;
    if (e['type'] !== 'task_result') { flags['incomingMessage'] = true; continue; }

    const result = (e['result'] as Record<string, unknown>) || {};
    if (ownAgentId && !isTaskResultRelevantToAgent(result, ownAgentId) && e['receiverId'] !== ownAgentId) continue;

    const state = result['state'] as string | undefined;
    const ag = result['agreement'] as Record<string, unknown> | undefined;
    const parties = partiesOf(result);
    const proposalStatus = (ag?.['proposal'] as Record<string, unknown> | undefined)?.['status'];

    if (state === 'active' && proposalStatus === 'approved' && ownAgentId && parties?.creator?.actor === ownAgentId) {
      flags['approval'] = true; flags['taskAssignment'] = result; continue;
    }
    if (isTaskAssignment(result, ownAgentId)) { flags['taskAssignment'] = result; flags['approval'] = true; continue; }
    if (proposalStatus === 'approved' || (state === 'active' && proposalStatus === 'pending')) { flags['approval'] = true; flags['taskAssignment'] = result; continue; }
    if (proposalStatus === 'rejected' || state === 'cancelled') { flags['rejection'] = true; continue; }
    if (state === 'completed') { flags['subtaskResult'] = result; continue; }
    if (state === 'failed') { flags['subtaskResult'] = result; flags['subtaskFailed'] = true; continue; }
    flags['subtaskResult'] = result;
  }
  return flags;
}
