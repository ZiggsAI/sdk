import { runtimeLog } from '../shared/runtimeLog.js';

interface PendingMessage {
  text: string;
  /** Absent when the send left the recipient for the backend to resolve. */
  receiverId?: string;
  timestamp: number;
}

export interface OutboxBufferOptions {
  ttlMs?: number;
}

interface HistoryEntryShape {
  entryType?: string;
  text?: string;
  sender?: { id?: string; type?: string };
  receiver?: { id?: string };
  timestamp?: number;
}

/**
 * Tracks outbound messages locally until server history syncs them, then
 * merges any unmatched ones into the next read context. Prevents the LLM
 * from re-saying things it already said when the server is slow to publish.
 */
export class OutboxBuffer {
  private _pending: Map<string, PendingMessage[]> = new Map();
  private _ttlMs: number;

  constructor(options: OutboxBufferOptions = {}) {
    this._ttlMs = Number.isFinite(options.ttlMs) ? Math.max(1_000, options.ttlMs!) : 10 * 60 * 1000;
  }

  track(chatId: string, msg: { text: string; receiverId?: string }): void {
    this._gcChat(chatId);
    if (!this._pending.has(chatId)) this._pending.set(chatId, []);
    this._pending.get(chatId)!.push({ text: msg.text, receiverId: msg.receiverId, timestamp: Date.now() });
  }

  merge(chatId: string, history: HistoryEntryShape[], agentId: string | null): void {
    this._gcChat(chatId);
    const pending = this._pending.get(chatId);
    if (!pending || pending.length === 0) return;

    const matchedIndices = new Set<number>();
    const remaining: PendingMessage[] = [];

    for (const msg of pending) {
      const matchIdx = history.findIndex((entry, idx) =>
        !matchedIndices.has(idx) &&
        entry.text === msg.text &&
        entry.sender?.id === agentId,
      );
      if (matchIdx !== -1) matchedIndices.add(matchIdx);
      else remaining.push(msg);
    }

    for (const msg of remaining) {
      history.push({
        entryType: 'message',
        text: msg.text,
        sender: { id: agentId || undefined, type: 'agent' },
        receiver: { id: msg.receiverId },
        timestamp: msg.timestamp,
      });
    }

    if (remaining.length === 0) this._pending.delete(chatId);
    else this._pending.set(chatId, remaining);
  }

  gc(): void {
    for (const chatId of this._pending.keys()) this._gcChat(chatId);
  }

  private _gcChat(chatId: string): void {
    const pending = this._pending.get(chatId);
    if (!pending?.length) return;
    const cutoff = Date.now() - this._ttlMs;
    const fresh = pending.filter(msg => msg.timestamp >= cutoff);
    if (fresh.length === 0) {
      this._pending.delete(chatId);
      runtimeLog.warn('OutboxBuffer', `expired all pending messages chatId=${chatId}`);
      return;
    }
    if (fresh.length !== pending.length) {
      this._pending.set(chatId, fresh);
    }
  }
}
