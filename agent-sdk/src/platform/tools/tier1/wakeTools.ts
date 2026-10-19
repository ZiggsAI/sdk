import { defineTool, type ToolDefinition } from '../../../tools/defineTool.js';

/**
 * "wake me at".
 *
 * One tool for both brains. The state machine could already be woken by a
 * parked state's `timeoutMs`, but only the host armed that and only from a
 * state declaration; a Claude-brain agent had no way to be woken at a time at
 * all. An agent waiting for somebody's answer needs exactly this and nothing
 * more: check back later, on its own schedule.
 *
 * What the platform learns from this: nothing. The wake is the agent's own
 * business — it arrives on the agent's lane, behind any real event, and no
 * server-side schedule is created.
 */
export interface WakeSchedulerPort {
  /** Arm the lane's timer. Returns when it will actually fire. */
  armWakeAt(
    sessionId: string,
    at: Date | number,
    reason: string | null,
  ): { firesAt: number; delayMs: number };
}

export interface WakeToolContext {
  chatId?: string;
  sessionId?: string;
  wakeScheduler?: WakeSchedulerPort;
}

export const wakeAtTool: ToolDefinition = defineTool(
  'wake_at',
  {
    at: {
      type: 'string',
      required: true,
      description:
        'When to wake, ISO 8601 (e.g. 2026-09-12T09:00:00Z). Must be in the future; a time already past wakes you on the next turn instead.',
    },
    reason: {
      type: 'string',
      description:
        'What you are waiting for, in your own words. You will read this back when the wake arrives, so write it for yourself: "check whether Dana answered about the Q3 number".',
    },
  },
  async (args: Record<string, unknown>, ctx: Record<string, unknown>) => {
    const c = ctx as WakeToolContext;
    const scheduler = c.wakeScheduler;
    if (!scheduler) {
      throw new Error(
        'wake_at is unavailable here (no wake scheduler in tool context — expected when running under Agent)',
      );
    }
    const sessionId = c.chatId ?? c.sessionId;
    if (!sessionId) throw new Error('wake_at: no session in tool context');

    const raw = typeof args.at === 'string' ? args.at.trim() : '';
    if (!raw) throw new Error('wake_at requires `at` as an ISO 8601 date-time');
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) {
      throw new Error(
        `wake_at: could not read "${raw}" as a date. Send ISO 8601, e.g. 2026-09-12T09:00:00Z.`,
      );
    }
    const reason =
      typeof args.reason === 'string' && args.reason.trim()
        ? args.reason.trim()
        : null;

    // Report what was ARMED, not what was asked for. The two differ when the
    // requested time has already passed, and an agent that believes it is
    // waiting until tomorrow when it will in fact wake in a second would spend
    // its budget on the difference.
    const armed = scheduler.armWakeAt(sessionId, at, reason);
    return {
      ok: true,
      wakeAt: new Date(armed.firesAt).toISOString(),
      inMs: armed.delayMs,
      reason,
      note:
        'One wake is armed per lane, and arming again replaces it. This wake is held in memory: if the process restarts before it fires it is lost, and you will pick up on your next real event instead.',
    };
  },
  {
    description:
      'Ask to be woken at a time, to check back on something you are waiting for. The wake arrives on this conversation, behind anything real that happens first. Arming again replaces the previous wake — a check-back schedule is a series of single wakes, so re-arm the next one each time you wake. Counts against your wake budget like any other wake.',
  },
);

export const WAKE_TOOLS: ToolDefinition[] = [wakeAtTool];
