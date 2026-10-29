import { getBackendUrl } from '../utils/urlUtils.js';

import { buildOperatorHeaders } from './operatorHeaders.js';
import { CONTEXT_GRANT_SCOPE_KINDS } from './grants.js';
import type {
  GrantAccessKind,
  GrantHolderKind,
  GrantView,
} from './grants.js';
import { throwApiError } from '../shared/apiError.js';

/**
 * The context rail's scopes. `artifact` is the narrowest — one specific
 * artifact, shared without sharing any chat or agreement it sits in. `task` is
 * a branch of a work graph: the named task and everything under it. Both are
 * still the context rail, not new grant primitives.
 *
 * Derived from {@link CONTEXT_GRANT_SCOPE_KINDS} rather than written out again:
 * a hand-copied subset still typechecks against the union, which is how this
 * list sat a scope kind behind the rail.
 */
export type ContextGrantScopeKind = (typeof CONTEXT_GRANT_SCOPE_KINDS)[number];
export type ContextTemporal = 'from-now' | 'from-start';

export interface ContextGrantScope {
  kind: ContextGrantScopeKind;
  id: string;
}

/**
 * @deprecated context grants now serialise to the canonical
 * {@link GrantView} like every other rail. This alias previously declared a
 * flat `scopeKind`/`scopeId` + `revoked` shape that the backend never actually
 * emitted (it sends nested `scope: { kind, id }` and folds temporal/watermark
 * into `caveats`), so reads like `record.scopeKind` were always `undefined`.
 * Use `GrantView`; this remains only so existing name-imports keep resolving.
 */
export type ContextGrantRecord = GrantView;

export interface IssueContextGrantInput {
  holderId: string;
  /**
   * What kind of principal the holder is: a person, an organization, or an
   * agent. Always stated, because an id says nothing about what it names — and
   * an organization holder is how one grant covers a whole team.
   */
  holderKind: GrantHolderKind;
  /**
   * What the holder may do: `read` to see the scope, `write` to take part in
   * it, `admit` to bring others in as well. Defaults to `write`.
   */
  kind?: GrantAccessKind;
  scope: ContextGrantScope;
  temporal?: ContextTemporal;
  expiresAt?: string | null;
}

export interface DelegateContextGrantInput {
  holderId: string;
  holderKind: GrantHolderKind;
  /** Never stronger than the grant it comes from; defaults to the same. */
  kind?: GrantAccessKind;
  scope: ContextGrantScope;
  temporal: ContextTemporal;
  expiresAt?: string | null;
  watermarkAt?: string;
}

/** Delegating your own principal's grant mints immediately; passing a grant
 *  whose original owner is a different party opens a request that owner
 *  approves — no grant is minted until then. */
export type DelegateContextGrantResult =
  | { status: 'granted'; grant: GrantView }
  | { status: 'pending_approval'; agreementId: string; ownerId?: string };

/**
 * Shared post-parse for delegate and author-share: both endpoints return either
 * a minted grant or a pending_approval request the owner must approve.
 */
function parseGrantOrPending(
  body: string,
  expectedFrom: string,
): DelegateContextGrantResult {
  const parsed = JSON.parse(body) as {
    grant?: GrantView;
    status?: string;
    agreementId?: string;
    ownerId?: string;
  };
  if (parsed.status === 'pending_approval' && parsed.agreementId) {
    return {
      status: 'pending_approval',
      agreementId: parsed.agreementId,
      ownerId: parsed.ownerId,
    };
  }
  if (!parsed.grant?.grantId) {
    throw new Error(
      `Invalid response: expected { grant } or { status: "pending_approval" } from ${expectedFrom}`,
    );
  }
  return { status: 'granted', grant: parsed.grant };
}

/** A single readable entry inside a grant's scope — id + label only. */
export interface ReachEntry {
  id: string;
  label: string;
}

/**
 * reach expansion — the chat/agreement ids a grant you hold actually
 * covers, so an org/agreement-scoped grant becomes a concrete list you can
 * `context_read` through (via=chat:<id> / agreement:<id>). Ids + labels only,
 * never content. Org scope is capped; `truncatedChats`/`truncatedAgreements`
 * report how many were left off, never silently dropped.
 */
export interface GrantReachResult {
  grantId: string;
  scope: ContextGrantScope;
  chats: ReachEntry[];
  agreements: ReachEntry[];
  truncatedChats: number;
  truncatedAgreements: number;
}


/**
 * context grant management — list / issue / delegate / revoke.
 */
