/** A failed required read is retryable work, never a successfully handled wake. */
export class RequiredContextUnavailable extends Error {
  readonly code = 'REQUIRED_CONTEXT_UNAVAILABLE';
  /**
   * The server refused an agreement-only wake outright (403/404): this agent is
   * not on that agreement, e.g. the consent record of its own access request.
   * Redelivery cannot change that, and each retry spends a wake, so the inbox
   * settles it instead of holding the ack. A later grant arrives as its own event.
   */
  readonly settled: boolean;
  constructor(opts: { settled?: boolean } = {}) {
    super('Required context is unavailable. Leave the responsibility pending until access or the read recovers.');
    this.name = 'RequiredContextUnavailable';
    this.settled = opts.settled === true;
  }
}

export function assertRequiredContext(snapshot: unknown): void {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const root = record(snapshot);
  const unavailable = (work: unknown): boolean => {
    const packet = record(work);
    return packet.unavailable === true
      || (Array.isArray(packet.contexts) && packet.contexts.some(unavailable));
  };
  // minimumComplete=false can mean paginated/truncated input awaiting expansion.
  // authorization.active=false can be a readable proposal awaiting a decision.
  // Those packets still support recovery; operation/task policy gates new work.
  if (snapshot == null || root.unavailable === true || unavailable(root.work)) {
    const settled = root.refused === true
      && typeof root.refusedVia === 'string' && root.refusedVia.startsWith('agreement:');
    throw new RequiredContextUnavailable({ settled });
  }
}
