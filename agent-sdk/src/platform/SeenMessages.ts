/**
 * Dedupes delivery across push (WS flush) and pull (inbox catch-up).
 * inbox is reconciliation source; stable message ids
 * prevent double-processing when both paths fire for the same row.
 */
export class SeenMessages {
  private readonly order: string[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly maxSize = 5_000) {}

  has(messageId: string | null | undefined): boolean {
    if (!messageId || typeof messageId !== 'string') return false;
    return this.seen.has(messageId);
  }

  mark(messageId: string | null | undefined): void {
    if (!messageId || typeof messageId !== 'string') return;
    if (this.seen.has(messageId)) return;
    this.seen.add(messageId);
    this.order.push(messageId);
    while (this.order.length > this.maxSize) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }
  }

  /**
   * Forget a mark, so the next delivery of the same id is processed rather than
   * skipped. marking happens BEFORE the work, to hold the door against
   * a concurrent duplicate — which means a failure has to take the mark back, or
   * the redelivery that a held ack buys is silently dropped as a duplicate.
   */
  unmark(messageId: string | null | undefined): void {
    if (!messageId || typeof messageId !== 'string') return;
    if (!this.seen.delete(messageId)) return;
    const at = this.order.indexOf(messageId);
    if (at !== -1) this.order.splice(at, 1);
  }
}
