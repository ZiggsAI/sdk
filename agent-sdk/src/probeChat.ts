/**
 * One classifier for store-publish probe rooms.
 *
 * The runner mints `probe_<agentId>_<ts>`. That prefix skips the wake gate
 * and the wake-rate breaker, so a store publish still hears a model reply.
 * It does not write a canned answer, and it is not capability evidence.
 * Capability versus liveness is decided by the store sync.
 */
export const PROBE_CHAT_ID_PREFIX = 'probe_';

export function isPublishProbeChat(
  chatId: string | undefined | null,
): boolean {
  return typeof chatId === 'string' && chatId.startsWith(PROBE_CHAT_ID_PREFIX);
}
