import { randomUUID } from 'node:crypto';
import type { MessageCommand, MessageIntent, MessageRecord } from '@ziggs-ai/contracts';
import type { EffectHandler } from '../types.js';

export interface ResponseCommandOptions {
  /** Stable write key for a retry; a fresh UUID when absent. */
  operationId?: string;
  /** A request wakes the agents it reaches; an fyi is filed. Default fyi. */
  intent?: MessageIntent;
  /**
   * Who to send to when there is no wake to reply to, or when the message
   * goes to someone other than the trigger's sender. Readers and recipients
   * are both this one principal.
   */
  recipientId?: string;
}

/** Compose an FSM message from the current wake. A session locates the wake
 * context; it is never a room, principal or authority identifier.
 *
 * A reply from a wake names nobody: the backend links it to the trigger and
 * fills readers and recipients from the trigger's own readers and sender. An
 * explicit recipient is the form for a send outside a wake, or to a party the
 * trigger did not come from. */
export async function responseCommand(eff: EffectHandler, sessionId: string, text: string, options: ResponseCommandOptions = {}): Promise<MessageCommand> {
  const snapshot = await eff({ kind: 'read-context', sessionId, opts: { includeHistory: false } });
  if (snapshot.unavailable) throw new Error('Required response context is unavailable');
  const parent = snapshot.messageRecord as MessageRecord | undefined;
  const trigger = parent && !parent.sender.isSelf ? parent : undefined;
  const explicit = options.recipientId && options.recipientId !== trigger?.sender.ref ? options.recipientId : undefined;
  if (!trigger && !explicit) throw new Error('Name an explicit recipient or read an exact message before replying');
  const principalIds = explicit ? [explicit] : [];
  return {
    operationId: options.operationId ?? randomUUID(), content: { text },
    audience: { kind: 'explicit', principalIds }, deliveries: { kind: 'explicit', principalIds },
    intent: options.intent ?? 'fyi',
    ...(snapshot.messageMandate ? { mandate: snapshot.messageMandate as MessageCommand['mandate'] } : {}),
    ...(explicit && trigger ? { relationships: { replyToMessageId: trigger.messageId } } : {}),
  };
}
