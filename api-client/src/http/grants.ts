/**
 * the one grant shape the backend presents on the wire, mirrored for
 * SDK consumers. Context, connection, and payment grants all serialise to this
 * exact object (see backend `src/grants/grant-view.ts`), so a caller reads one
 * shape to answer "what grants exist, and are they live?" regardless of rail.
 *
 * `scope.kind` names the rail's resource: context grants keep chat/agreement/org;
 * a connection grant is `connection` + connectionId; a payment grant is
 * `wallet` + the root wallet id. A grant's bounds are its `caveats` — for
 * context grants (which have no caveat column) the temporal mode and read
 * watermark are presented as `temporal` / `watermark_at` caveats.
 */
export type GrantHealth = 'active' | 'expired' | 'revoked';

/**
 * Who holds a grant. Declared at issuance and carried on the row — nothing
 * about an id says what it names. An `org` holder is how one grant covers every
 * member of that organization.
 */
export type GrantHolderKind = 'user' | 'org' | 'agent';

/**
 * What a grant lets its holder do. `write` implies `read`, `admit` implies
 * both: `read` sees the scope, `write` takes part in it, `admit` brings others
 * in as well.
 */
export type { GrantAccessKind };

/**
 * The kind of principal-authored consent object a grant rests on. Every grant
 * is minted by one of these, or delegated from a parent grant that was.
 */
export type GrantBasisKind =
  | 'creation'
  | 'publication'
  | 'membership'
  | 'acceptance'
  | 'agreement';

/**
 * The context rail's scope kinds, as VALUES — the type below is derived from
 * them, so widening the rail is one edit rather than a type change plus however
 * many hand-written literal lists happen to exist. A literal subset still
 * typechecks against the union, which is how the CLI's grant listings silently
 * stopped showing a whole scope kind after `artifact` was added; anything that
 * means "every context scope" should read this.
 */
import {
  CONTEXT_GRANT_SCOPE_KINDS,
  GRANT_SCOPE_KINDS,
  type ContextGrantScopeKind,
  type GrantScopeKind,
} from '@ziggs-ai/contracts';

export {
  CONTEXT_GRANT_SCOPE_KINDS,
  GRANT_SCOPE_KINDS,
  type ContextGrantScopeKind,
  type GrantScopeKind,
};

/**
 * The scope a grant is over, and one caveat on it — the wire's shapes.
 *
 * `label` is populated only by the unified list read; the per-rail
 * issue/delegate responses omit it, which is why the contract has it optional.
 */
export type { GrantScopeView, GrantCaveatView };

/**
 * A grant row, exactly as the server sends it.
 *
 * Generated from the OpenAPI spec rather than restated here. Three copies of
 * this shape lived in this package — this one, a looser one on
 * `PaymentsClient`, and a third on `ConnectionsClient` — and each rail's
 * client believed a different subset of the row.
 */
import type {
  GrantView,
  GrantScopeView,
  GrantCaveatView,
} from '@ziggs-ai/contracts';
import type { GrantAccessKind } from '@ziggs-ai/contracts';
export type { GrantView };

/** Value of the first caveat of `type` on a grant, or undefined. */
export function grantCaveat(grant: GrantView, type: string): unknown | undefined {
  return grant.caveats.find((c) => c.type === type)?.value;
}
