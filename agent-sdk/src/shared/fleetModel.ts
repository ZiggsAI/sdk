/**
 * The one model table. Sonnet 5.5 is the default.
 * A per-agent pin wins, then `LLM_MODEL`, then {@link DEFAULT_MODEL}.
 * The id also picks the provider: `claude-*` routes to Anthropic.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** Pin, then `LLM_MODEL`, then {@link DEFAULT_MODEL}. */
export function resolveFleetModel(pinned?: string): string {
  const pin = pinned?.trim();
  if (pin) return pin;
  const fromEnv = process.env.LLM_MODEL?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_MODEL;
}
