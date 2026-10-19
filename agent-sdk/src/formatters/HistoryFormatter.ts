import { isOpaquePresentationRef } from '@ziggs-ai/api-client';
import { partySideIds, type AgreementPartySide } from '@ziggs-ai/api-client';

type AnyObj = Record<string, unknown>;

interface HistoryFormatterOptions {
  showTimestamps?: boolean;
  shortIds?: boolean;
}

export class HistoryFormatter {
  private showTimestamps: boolean;
  private shortIds: boolean;

  constructor(options: HistoryFormatterOptions = {}) {
    this.showTimestamps = options.showTimestamps ?? true;
    this.shortIds = options.shortIds ?? false;
  }

  format(history: AnyObj[] | null | undefined, agentId: string, options: { mode?: string } = {}): string {
    if (!history?.length) return 'No previous activity.';
    const labelTypes = options.mode === 'mission';
    const sorted = [...history].sort((a, b) => {
      const tA = a['timestamp'] ? new Date(a['timestamp'] as string).getTime() : 0;
      const tB = b['timestamp'] ? new Date(b['timestamp'] as string).getTime() : 0;
      return tA - tB;
    });
    return sorted.map(entry => this.formatEntry(entry, agentId, labelTypes)).join('\n');
  }

  formatEntry(entry: AnyObj, agentId: string, labelTypes = false): string {
    const timestamp = this.showTimestamps ? this.formatTime(entry['timestamp'] as string | undefined) : '';
    const timePrefix = timestamp ? `[${timestamp}] ` : '';
    const entryType = entry['entryType'] as string | undefined;

    if (entryType === 'message' || !entryType) {
      const label = labelTypes ? '[CHAT] ' : '';
      return `${label}${this.formatMessage(entry, agentId, timePrefix)}`;
    }
    // notices are not counterparty turns — no "from → to:" speech framing.
    if (entryType === 'notification') {
      const label = labelTypes ? '[NOTICE] ' : '';
      return `${label}${timePrefix}[notice] ${entry['text'] || ''}`;
    }
    if (entryType === 'task_history') {
      const label = labelTypes ? '[TASK] ' : '';
      return `${label}${this.formatTaskHistory(entry, agentId, timePrefix)}`;
    }
    if (entryType === 'artifact') {
      const line = this.formatArtifact(entry, agentId, timePrefix);
      if (labelTypes) {
        if (entry['contentType'] === 'thought') return `[THOUGHT] ${line}`;
        const text = (entry['text'] as string) || '';
        const json = text.replace(/^operation_(?:started|completed|error):/, '');
        const data = json ? this.safeParseJSON(json) : null;
        const label = (data?.['type'] === 'tool' || text.includes('operation_error')) ? '[TOOL] ' : '[TASK] ';
        return `${label}${line}`;
      }
      return line;
    }
    return `${timePrefix}${entry['text'] || 'Unknown entry'}`;
  }

  formatMessage(entry: AnyObj, agentId: string, timePrefix: string): string {
    const from = this.formatParticipant(entry['sender'] as AnyObj | undefined, agentId);
    const to = entry['receiver'] ? ` → ${this.formatParticipant(entry['receiver'] as AnyObj, agentId)}` : '';
    return `${timePrefix}${from}${to}: ${entry['text'] || ''}`;
  }

  formatTaskHistory(entry: AnyObj, agentId: string, timePrefix: string): string {
    const service = entry['service'] as AnyObj | undefined;
    const task = service?.['task'] as AnyObj | undefined;
    if (!task) return `${timePrefix}Update`;
    const changeType = service?.['changeType'] as string | undefined;
    const taskId = this.shortId(task['taskId'] as string);
    const agreementId = task['agreementId'] ? this.shortId(task['agreementId'] as string) : null;
    const desc = (task['description'] as string) || 'No description';
    const ids = agreementId ? `agreement=${agreementId} task=${taskId}` : `task=${taskId}`;
    switch (changeType) {
      case 'created': {
        const ag = task['agreement'] as AnyObj | undefined;
        const parties = (ag?.['parties'] as AnyObj) || {};
        const proposedTo = partySideIds(parties['proposedTo'] as AgreementPartySide | undefined).join(' via ');
        return `${timePrefix}Task created under agreement: "${desc}" (${ids})\n    Owner: ${this.formatOwner(task, agentId)}\n    Executor: ${this.formatExecutor(task, agentId)}\n    Proposed to: ${proposedTo || 'N/A'}`;
      }
      case 'state_changed': {
        const prev = (service?.['previousState'] as AnyObj | undefined)?.['state'] || '?';
        const next = (service?.['newState'] as AnyObj | undefined)?.['state'] || '?';
        return `${timePrefix}Task "${desc}" (${ids}): ${prev} → ${next}`;
      }
      case 'proposal_responded': {
        const action = (service?.['metadata'] as AnyObj | undefined)?.['action'] as string | undefined;
        return `${timePrefix}Proposal ${action ?? 'responded'} for "${desc}" (${ids})`;
      }
      case 'processing_changed': {
        const processing = (service?.['newState'] as AnyObj | undefined)?.['processing'];
        return `${timePrefix}Task "${desc}" (${ids}): processing ${processing ? 'started' : 'stopped'}`;
      }
      default:
        return `${timePrefix}${changeType}: "${desc}" (${ids})`;
    }
  }

