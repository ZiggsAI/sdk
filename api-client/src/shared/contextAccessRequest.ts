/** The common marker carried by access-request approvals and notifications. */
export interface ContextAccessRequest {
  primitive: 'context';
  kind: 'access-request';
  holderId?: string;
  scope?: { kind?: string; id?: string };
  resumeAgreementId?: string;
}
export function isContextAccessRequest(value: unknown): value is ContextAccessRequest {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.primitive === 'context' && row.kind === 'access-request';
}