export class ContextGrantsClient {
  private readonly operatorKey: string;
  private readonly agentId?: string;
  private readonly baseUrl: string;

  /**
   * @param operatorKey Agent-scoped or fleet operator key.
   * @param agentId Required for fleet keys (sent as X-Agent-Id). Omit for agent-scoped keys.
   */
  constructor(operatorKey: string, agentId?: string, baseUrl?: string) {
    if (!operatorKey) {
      throw new Error('ContextGrantsClient: operatorKey is required');
    }
    this.operatorKey = operatorKey;
    this.agentId = agentId;
    this.baseUrl = baseUrl || getBackendUrl();
  }

  async issueGrant(input: IssueContextGrantInput): Promise<GrantView> {
    const res = await fetch(`${this.baseUrl}/context/grants`, {
      method: 'POST',
      headers: buildOperatorHeaders(this.operatorKey, this.agentId, {
        'content-type': 'application/json',
      }),
      body: JSON.stringify({
        holderId: input.holderId,
        holderKind: input.holderKind,
        kind: input.kind,
        scope: input.scope,
        temporal: input.temporal,
        expiresAt: input.expiresAt,
      }),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throwApiError(res, body, `issueGrant failed: ${res.status} ${res.statusText}`);
    }
    const parsed = JSON.parse(body) as { grant?: GrantView };
    if (!parsed.grant?.grantId) {
      throw new Error('Invalid response: expected { grant } from POST /context/grants');
    }
    return parsed.grant;
  }

  /** Request-only endpoint: a successful call must still have granted no access. */
  async requestAccess(input: {
    scopeKind: 'artifact' | 'chat' | 'agreement' | 'task' | 'person'; scopeId?: string; agreementId?: string;
    reason: string; permission?: 'read' | 'reply' | 'work' | 'list'; temporal?: 'from-now' | 'from-start';
    durationHours?: number; chatId?: string; ownerId?: string;
    /** Who to ask, from the people the server offers this wake. */
    recipientId?: string;
    /** Artifact only: who should read it, if not only the caller. One grant each. */
    holders?: AccessReader[];
    contributionTo?: import('@ziggs-ai/contracts').ContributionTarget;
  }, opts?: { idempotencyKey?: string; laneId?: string }): Promise<AccessRequestResult> {
    const res = await fetch(`${this.baseUrl}/context/access/requests`, {
      method: 'POST',
      headers: buildOperatorHeaders(this.operatorKey, this.agentId, {
        'content-type': 'application/json',
        ...(opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
      }),
      body: JSON.stringify(input),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) throwApiError(res, body, `requestAccess failed: ${res.status}`);
    const result = JSON.parse(body);
    const readers = Array.isArray(result.readers) ? { readers: result.readers as AccessReaderOutcome[] } : {};
    const common = {
      accessGranted: false as const,
      ...(typeof result.actingAgentId === 'string' && result.actingAgentId ? { actingAgentId: result.actingAgentId } : {}),
      ...(result.scope ? { scope: result.scope } : {}),
      ...readers,
      ...sentToOf(result),
    };
    // Every named reader already reads it: nothing was asked.
    if (result.status === 'already_readable' && result.accessGranted === false) {
      return { status: 'already_readable', agreementId: null, ...common };
    }
    if (result.status !== 'pending_approval' || !result.agreementId || result.accessGranted !== false) {
      throw new Error('Expected a pending access request with accessGranted=false');
    }
    return { status: 'pending_approval', agreementId: result.agreementId, ...common };
  }

  async delegateGrant(
    parentGrantId: string,
    input: DelegateContextGrantInput,
    opts?: { idempotencyKey?: string },
  ): Promise<DelegateContextGrantResult> {
    const res = await fetch(
      `${this.baseUrl}/context/grants/${encodeURIComponent(parentGrantId)}/delegate`,
      {
        method: 'POST',
        headers: buildOperatorHeaders(this.operatorKey, this.agentId, {
          'content-type': 'application/json',
          ...(opts?.idempotencyKey
            ? { 'Idempotency-Key': opts.idempotencyKey }
            : {}),
        }),
        body: JSON.stringify(input),
      },
    );
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throwApiError(res, body, `delegateGrant failed: ${res.status} ${res.statusText}`);
    }
    // Re-granting a grant whose original owner is a different party does not
    // mint — it opens a request that owner must approve.
    return parseGrantOrPending(body, 'POST /context/grants/:id/delegate');
  }

  /**
   * expand a grant you hold into the chat/agreement ids inside its
   * scope. A grant is a fence, not a listing: discovery says "you hold
   * org:acme", this says which chats/agreements that covers. Holder-only,
   * labels-only, grant-fenced server-side.
   */
  async getReach(grantId: string): Promise<GrantReachResult> {
    const res = await fetch(
      `${this.baseUrl}/context/grants/${encodeURIComponent(grantId)}/reach`,
      { headers: buildOperatorHeaders(this.operatorKey, this.agentId) },
    );
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throwApiError(res, body, `getReach failed: ${res.status} ${res.statusText}`);
    }
    const parsed = JSON.parse(body) as Partial<GrantReachResult>;
    if (!parsed.scope) {
      throw new Error(
        'Invalid response: expected { scope, chats, agreements } from GET /context/grants/:id/reach',
      );
    }
    return {
      grantId: parsed.grantId ?? grantId,
      scope: parsed.scope,
      chats: parsed.chats ?? [],
      agreements: parsed.agreements ?? [],
      truncatedChats: parsed.truncatedChats ?? 0,
      truncatedAgreements: parsed.truncatedAgreements ?? 0,
    };
  }

  /**
   * share an artifact THIS agent authored with another agent.
   *
   * Not a delegation: an agent holds no grant over its own output, so there is
   * no parent to attenuate. Authorship is the authority, held by the agent's
   * owner — which is why the receiver decides the outcome. A receiver already
   * inside the sharer's trust boundary (same owner, same org, or an active link)
   * is granted immediately; anyone else opens a request the owner approves,
   * exactly like `delegateGrant`'s new-party path.
   */
  async shareArtifact(
    artifactId: string,
    input: { holderId: string; expiresAt?: string | null; chatId?: string },
    opts?: { idempotencyKey?: string },
  ): Promise<DelegateContextGrantResult> {
    const res = await fetch(
      `${this.baseUrl}/context/artifacts/${encodeURIComponent(artifactId)}/share`,
      {
        method: 'POST',
        headers: buildOperatorHeaders(this.operatorKey, this.agentId, {
          'content-type': 'application/json',
          ...(opts?.idempotencyKey
            ? { 'Idempotency-Key': opts.idempotencyKey }
            : {}),
        }),
        body: JSON.stringify(input),
      },
    );
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throwApiError(res, body, `shareArtifact failed: ${res.status} ${res.statusText}`);
    }
    return parseGrantOrPending(body, 'POST /context/artifacts/:id/share');
  }

