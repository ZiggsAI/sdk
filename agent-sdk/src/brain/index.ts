import type { TickInput, TickOutput } from './ZiggsBrain.js';

/**
 * Public brain contract — how an agent decides on each wake.
 * {@link ZiggsBrain} (Ziggs workflow/FSM) and {@link ClaudeBrain} both implement this.
 */
export interface Brain {
  readonly kind: 'ziggs' | 'claude' | 'handler';
  tick(input: TickInput): Promise<TickOutput>;
}

/** Config carried by {@link ziggsBrain} — workflow is declared on the agent. */
export interface ZiggsBrainConfig {
  /** Model id — `claude-*` routes to Anthropic, else OpenAI. */
  model?: string;
  openaiKey?: string;
  anthropicKey?: string;
}

/** Config carried by {@link claudeBrain}. */
export interface ClaudeBrainConfig {
  anthropicKey?: string;
  model?: string;
  /** Max agentic turns per Claude SDK wake. Agent default applies when omitted. */
  maxTurns?: number;
  /** Persona line injected into the Claude system prompt. */
  specialization?: string | null;
}

export interface HandlerBrainConfig { tick(input: TickInput): Promise<TickOutput>; }

/** Run ordinary code on wakes, with the same scoped effects and no model key. */
export function handlerBrain(tick: HandlerBrainConfig['tick']): BrainSelection { return { kind: 'handler', config: { tick } }; }

export type BrainSelection =
  | { readonly kind: 'handler'; readonly config: HandlerBrainConfig }
  | { readonly kind: 'ziggs'; readonly config: ZiggsBrainConfig }
  | { readonly kind: 'claude'; readonly config: ClaudeBrainConfig };

const ZIGGS_BRAND = Symbol.for('@ziggs-ai/agent-sdk:ziggsBrain');
const CLAUDE_BRAND = Symbol.for('@ziggs-ai/agent-sdk:claudeBrain');

/** Pick the Ziggs workflow brain (state machine + runTurn tool loop). */
export function ziggsBrain(config: ZiggsBrainConfig = {}): BrainSelection {
  return { kind: 'ziggs', config, [ZIGGS_BRAND]: true } as BrainSelection & { [ZIGGS_BRAND]: true };
}

/** Pick the Claude Agent SDK brain (autonomous query() loop). */
export function claudeBrain(config: ClaudeBrainConfig = {}): BrainSelection {
  return { kind: 'claude', config, [CLAUDE_BRAND]: true } as BrainSelection & { [CLAUDE_BRAND]: true };
}

export function isBrainSelection(value: unknown): value is BrainSelection {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as BrainSelection).kind;
  return kind === 'ziggs' || kind === 'claude' || kind === 'handler';
}

/** Map public `brain` + legacy `cognition` into normalized agent options. */
export function applyBrainToAgentOptions<T extends {
  brain?: BrainSelection;
  cognition?: 'fsm' | 'claude-sdk';
  model?: string;
  openaiKey?: string;
  anthropicKey?: string;
  claudeMaxTurns?: number;
  specialization?: string | null;
}>(options: T): T & { cognition: 'fsm' | 'claude-sdk' } {
  const brain = options.brain;
  if (!brain) {
    return { ...options, cognition: options.cognition ?? 'fsm' };
  }
  if (brain.kind === 'handler') return { ...options, cognition: 'fsm' };
  if (brain.kind === 'claude') {
    const c = brain.config;
    return {
      ...options,
      cognition: 'claude-sdk',
      ...(c.model !== undefined ? { model: c.model } : {}),
      ...(c.anthropicKey !== undefined ? { anthropicKey: c.anthropicKey } : {}),
      ...(c.maxTurns !== undefined ? { claudeMaxTurns: c.maxTurns } : {}),
      ...(c.specialization !== undefined ? { specialization: c.specialization } : {}),
    };
  }
  const z = brain.config;
  return {
    ...options,
    cognition: 'fsm',
    ...(z.model !== undefined ? { model: z.model } : {}),
    ...(z.openaiKey !== undefined ? { openaiKey: z.openaiKey } : {}),
    ...(z.anthropicKey !== undefined ? { anthropicKey: z.anthropicKey } : {}),
  };
}

export function isClaudeCognition(cognition: 'fsm' | 'claude-sdk' | undefined): boolean {
  return cognition === 'claude-sdk';
}
