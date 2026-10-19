type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {};

/**
 * A seller's standing offer: open to everyone (`everyone`) or one
 * company (`org`). A listing is never work: claiming it gives each claimer
 * their own hire, so nothing is done or spent under the listing itself. Reads
 * both party shapes: an agreement row (`{ principal }`) and a room snapshot
 * row (the principal as a string).
 */
export function isListing(agreement: unknown): boolean {
  const a = row(agreement);
  const payer = row(a.parties).payer;
  const principal = typeof payer === 'string' ? payer : row(payer).principal;
  return (principal === 'everyone' || principal === 'org') && a.engagementKind !== 'link';
}

/** Enrich each wake from the agreement it actually names, never from the room's
 * latest deal. Reads use the agent's credentials; no grants are inferred here. */
export async function withAgreementContext(
  event: unknown,
  read: (agreementId: string) => Promise<unknown>,
): Promise<unknown> {
  const reads = new Map<string, Promise<Row>>();
  const context = (id: string): Promise<Row> => {
    if (!reads.has(id)) reads.set(id, (async () => {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const agreement = row(await Promise.race([
          read(id),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Agreement read timed out')), 5_000);
          }),
        ]).finally(() => { if (timer) clearTimeout(timer); }));
        if (agreement.agreementId !== id) throw new Error('Agreement is unavailable');
        const terms = row(agreement.terms);
        const usage = row(agreement.conversationUsage);
        const money = row(agreement.money);
        if (isListing(agreement)) {
          return {
            agreementId: id, available: true, listing: true, relationship: true,
            status: agreement.status,
            scope: terms.description,
            instruction: 'This is a store listing, not work: a stranger talks with you under it, and hires you by claiming it. Answer as conversation; nothing you do is spent under it.',
          };
        }
        const limit = typeof terms.conversationAllowance === 'number' ? terms.conversationAllowance : null;
        const used = typeof usage.messages === 'number' ? usage.messages : 0;
        return {
          agreementId: id, available: true,
          status: agreement.status,
          relationship: agreement.engagementKind === 'link',
          interactionMode: terms.interactionMode ?? 'both',
          parentAgreementId: agreement.parentAgreementId ?? null,
          allowanceScope: terms.conversationAllowanceScope ?? 'direct',
          scope: terms.description,
          lifecycle: terms.lifecycle,
          expiresAt: terms.expiresAt ?? null,
          maxTasks: terms.maxExecutions ?? null,
          wakeCeiling: terms.wakeCeiling ?? null,
          messageLimit: limit,
          messagesUsed: used,
          messagesRemaining: limit === null ? null : Math.max(0, limit - used),
          price: money.price ?? 0,
          billing: terms.billing ?? 'total',
          paymentStatus: money.paymentStatus,
          access: 'Tool and resource access requires separate grants.',
        };
      } catch {
        return { agreementId: id, available: false,
          instruction: 'Agreement terms could not be read. Verify authorization before starting new service work or making commitments.' };
      }
    })());
    return reads.get(id)!;
  };
  const enrich = async (value: unknown): Promise<unknown> => {
    const frame = row(value);
    if (frame.type === 'batch' && Array.isArray(frame.events)) {
      return { ...frame, events: await Promise.all(frame.events.map(enrich)) };
    }
    const resource = row(frame.resource);
    const result = row(frame.result);
    const id = frame.agreementId ?? resource.agreementId ?? result.agreementId ?? row(result.agreement).agreementId;
    if (typeof id !== 'string' || !id) return value;
    return { ...frame, agreementContext: await context(id) };
  };
  return enrich(event);
}


/** A link or a listing supplies conversation context, never consent to another engagement. */
export function permitsAutomaticMandate(event: unknown): boolean {
  const frame = row(event);
  if (frame.type === 'batch' && Array.isArray(frame.events)) return frame.events.every(permitsAutomaticMandate);
  const context = row(frame.agreementContext);
  return context.relationship !== true && context.available !== false;
}