  async revokeGrant(grantId: string): Promise<{ status: string; revokedCount?: number }> {
    const res = await fetch(
      `${this.baseUrl}/context/grants/${encodeURIComponent(grantId)}`,
      {
        method: 'DELETE',
        headers: buildOperatorHeaders(this.operatorKey, this.agentId, {
          'content-type': 'application/json',
        }),
      },
    );
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throwApiError(res, body, `revokeGrant failed: ${res.status} ${res.statusText}`);
    }
    return JSON.parse(body) as { status: string; revokedCount?: number };
  }
}

/** Who got a request card and where they answer it, as the server says. */
/** One reader an artifact access request asks for, named with its kind. */
export interface AccessReader {
  kind: 'agent' | 'user' | 'org';
  id: string;
}

/** What a request did for one named reader. */
export interface AccessReaderOutcome extends AccessReader {
  outcome: 'already_readable' | 'awaiting_approval';
}

export type AccessRequestResult = {
  accessGranted: false;
  actingAgentId?: string;
  scope?: { kind: string; id: string };
  /** Per named reader, when the request named readers. */
  readers?: AccessReaderOutcome[];
} & RequestSentTo &
  (
    | { status: 'pending_approval'; agreementId: string }
    | { status: 'already_readable'; agreementId: null }
  );

export interface RequestSentTo {
  sentTo?: { id: string; name: string | null; role: 'customer' | 'operator' };
  approveIn?: { kind: 'chat'; chatId: string } | { kind: 'inbox' };
  /** e.g. "Sent to Ido. Ido approves it in this room." */
  message?: string;
}

function sentToOf(result: Record<string, unknown>): RequestSentTo {
  return {
    ...(result.sentTo && typeof result.sentTo === 'object' ? { sentTo: result.sentTo as RequestSentTo['sentTo'] } : {}),
    ...(result.approveIn && typeof result.approveIn === 'object' ? { approveIn: result.approveIn as RequestSentTo['approveIn'] } : {}),
    ...(typeof result.message === 'string' ? { message: result.message } : {}),
  };
}
