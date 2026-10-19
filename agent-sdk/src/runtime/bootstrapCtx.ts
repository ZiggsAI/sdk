import type { Ctx, Identity } from '../types.js';
import { migrateLegacyTaskFields } from './taskBookkeeping.js';

/**
 * The one place a per-lane `Ctx` is constructed.
 *
 * Both cognitions bootstrap the same Ctx: the FSM (`AgentMachine` constructor)
 * and the Claude Agent SDK brain (`ClaudeBrain.tick`). Before this, each
 * carried its own copy of the fresh-Ctx literal and the restore-path defaulting,
 * and they had already drifted (the "default them ONCE here" comment in
 * AgentMachine no longer held). Keep it here so the shape lives in a single spot.
 *
 * - No `existing` → a fresh Ctx for a brand-new session.
 * - `existing` present → restore it, re-stamping `identity` and defaulting the
 *   fields that sessions persisted before they existed may lack. Sessions live
 *   up to SESSION_TTL_SECONDS (24h) in DynamoDB, so an old row can come back
 * without `tasks` (pre- lane-level pendingSubtasks/collectedResults);
 *   migrate/default them here, nowhere else.
 */
export function bootstrapCtx(identity: Identity, existing?: Ctx | null): Ctx {
  if (existing) {
    const legacy = existing as unknown as Record<string, unknown>;
    // the lane-level mirrors are destructured OFF, not carried through.
    // `migrateLegacyTaskFields` has already folded whatever they held into
    // `tasks`; keeping the empty husks on the restored Ctx is what let a live FSM
    // guard read one and see "nothing delegated" forever.
    const {
      pendingSubtasks: _pendingSubtasks,
      collectedResults: _collectedResults,
      delegatedAgreementIds: _delegatedAgreementIds,
      ...rest
    } = existing as Ctx & {
      pendingSubtasks?: unknown;
      collectedResults?: unknown;
      delegatedAgreementIds?: unknown;
    };
    return {
      ...rest,
      identity,
      tasks: migrateLegacyTaskFields(legacy),
    };
  }
  return {
    identity,
    tasks: {},
    activeAgreementId: null,
    activeTaskId: null,
    pendingProposalAgreementId: null,
    toolResults: [],
    lastOutcome: { kind: 'enter' },
  };
}