  formatArtifact(entry: AnyObj, _agentId: string, timePrefix: string): string {
    const text = (entry['text'] as string) || '';
    if (entry['contentType'] === 'thought') return `${timePrefix}Thought: ${text}`;
    if (text.startsWith('operation_started:')) {
      const data = this.safeParseJSON(text.replace('operation_started:', ''));
      if (data?.['type'] === 'tool') return `${timePrefix}Tool starting: ${data['tool']}(${this.formatArgs(data['args'] as AnyObj)})`;
      if (data?.['type'] === 'task') return `${timePrefix}Task operation: ${data['operation']}`;
      return `${timePrefix}Operation started: ${data?.['type'] || 'unknown'}`;
    }
    if (text.startsWith('operation_completed:')) {
      const data = this.safeParseJSON(text.replace('operation_completed:', ''));
      if (data?.['type'] === 'tool') return `${timePrefix}Tool completed: ${data['tool']}`;
      if (data?.['type'] === 'task') return `${timePrefix}Task operation completed: ${data['operation']}`;
      return `${timePrefix}Operation completed: ${data?.['type'] || 'unknown'}`;
    }
    if (text.startsWith('operation_error:')) {
      const data = this.safeParseJSON(text.replace('operation_error:', ''));
      return `${timePrefix}ERROR: ${data?.['error'] || 'Unknown error'}`;
    }
    return `${timePrefix}${text}`;
  }

  formatParticipant(participant: AnyObj | null | undefined, agentId: string): string {
    if (!participant) return 'unknown';
    // Message.sender is stored as {agentId, underAgreementId} (no `id`, no
    // `type`) while Message.receiver is {id, type} — two different shapes on
    // the same document (see backend Message schema). Without this fallback,
    // every sender renders as "unknown (unknown)" and self-sent history rows
    // never match `id === agentId`, so the agent can't recognize its own
    // past messages in <history>.
    const id = (participant['id'] as string) || (participant['agentId'] as string) || 'unknown';
    if (participant['type'] === 'system') return 'System';
    if (id === agentId) return 'You';
    // prefer presentation face when the wire masks the principal.
    const presentation = participant['presentation'] as AnyObj | undefined;
    const faceName =
      (typeof presentation?.['name'] === 'string' && presentation['name']) ||
      (typeof (presentation?.['persona'] as AnyObj | undefined)?.['name'] === 'string'
        ? ((presentation!['persona'] as AnyObj)['name'] as string)
        : null);
    if (faceName) return `${faceName} (${id})`;
    if (isOpaquePresentationRef(id)) {
      return `${id} (presentation)`;
    }
    return `${id} (${participant['type'] || 'unknown'})`;
  }

  formatOwner(task: AnyObj, agentId: string): string {
    return this._formatSide(task, 'creator', task['agentId'], agentId);
  }

  formatExecutor(task: AnyObj, agentId: string): string {
    return this._formatSide(task, 'provider', task['executorId'], agentId);
  }

  /**
   * One side of the task's agreement, or `fallback` when the frame carries no
   * parties — a bare resource_changed skeleton has the task ids and nothing else.
   */
  private _formatSide(task: AnyObj, role: string, fallback: unknown, agentId: string): string {
    const parties = (task['agreement'] as AnyObj | undefined)?.['parties'] as AnyObj | undefined;
    const ids = partySideIds(parties?.[role] as AgreementPartySide | undefined);
    if (ids.length === 0) return fallback === agentId ? 'You' : String(fallback ?? 'N/A');
    return ids.includes(agentId) ? 'You' : ids.join(' via ');
  }

  shortId(id: string | null | undefined): string {
    if (!id) return '?';
    if (!this.shortIds) return id;
    const parts = id.split('_');
    if (parts.length >= 3) return `task_...${parts[parts.length - 1]}`;
    return id.length > 20 ? id.slice(0, 20) + '...' : id;
  }

  formatTime(timestamp: string | null | undefined): string {
    if (!timestamp) return '??:??';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '??:??';
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' });
  }

  formatArgs(args: AnyObj | null | undefined): string {
    if (!args || typeof args !== 'object') return '';
    const entries = Object.entries(args);
    if (entries.length === 0) return '';
    if (entries.length <= 3) return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
    return JSON.stringify(args);
  }

  private safeParseJSON(str: string): AnyObj | null {
    try { return JSON.parse(str) as AnyObj; }
    catch { return null; }
  }
}

export const historyFormatter = new HistoryFormatter();
