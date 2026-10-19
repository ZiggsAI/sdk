/**
 * Which agreement a wake may act under for on-behalf / mandate.
 *
 * A wake binds to the contract where this agent is the **provider**, never to a
 * sub it pays for. Worker-result events name the sub; using that id made the
 * next purchase stamp the operator as payer.
 *
 * Pure: no lineage walk. Candidates the wire already named are kept only when
 * context shows the agent on the provider side (or the row is unknown). A known
 * payer-only row is skipped. Fallback is still "exactly one active provider hire".
 */

import { parseRef } from '@ziggs-ai/api-client';

export type OnBehalfParties = {
  provider?: { actor?: string | null } | null;
  payer?: { actor?: string | null; principal?: string | null } | null;
};

export type OnBehalfAgreementRow = {
  agreementId?: unknown;
  id?: unknown;
  _id?: unknown;
  status?: unknown;
  providerId?: unknown;
  providerAgentId?: unknown;
  executorId?: unknown;
  parties?: OnBehalfParties | null;
};

export type RawOnBehalfEvent = {
  agreementId?: unknown;
  result?: { agreementId?: unknown } | null;
};

function asId(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function rowId(a: OnBehalfAgreementRow): string | undefined {
  return asId(a.agreementId) ?? asId(a.id) ?? asId(a._id);
}

function isTerminalStatus(status: unknown): boolean {
  const s = status != null ? String(status).toLowerCase() : '';
  return s === 'cancelled' || s === 'refunded' || s === 'fulfilled';
}

function isActiveStatus(status: unknown): boolean {
  const s = status != null ? String(status).toLowerCase() : '';
  return s === 'active' || s === 'approved' || s === '';
}

/** Is this agent on the provider side of the row? */
export function agentProvidesOn(
  row: OnBehalfAgreementRow,
  agentId: string,
): boolean {
  const provider = row.parties?.provider;
  const providerIds = [
    provider?.actor,
    row.providerId,
    row.providerAgentId,
    row.executorId,
  ];
  return providerIds.some((x) => x === agentId);
}

/** Is this agent standing on the paying side (actor), not as provider? */
export function agentPaysOn(row: OnBehalfAgreementRow, agentId: string): boolean {
  if (agentProvidesOn(row, agentId)) return false;
  return row.parties?.payer?.actor === agentId;
}

function findRow(
  agreementId: string,
  rows: OnBehalfAgreementRow[],
): OnBehalfAgreementRow | undefined {
  return rows.find((a) => rowId(a) === agreementId);
}

/**
 * May this wire-named agreement be used as on-behalf for `agentId`?
 * - provider on the row → yes
 * - payer-only on the row → no
 * - row missing from context → yes (unknown; do not invent a parent)
 */
export function mayBindOnBehalf(
  agreementId: string,
  agentId: string | null | undefined,
  rows: OnBehalfAgreementRow[],
): boolean {
  if (!agentId) return true;
  const row = findRow(agreementId, rows);
  if (!row) return true;
  if (agentProvidesOn(row, agentId)) return true;
  if (agentPaysOn(row, agentId)) return false;
  return true;
}

function singleActiveProviderHire(
  rows: OnBehalfAgreementRow[],
  agentId: string,
): string | undefined {
  const provides = rows.filter((a) => {
    if (!agentProvidesOn(a, agentId)) return false;
    if (isTerminalStatus(a.status)) return false;
    return isActiveStatus(a.status);
  });
  if (provides.length !== 1) return undefined;
  return rowId(provides[0]);
}

/**
 * Resolve the agreement id this wake should declare for on-behalf / mandate.
 */
export function resolveOnBehalfAgreementId(
  rawEvent: RawOnBehalfEvent | undefined,
  contextAgreements: OnBehalfAgreementRow[] | null | undefined,
  agentId: string | null | undefined,
  sessionId: string | null | undefined,
): string | undefined {
  const rows = Array.isArray(contextAgreements) ? contextAgreements : [];

  const candidates: string[] = [];
  const fromResult = asId(rawEvent?.result?.agreementId);
  if (fromResult) candidates.push(fromResult);
  const fromEvent = asId(rawEvent?.agreementId);
  if (fromEvent && fromEvent !== fromResult) candidates.push(fromEvent);
  if (typeof sessionId === 'string' && parseRef(sessionId)?.kind === 'agreement') {
    if (!candidates.includes(sessionId)) candidates.push(sessionId);
  }

  for (const id of candidates) {
    if (!agentId || mayBindOnBehalf(id, agentId, rows)) return id;
  }

  if (agentId) return singleActiveProviderHire(rows, agentId);
  return undefined;
}
