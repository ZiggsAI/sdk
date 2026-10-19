/**
 * Every claimed wake must leave a recorded outcome.
 *
 * Claim + ack with no externally visible effect used to exist: the host
 * consumed the delivery, the agent stayed silent, and metering had no row.
 * A wake ends in exactly one of: a reply, task progress, or an explicit
 * no-op with a reason.
 */

export type WakeOutcomeKind = 'replied' | 'task-progress' | 'no-op';

/**
 * Whether a wake that was ASKED something answered it.
 *
 * A wake handed a counterparty's message and a wake handed a notification are
 * not the same obligation, and the outcome kinds could not tell them apart: an
 * agent that composed a status answer, wrote it as host output and finished
 * clean landed on `no-op / llm_no_visible_effect`, the same row a duplicate
 * echo produces — and an agent that answered by writing the task instead landed
 * on `task-progress`, which reads like success. Neither says the requester got
 * nothing.
 *
 * `sent: false` carries the reason there was no send, because "it decided not
 * to" and "it forgot" are both legitimate outcomes and only one of them is a
 * bug — but they have to be distinguishable to be either.
 */
export interface WakeReply {
  asked: true;
  sent: boolean;
  reason?: string;
}

export interface WakeOutcome {
  kind: WakeOutcomeKind;
  reason?: string;
  /** Present only when this wake was handed a question. */
  reply?: WakeReply;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Was this wake somebody asking this agent something?
 *
 * A counterparty `message` frame is the one shape that earns a reply. Task
 * results, agreement lifecycle and notifications are news, and the ticket is
 * explicit that they still finish without sending. The agent's own message
 * never counts: a self-addressed frame is an echo, not a question.
 */
export function wakeWasAsked(event: unknown, ownAgentId?: string): boolean {
  const frame = record(event);
  if (frame.type === 'batch' && Array.isArray(frame.events)) {
    return frame.events.some((item) => wakeWasAsked(item, ownAgentId));
  }
  if (frame.type !== 'message') return false;
  const senderId = typeof frame.senderId === 'string' ? frame.senderId : '';
  if (!senderId) return false;
  return !ownAgentId || senderId !== ownAgentId;
}

export function classifyWakeOutcome(input: {
  skippedReason?: string;
  lastOutcomeKind?: string | null;
  llmCalls: number;
  sentMessage?: boolean;
  taskWrite?: boolean;
  /** This wake was handed a question — see {@link wakeWasAsked}. */
  asked?: boolean;
}): WakeOutcome {
  const sent = Boolean(input.sentMessage) || input.lastOutcomeKind === 'message-sent';
  // The answer to "was this wake asked something, and did it answer" is
  // independent of what else the wake did, so it rides alongside the kind
  // rather than competing with it: a wake can make task progress AND leave the
  // question it was handed unanswered, and that is exactly the case that used
  // to disappear.
  const reply: WakeReply | undefined = !input.asked
    ? undefined
    : sent
      ? { asked: true, sent: true }
      : {
          asked: true,
          sent: false,
          reason:
            input.skippedReason ??
            (input.taskWrite
              ? 'recorded_on_the_task_only'
              : input.llmCalls > 0
                ? 'composed_without_sending'
                : 'no_llm'),
        };
  const withReply = (outcome: WakeOutcome): WakeOutcome =>
    reply ? { ...outcome, reply } : outcome;
  if (input.skippedReason) {
    return withReply({ kind: 'no-op', reason: input.skippedReason });
  }
  if (sent) {
    return withReply({ kind: 'replied' });
  }
  if (
    input.taskWrite ||
    input.lastOutcomeKind === 'task-delegated' ||
    input.lastOutcomeKind === 'task-completed' ||
    input.lastOutcomeKind === 'task-progress'
  ) {
    return withReply({ kind: 'task-progress' });
  }
  if (input.llmCalls > 0) {
    return withReply({ kind: 'no-op', reason: 'llm_no_visible_effect' });
  }
  return withReply({ kind: 'no-op', reason: 'no_llm' });
}

export function buildWakeOutcomePayload(input: {
  agentId: string;
  sessionId: string;
  laneKey: string;
  outcome: WakeOutcome;
  llmCalls?: number;
}): Record<string, unknown> {
  return {
    source: 'agent',
    chatId: input.sessionId,
    sessionId: input.sessionId,
    execution: {
      llmCallsTotal: input.llmCalls ?? 0,
    },
    meta: {
      effect: 'wake-outcome',
      kind: input.outcome.kind,
      ...(input.outcome.reason ? { reason: input.outcome.reason } : {}),
      // A wake that was asked something says whether it answered, and why not.
      // Written flat so a query for unanswered questions is one field compare.
      ...(input.outcome.reply
        ? {
            asked: true,
            answered: input.outcome.reply.sent,
            ...(input.outcome.reply.reason
              ? { unansweredReason: input.outcome.reply.reason }
              : {}),
          }
        : {}),
      laneKey: input.laneKey,
      agentId: input.agentId,
    },
  };
}
