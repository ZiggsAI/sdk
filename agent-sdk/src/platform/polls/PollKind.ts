/**
 * PollKind — polling as a declared, pluggable thing, the way tools are.
 *
 * An agent lists the polls it depends on the same way it lists tools:
 *
 *   polls: [{ kind: 'sente-email', identityId: 'idt_...' }]
 *
 * The declaration and its PollRunner travel with the Agent. connectAsync starts
 * both inbox delivery and external polls; disconnect stops both. The process
 * runner does not own a second copy of the polling lifecycle.
 *
 * A poll answers ONE question: is there work for this agent right now. It never
 * returns the work itself. The agent reads that for itself once woken, through
 * its own tools, so it cannot end up with a second, differently-shaped copy of
 * its input and no way to tell which is current.
 *
 * WHERE THE CURSOR LIVES: in the source, whenever the source has one. Sente
 * has `archived` on a message, so "already handled" is a fact about the
 * mailbox, not something we mirror. A kind whose source has no such notion has
 * to keep a cursor, and then it is the kind's business — never the agent's.
 */

/**
 * Kind-specific config, verbatim from the agent's manifest.
 *
 * `chatId` is not kind-specific and is not optional in practice: a wake has to
 * resolve to a lane or Agent's session resolver returns null and drops it
 * silently. A poll has no engagement behind it to derive one from, so the
 * binding names the chat the agent thinks in — which also puts its triage
 * somewhere a human can watch. PollRunner refuses to register a binding without
 * one rather than let the wake evaporate at runtime.
 */
export interface PollBinding {
  kind: string;
  /** Chat the poll wake is delivered into. Required; see above. */
  chatId?: string;
  [key: string]: unknown;
}

export interface PollContext {
  agentId: string;
  operatorKey?: string;
}

export interface PollResult {
  /** Whether the agent should be woken now. */
  actionable: boolean;
  /**
   * One line telling the agent why it woke. Carries no payload — see above.
   * Omit and the runner sends the kind's default.
   */
  hint?: string;
}

export interface PollKind {
  id: string;
  /** How often to run this kind. The runner's default applies when omitted. */
  intervalMs?: number;
  poll(binding: PollBinding, ctx: PollContext): Promise<PollResult>;
}

/**
 * Kinds register here rather than being imported by the runner, so a
 * source-specific kind ships with the agent that needs it and the SDK stays
 * free of third-party dependencies.
 */
export class PollRegistry {
  private readonly kinds = new Map<string, PollKind>();

  register(kind: PollKind): this {
    if (!kind?.id) throw new Error('PollRegistry: a poll kind needs an id');
    if (this.kinds.has(kind.id)) throw new Error(`PollRegistry: duplicate poll kind "${kind.id}"`);
    this.kinds.set(kind.id, kind);
    return this;
  }

  get(id: string): PollKind | undefined {
    return this.kinds.get(id);
  }

  get ids(): string[] {
    return [...this.kinds.keys()];
  }
}

/** Read an agent's declared polls off its config. Absent or malformed → none. */
export function declaredPolls(config: Record<string, unknown>): PollBinding[] {
  const raw = config['polls'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (b): b is PollBinding =>
      !!b && typeof b === 'object' && typeof (b as PollBinding).kind === 'string',
  );
}
