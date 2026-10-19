import type {
  Action,
  Ctx,
  EffectHandler,
  MechanicalState,
  Outcome,
  ToolResultEntry,
  DeliveryWriteKeys,
} from '../types.js';
import type { MemoryStore } from '../memory/MemoryStore.js';
import { outcomeFromActionResult, type EmittedEvent, type RawEvent, type WireResult } from './buildOutcome.js';
import { runtimeLog } from '../shared/runtimeLog.js';
import type { ToolCallResult } from '../types.js';

export interface RunMechanicalResult {
  outcome: Outcome;
  toolResults: ToolResultEntry[];
  llmCalls: number;
  tokens: { total: number; input: number; output: number };
}

/**
 * run a mechanical state — invoke one bound tool with no LLM turn.
 * Used by dumb coordinators whose only job is a fixed tool call on task-assigned.
 */
export async function runMechanical(input: {
  stateId: string;
  state: MechanicalState;
  ctx: Ctx;
  eff: EffectHandler;
  memory?: MemoryStore;
  incomingEvent: RawEvent | null;
  /** This wake's replay-stable write keys (shared across every turn of the tick — see AgentMachine). */
  writeKeys?: DeliveryWriteKeys;
}): Promise<RunMechanicalResult> {
  const { stateId, state, ctx, eff, memory, incomingEvent, writeKeys } = input;
  const sessionId = ctx.identity.sessionId;
  const runId = crypto.randomUUID();

  const effWithTrace: typeof eff = (effect) => {
    if (effect.kind === 'tool-call') {
      return eff({ ...effect, runId, stateId, writeKeys } as typeof effect);
    }
    return eff(effect);
  };

  runtimeLog.info('runMechanical', `enter state=${stateId} tool=${state.tool}`);

  const args =
    typeof state.buildArgs === 'function'
      ? state.buildArgs(ctx, ctx.lastOutcome)
      : { ...(state.args ?? {}) };

  const pseudoAction: Action = {
    prompt: { instruction: '' },
    tool: state.tool,
    produces: state.produces,
  };

  let emitted: EmittedEvent[] = [];
  try {
    const r = await effWithTrace({
      kind: 'tool-call',
      sessionId,
      name: state.tool,
      args,
      memory,
      senderId: incomingEvent?.senderId != null ? String(incomingEvent.senderId) : undefined,
      senderType: incomingEvent?.senderType != null ? String(incomingEvent.senderType) : undefined,
    }) as ToolCallResult;

    if (!r.ok) {
      emitted = [{ type: 'tool_error', tool: state.tool, error: r.error || 'unknown', senderId: 'system' }];
    } else if (r.events && (r.events as unknown[]).length > 0) {
      emitted = r.events as unknown as EmittedEvent[];
    } else {
      emitted = [{ type: 'tool_result', tool: state.tool, result: r.result as WireResult | undefined, senderId: 'system' }];
    }
  } catch (error: unknown) {
    emitted = [
      {
        type: 'tool_error',
        tool: state.tool,
        error: (error as Error)?.message ?? String(error),
        senderId: 'system',
      },
    ];
  }

  const toolResults: ToolResultEntry[] = [];
  let outcome = outcomeFromActionResult('__mechanical__', pseudoAction, args, emitted, toolResults);
  if (emitted.some((e) => e?.type === 'tool_error')) {
    outcome = {
      kind: 'error',
      source: 'tool',
      cause: emitted.find((e) => e?.type === 'tool_error')?.error ?? 'tool failed',
      retryable: false,
    };
  }

  runtimeLog.info('runMechanical', `done state=${stateId} outcome=${outcome.kind} llmCalls=0`);

  return {
    outcome,
    toolResults,
    llmCalls: 0,
    tokens: { total: 0, input: 0, output: 0 },
  };
}
