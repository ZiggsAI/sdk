/**
 * One answer for "what does this envelope's ack list, and may we send it?"
 *
 * The SDK loop and the MCP inbox tool both call this. The bury-guard is the
 * same question on both rails: list every assigned row this reader actually
 * handled, and do not ack a window that is incomplete or that failed in its
 * hands.
 */

export interface InboxAckEnvelope {
  ackTo?: string | null;
  deliveries?: ReadonlyArray<{
    resourceId?: string | null;
    assigneeId?: string | null;
    outOfReach?: unknown;
    /** ISO instant; the axis a mark moves along. */
    ts?: string | null;
    /** Mark covering this row and everything before it in this window. */
    ackTo?: string | null;
  }>;
  openRequestsAwaitingMe?: ReadonlyArray<{
    agreementId?: string | null;
    ts?: string | null;
  }>;
}

export interface InboxAckDecision {
  /** True when this envelope may be acknowledged. */
  allowed: boolean;
  handledResourceIds: string[];
}

export interface PlanInboxAckOptions {
  /**
   * Rows whose `assigneeId` equals this are mine. Empty or omitted: every
   * delivery counts (the MCP tool with no configured self id).
   */
  ownAgentId?: string;
  ownAgentIds?: readonly string[];
  /** Failed handovers hold the watermark unless `forceAck`. */
  failures?: number;
  forceAck?: boolean;
}

function isOutOfReach(note: unknown): boolean {
  if (!note || typeof note !== 'object') return false;
  const n = note as Record<string, unknown>;
  return (
    typeof n.scopeKind === 'string' &&
    typeof n.scopeId === 'string' &&
    typeof n.remedy === 'string'
  );
}

/** Resource ids this envelope's ack must list. */
export function inboxAckHandledIds(
  envelope: InboxAckEnvelope,
  ownAgentId?: string,
  ownAgentIds?: readonly string[],
): string[] {
  const mine = (assigneeId: string | null | undefined) =>
    ownAgentIds ? ownAgentIds.includes(assigneeId ?? '') : !ownAgentId || assigneeId === ownAgentId;
  return [
    ...new Set([
      ...(envelope.deliveries ?? [])
        .filter((d) => mine(d.assigneeId))
        .filter((d) => !isOutOfReach(d.outOfReach))
        .map((d) => d.resourceId),
      ...(envelope.openRequestsAwaitingMe ?? []).map((q) => q.agreementId),
    ]),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Whether an ack is allowed for this envelope, given handover state. */
export function inboxAckAllowed(
  envelope: InboxAckEnvelope,
  opts: PlanInboxAckOptions = {},
): boolean {
  if (!envelope.ackTo) return false;
  const failures = opts.failures ?? 0;
  if (failures > 0 && !opts.forceAck) return false;
  return true;
}

export function planInboxAck(
  envelope: InboxAckEnvelope,
  opts: PlanInboxAckOptions = {},
): InboxAckDecision {
  return {
    allowed: inboxAckAllowed(envelope, opts),
    handledResourceIds: inboxAckHandledIds(envelope, opts.ownAgentId, opts.ownAgentIds),
  };
}

/** How far a reader may ack right now, mid-pass. */
export interface InboxAckStep {
  /** A row's own token — never one the client made up. */
  ackTo: string;
  handledResourceIds: string[];
}

/** Every row whose instant the server's bury-guard will ask about. */
function gatingRows(
  envelope: InboxAckEnvelope,
  ownAgentId?: string,
  ownAgentIds?: readonly string[],
): Array<{ id: string; ts: string }> {
  const mine = (assigneeId: string | null | undefined) =>
    ownAgentIds ? ownAgentIds.includes(assigneeId ?? '') : !ownAgentId || assigneeId === ownAgentId;
  return [
    ...(envelope.deliveries ?? [])
      .filter((d) => mine(d.assigneeId))
      .filter((d) => !isOutOfReach(d.outOfReach))
      .map((d) => ({ id: d.resourceId ?? '', ts: d.ts ?? '' })),
    // Requests are projected out of `deliveries` for triage, but their rows
    // are still in the log under the caller's stamp, so they gate a mark
    // exactly as a delivery does.
    ...(envelope.openRequestsAwaitingMe ?? []).map((q) => ({
      id: q.agreementId ?? '',
      ts: q.ts ?? '',
    })),
  ].filter((r) => r.id.length > 0 && r.ts.length > 0);
}

/**
 * The furthest point in this envelope that is safe to ack RIGHT NOW, given what
 * the reader has finished so far, or null when that is nowhere.
 *
 * Acking once at the end of a pass freezes the watermark for the whole pass,
 * which is long enough for the stand-in's 90s takeover to elapse while the
 * agent is still working. This lets the reader give the mark back in steps.
 *
 * The stopping point is a global instant, NOT the reader's current unit of
 * work. A mark advances every source it names at once, so acking after one
 * chat fold would bury an older row from a different chat — the guard would
 * refuse it, correctly. So: walk the instants the server minted a token for,
 * and stop at the last one where everything at or before it is handled.
 * Anything else is either refused or a bug.
 *
 * Returns null when the server minted no per-row tokens, which is how an older
 * backend is handled: the caller keeps its single end-of-pass ack.
 */
export function planPartialInboxAck(
  envelope: InboxAckEnvelope,
  handled: ReadonlySet<string>,
  opts: PlanInboxAckOptions = {},
): InboxAckStep | null {
  const failures = opts.failures ?? 0;
  if (failures > 0 && !opts.forceAck) return null;

  const tokenByInstant = new Map<string, string>();
  for (const d of envelope.deliveries ?? []) {
    if (d.ts && d.ackTo) tokenByInstant.set(d.ts, d.ackTo);
  }
  if (tokenByInstant.size === 0) return null;

  const gating = gatingRows(envelope, opts.ownAgentId, opts.ownAgentIds);
  // ISO-8601 sorts lexicographically in time order, which is what every other
  // ts comparison on this rail already relies on.
  const instants = [...tokenByInstant.keys()].sort();

  let upTo: string | null = null;
  for (const instant of instants) {
    const settled = gating.every((r) => r.ts > instant || handled.has(r.id));
    if (!settled) break;
    upTo = instant;
  }
  if (!upTo) return null;

  const reached = upTo;
  return {
    ackTo: tokenByInstant.get(reached)!,
    handledResourceIds: [
      ...new Set(gating.filter((r) => r.ts <= reached).map((r) => r.id)),
    ],
  };
}
