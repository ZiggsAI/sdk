import { randomUUID } from 'node:crypto';
import type { MessageCommand, MessageRecord } from '@ziggs-ai/contracts';
import type { EffectHandler } from '../types.js';

/** Compose an FSM response from a fresh, exact trigger. A session locates the
 * wake context; it is never a room, principal or authority identifier. */
export async function responseCommand(eff: EffectHandler, sessionId: string, text: string, options: { operationId?: string; recipientId?: string; answer?: boolean } = {}): Promise<MessageCommand> {
  const snapshot = await eff({ kind: 'read-context', sessionId, opts: { includeHistory: false } });
  if (snapshot.unavailable) throw new Error('Required response context is unavailable');
  const parent = snapshot.messageRecord as MessageRecord | undefined;
  const recipient = options.recipientId ?? (parent && !parent.sender.isSelf ? parent.sender.ref : undefined);
  if (!recipient) throw new Error('Name an explicit recipient or read an exact message before replying');
  const slots = parent?.requestedAnswers.filter(r => r.responsible.isSelf) ?? [];
  if (options.answer && slots.length > 1) throw new Error('Select the exact requested-answer slot with message_send');
  const answer = options.answer && slots.length === 1 && recipient === parent?.sender.ref ? slots[0].action : undefined;
  return {
    operationId: options.operationId ?? randomUUID(), content: { text },
    audience: { kind: 'explicit', principalIds: [recipient] }, deliveries: { kind: 'explicit', principalIds: [recipient] },
    effect: answer ? { kind: 'answer', action: answer, artifacts: [] } : { kind: 'none' },
    ...(snapshot.messageMandate ? { mandate: snapshot.messageMandate as MessageCommand['mandate'] } : {}),
    ...(parent ? { relationships: { replyToMessageId: parent.messageId } } : {}),
  };
}
