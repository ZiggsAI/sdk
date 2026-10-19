/**
 * One decision, one sentence, on every rail.
 *
 * When somebody answers a request an agent made (an access request on an
 * artifact, a connection request, its own proposal), the agent hears about it
 * as an agreement row whose `reason` names the decision. Rendered generically
 * ("open the agreement <id>") that row says nothing about what was decided,
 * and the agent learned it was approved or refused only if it happened to list
 * its agreements. The hosted brain already had words for these reasons; the
 * MCP rail did not. Both now call this function, so they say the same thing.
 *
 * The sentence is server state only. It never interpolates anything a
 * counterparty wrote: no titles, no messages, no descriptions. Ids, an actor id
 * and an instant are all it carries.
 */

/**
 * The actor as it may appear in words, or null.
 *
 * A person's account id is `username:::email`. The server shows a reader
 * outside that person's org their `psn_` face instead, but an older
 * server, or a row written before that, still hands the raw id over, and the
 * model repeats whatever it is told into the room. So an id shaped like a
 * person's account is left out rather than said.
 */
export function speakableActor(actorId: string | null | undefined): string | null {
  if (typeof actorId !== 'string' || !actorId) return null;
  return actorId.includes(':::') || actorId.includes('@') ? null : actorId;
}

export type DecisionOutcome = 'approved' | 'rejected' | 'fulfilled' | 'held';

export interface DecisionWordsInput {
  /** The delivery row's `reason`. Anything that is not a decision maps to null. */
  reason: string | null | undefined;
  /** Who answered (the row's `actorId`). Absent on some emits. */
  actorId?: string | null;
  /** When it was answered (the row's `ts`), as an ISO instant. */
  ts?: string | null;
  /** The request agreement. */
  agreementId?: string | null;
  /**
   * What the request was about, when the caller knows it. Named only when
   * `kind` is `artifact`; today's delivery row does not carry it, so the
   * sentence sends the reader to the agreement to find the artifact instead.
   */
  scope?: { kind: string; id: string } | null;
  /**
   * Which surface's tool names to use. MCP registers `ziggs_open` and
   * `ziggs_context_read`; the hosted SDK registers `open` and `context_read`.
   */
  surface?: 'mcp' | 'sdk';
}

export interface DecisionWords {
  outcome: DecisionOutcome;
  /** Plain, model-facing, server state only. */
  sentence: string;
}

const REFUSED_REASONS: ReadonlySet<string> = new Set([
  'approval:rejected',
  'context_request_rejected',
  'connection_request_rejected',
]);

function requestNoun(reason: string): string {
  if (reason.startsWith('context_request_')) return 'access request';
  if (reason.startsWith('connection_request_')) return 'connection request';
  return 'request';
}

/**
 * Map a delivery row's decision reason to words. Returns null when the reason
 * is not a decision (an ordinary doorbell, a store claim, a withheld contact),
 * so a caller can use it as the test for "does this row need explaining".
 */
export function decisionWords(input: DecisionWordsInput): DecisionWords | null {
  const reason = typeof input.reason === 'string' ? input.reason : '';
  if (!reason) return null;

  const tool = (key: 'open' | 'context_read'): string =>
    input.surface === 'sdk' ? key : `ziggs_${key}`;
  const on = input.agreementId
    ? `agreement ${input.agreementId}`
    : 'this agreement';
  const actor = speakableActor(input.actorId);
  const by = actor ? ` by ${actor}` : '';
  const at = input.ts ? ` at ${input.ts}` : '';
  const artifactId =
    input.scope?.kind === 'artifact' && input.scope.id ? input.scope.id : null;

  if (REFUSED_REASONS.has(reason)) {
    return {
      outcome: 'rejected',
      sentence:
        `Your ${requestNoun(reason)} on ${on} was refused${by}${at}. ` +
        'Report the unresolved dependency where you asked, and ask what to change.',
    };
  }

  if (reason === 'context_request_fulfilled') {
    const open = artifactId
      ? `Open the artifact ${artifactId} with ${tool('context_read')} or ${tool('open')}; `
      : `Open the agreement with ${tool('open')} to find the artifact, then open the artifact with ${tool('context_read')} or ${tool('open')}; `;
    return {
      outcome: 'fulfilled',
      sentence:
        `Your access request on ${on} was approved${by}${at}. ` +
        open +
        'the grant is bounded, check its expiry on the agreement.',
    };
  }

  if (reason === 'connection_request_fulfilled') {
    return {
      outcome: 'fulfilled',
      sentence:
        `Your connection request on ${on} was fulfilled${by}${at}. ` +
        `The connection is ready to use; open the agreement with ${tool('open')} for its connection and grant ids and the bound on the grant.`,
    };
  }

  if (reason === 'approval:approved') {
    return {
      outcome: 'approved',
      sentence:
        `An approval on ${on} was given${by}${at}. ` +
        'If it answers a request you made, carry out the next step you promised where you asked; ' +
        `open the agreement with ${tool('open')} to see which slot was answered. ` +
        'Approval of your own request is not a new hire and needs no introduction.',
    };
  }

  if (reason === 'formation_held') {
    return {
      outcome: 'held',
      sentence:
        `${on.charAt(0).toUpperCase()}${on.slice(1)} is held${at}: a consent it needs has not been given yet, so nothing is granted. ` +
        `Open the agreement with ${tool('open')} to see whose decision it waits on.`,
    };
  }

  return null;
}
