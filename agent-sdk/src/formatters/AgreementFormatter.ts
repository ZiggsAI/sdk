import { partySideIds, type AgreementPartySide } from '@ziggs-ai/api-client';

interface AgreementFormatterOptions {
  shortIds?: boolean;
  indentSize?: number;
}

type AnyObj = Record<string, unknown>;

export class AgreementFormatter {
  private shortIds: boolean;
  private indentSize: number;

  constructor(options: AgreementFormatterOptions = {}) {
    this.shortIds = options.shortIds ?? false;
    this.indentSize = options.indentSize ?? 2;
  }

  format(agreements: AnyObj[] | null | undefined): string {
    if (!agreements?.length) return 'No active agreements.';
    const pending = agreements.filter(a => (a['proposal'] as AnyObj | undefined)?.['status'] === 'pending' && a['proposedToIsYou']);
    const standing = agreements.filter(a => !a['task']);
    const active = agreements.filter(a => a['task'] && !((a['proposal'] as AnyObj | undefined)?.['status'] === 'pending' && a['proposedToIsYou']));
    const sections: string[] = [];
    if (pending.length > 0) { sections.push('Pending Proposals (awaiting your response):'); for (const ag of pending) sections.push(this.formatAgreement(ag, this._indent(1))); }
    if (active.length > 0) { if (sections.length > 0) sections.push(''); sections.push('Active Agreements:'); for (const ag of active) sections.push(this.formatAgreement(ag, this._indent(1))); }
    if (standing.length > 0) { if (sections.length > 0) sections.push(''); sections.push('Standing Agreements (no execution running):'); for (const ag of standing) sections.push(this.formatAgreement(ag, this._indent(1))); }
    return sections.join('\n');
  }

  formatAgreement(ag: AnyObj, indent = ''): string {
    const status = ((ag['status'] as string) || 'unknown').toUpperCase();
    const agId = this.shortId(ag['agreementId'] as string);
    const parties = (ag['parties'] as AnyObj) || {};
    const side = (name: string): AgreementPartySide | undefined =>
      parties[name] as AgreementPartySide | undefined;
    const lines = [
      `${indent}[${status}] Agreement ${agId}`,
      `${indent}  Creator: ${this._labelParty(side('creator'), ag['creatorIsYou'] as boolean)}`,
      `${indent}  Provider: ${this._labelParty(side('provider'), ag['providerIsYou'] as boolean)}`,
      `${indent}  Payer: ${this._labelParty(side('payer'), ag['payerIsYou'] as boolean)}`,
    ];
    if (partySideIds(side('proposedTo')).length > 0) {
      lines.push(`${indent}  Proposed to: ${this._labelParty(side('proposedTo'), ag['proposedToIsYou'] as boolean)}`);
    }
    const proposal = ag['proposal'] as AnyObj | undefined;
    if (proposal?.['status']) lines.push(`${indent}  Proposal: ${proposal['status']}${proposal['respondedBy'] ? ` (by ${proposal['respondedBy']})` : ''}`);
    const money = ag['money'] as AnyObj | undefined;
    if (typeof money?.['price'] === 'number' && (money['price'] as number) > 0) {
      const parts = [`${money['price']} hundredths of a point`];
      if (money['paymentStatus'] && money['paymentStatus'] !== 'none') parts.push(money['paymentStatus'] as string);
      lines.push(`${indent}  Money: ${parts.join(', ')}`);
    }
    const terms = ag['terms'] as AnyObj | undefined;
    if (terms) {
      const tparts: string[] = [];
      if (terms['lifecycle'] && terms['lifecycle'] !== 'open') tparts.push(`lifecycle: ${terms['lifecycle']}`);
      if (terms['maxExecutions'] != null) tparts.push(`maxExecutions: ${terms['maxExecutions']}`);
      if (terms['expiresAt']) tparts.push(`expiresAt: ${terms['expiresAt']}`);
      if (terms['description']) tparts.push(`"${terms['description']}"`);
      if (tparts.length > 0) lines.push(`${indent}  Terms: ${tparts.join(', ')}`);
    }
    if (ag['task']) { lines.push(''); lines.push(`${indent}  Execution:`); lines.push(this._renderTaskExecution(ag['task'] as AnyObj, indent + '    ')); }
    else lines.push(`${indent}  Execution: (none yet)`);
    return lines.join('\n');
  }

  _renderTaskExecution(task: AnyObj, indent = ''): string {
    const state = ((task['state'] as string) || 'unknown').toUpperCase();
    const id = this.shortId(task['taskId'] as string);
    const lines = [`${indent}[${state}] ${task['description'] || 'No description'}`, `${indent}  Task ID: ${id}`];
    if (task['parentTaskId']) lines.push(`${indent}  Parent task: ${task['parentTaskId']}`);
    if (task['result'] && (task['state'] === 'completed' || task['state'] === 'failed')) {
      const r = String(task['result']);
      lines.push(`${indent}  Result: ${r.length > 100 ? r.slice(0, 100) + '...' : r}`);
    }
    const plan = task['plan'] as AnyObj | undefined;
    const steps = plan?.['steps'] as AnyObj[] | undefined;
    if (steps?.length) {
      const sorted = [...steps].sort((a, b) => (a['order'] as number) - (b['order'] as number));
      const done = sorted.filter(s => s['status'] === 'completed').length;
      lines.push(`${indent}  Plan (${done}/${sorted.length} done):`);
      for (const step of sorted) {
        const icon = ({ pending: '○', in_progress: '●', completed: '✓', skipped: '–' } as Record<string, string>)[step['status'] as string] || '?';
        const note = step['status'] === 'completed' && step['result'] ? ` → ${String(step['result']).slice(0, 60)}${String(step['result']).length > 60 ? '...' : ''}` : '';
        lines.push(`${indent}    ${step['order']}. [${icon}] ${step['description'] || step['stepId']}${note}`);
      }
    }
    const subtasks = task['subtasks'] as AnyObj[] | undefined;
    if (subtasks?.length) {
      lines.push(`${indent}  Subtasks (${subtasks.length}):`);
      for (const st of subtasks) {
        const sstate = ((st['state'] as string) || 'unknown').toUpperCase();
        const sid = this.shortId(st['taskId'] as string);
        lines.push(`${indent}    [${sstate}] ${st['description'] || sid} (${sid}, provider: ${st['providerIsYou'] ? 'You' : (st['provider'] ?? 'unassigned')})`);
      }
    }
    return lines.join('\n');
  }

  /**
   * A side names up to two ids — the accountable principal and the agent that
   * acted for it. Both are rendered: the agent has to recognize itself here,
   * and the principal is who the deal is actually with.
   */
  _labelParty(side: AgreementPartySide | null | undefined, isYou: boolean | undefined): string {
    const shown = partySideIds(side).join(' via ');
    if (!shown) return 'N/A';
    return isYou ? `You (${shown})` : shown;
  }

  shortId(id: string | null | undefined): string {
    if (!id) return '?';
    if (!this.shortIds) return id;
    return id.length > 20 ? id.slice(0, 20) + '...' : id;
  }

  private _indent(level: number): string {
    return ' '.repeat(level * this.indentSize);
  }
}

export const agreementFormatter = new AgreementFormatter();
