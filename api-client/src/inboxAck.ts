/** Observation and handling are independent. Only explicit responsibility IDs settle work. */
export interface InboxAckEnvelope {
  ackTo?: string | null;
  deliveries?: ReadonlyArray<{ resourceId?: string | null; responsibilityId?: string | null; assigneeId?: string | null; outOfReach?: unknown; executionBlocked?: unknown; ts?: string | null; ackTo?: string | null }>;
  openRequestsAwaitingMe?: ReadonlyArray<{ agreementId?: string | null; responsibilityId?: string | null; ts?: string | null }>;
}
export interface PlanInboxAckOptions { ownAgentId?: string; ownAgentIds?: readonly string[]; failures?: number; forceAck?: boolean; }
export interface InboxAckDecision { allowed: boolean; handledDeliveryIds: string[]; }
export interface InboxAckStep { ackTo: string; handledDeliveryIds: string[]; }
export function inboxAckHandledIds(envelope: InboxAckEnvelope, ownAgentId?: string, ownAgentIds?: readonly string[]): string[] {
  const mine = (id: string | null | undefined) => ownAgentIds ? ownAgentIds.includes(id ?? '') : ownAgentId ? id === ownAgentId : !!id;
  return [...new Set([
    ...(envelope.deliveries ?? []).filter(d => mine(d.assigneeId) && !d.outOfReach && !d.executionBlocked).map(d => d.responsibilityId),
    ...(envelope.openRequestsAwaitingMe ?? []).map(r => r.responsibilityId),
  ].filter((id): id is string => !!id))];
}
export function inboxAckAllowed(envelope: InboxAckEnvelope, opts: PlanInboxAckOptions = {}): boolean {
  return !!envelope.ackTo && (!(opts.failures ?? 0) || !!opts.forceAck);
}
/** Full-pass helper: only use after every listed responsibility succeeded. */
export function planInboxAck(envelope: InboxAckEnvelope, opts: PlanInboxAckOptions = {}): InboxAckDecision {
  return { allowed: inboxAckAllowed(envelope, opts), handledDeliveryIds: inboxAckHandledIds(envelope, opts.ownAgentId, opts.ownAgentIds) };
}
/** Successful jobs can be handled in any order, even when another job failed. */
export function planPartialInboxAck(envelope: InboxAckEnvelope, handled: ReadonlySet<string>, opts: PlanInboxAckOptions = {}): InboxAckStep | null {
  if (!envelope.ackTo) return null;
  const ids = inboxAckHandledIds(envelope, opts.ownAgentId, opts.ownAgentIds).filter(id => handled.has(id));
  return ids.length ? { ackTo: envelope.ackTo, handledDeliveryIds: ids } : null;
}
