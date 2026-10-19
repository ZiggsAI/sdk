import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';
import { buildOperatorHeaders } from './operatorHeaders.js';
import type { GrantView, GrantScopeKind, GrantHealth } from './grants.js';

export interface ListGrantsQuery {
  /**
   * Filter to grants held by this agent. Admin-gated server-side when the caller
   * is not impersonating that agent.
   */
  holderId?: string;
  /**
   * Rail/resource filter. One kind or several (the context rail spans three
   * kinds: chat, agreement, org). Absent = every rail.
   */
  scopeKind?: GrantScopeKind | GrantScopeKind[];
  /**
   * Narrow to one resource id (e.g. one artifact). Server-side page filter.
   */
  scopeId?: string;
  /**
   * `'holder'` (default) = grants you hold. `'issuer'` = grants you caused
   * (for agents: author-shares + delegate children).
   */
  role?: 'holder' | 'issuer';
  /** Filter to grants of one health. */
  health?: GrantHealth;
  cursor?: string;
  limit?: number;
}

/**
 * a grant rail the caller's operator key cannot read, named
 * by the backend on `GET /grants` (it silently drops those rails from `items`,
 * so the unified list tool names what it isn't entitled to instead of
 * presenting a short list as if it were complete). Replaces the client-side
 * mirror of the backend scope table + JWT decode (the retired grantRails.ts).
 */
/**
 * The wire's list, not this client's guess at it.
 *
 * This named three rails where the server has five, so a refusal on the
 * `consent` or `inbox` rail did not typecheck as one — and the whole point of
 * this field is that a short list must not read as an empty one.
 */
import type {
  UnreadableRail,
  ListGrantsResult,
} from '@ziggs-ai/contracts';
export type { UnreadableRail };

/**
 * The unified grant listing. `unreadableRails` names the rails the caller
 * could not read, so a short list is never mistaken for an empty one.
 */
export type { ListGrantsResult };

/**
 * unified grant listing across every rail. `GET /grants` returns the
 * canonical GrantView for each grant the caller holds (or, admin-gated, a named
 * holder), filterable by scope kind and health, with cursor pagination. Replaces
 * the old per-rail listers (context discovery, connection-grants,
 * payment-grants).
 */
export class GrantsClient {
  private readonly operatorKey: string;
  private readonly agentId?: string;
  private readonly baseUrl: string;
  private readonly laneId?: string;

  /**
   * @param laneId the wake's lane (a chat id, or `agrn-<agreementId>`), sent as
   *   X-Ziggs-Lane. The server reads off it who the agent is acting for, and
   *   answers the spendable rails with only the grants this wake may spend —
   *   so an agent serving several customers is never handed a list it has to
   *   choose between. Without it the list is everything the agent holds, and
   *   the grant it picks may then be refused with nothing saying why.
   */
  constructor(
    operatorKey: string,
    agentId?: string,
    baseUrl?: string,
    laneId?: string,
  ) {
    if (!operatorKey) throw new Error('GrantsClient: operatorKey is required');
    this.operatorKey = operatorKey;
    this.agentId = agentId;
    this.baseUrl = baseUrl || getBackendUrl();
    this.laneId = laneId;
  }

  async listGrants(query: ListGrantsQuery = {}): Promise<ListGrantsResult> {
    const url = new URL(`${this.baseUrl}/grants`);
    if (query.holderId) url.searchParams.set('holderId', query.holderId);
    if (query.scopeKind) {
      const kinds = Array.isArray(query.scopeKind)
        ? query.scopeKind
        : [query.scopeKind];
      for (const k of kinds) url.searchParams.append('scopeKind', k);
    }
    if (query.scopeId) url.searchParams.set('scopeId', query.scopeId);
    if (query.role) url.searchParams.set('role', query.role);
    if (query.health) url.searchParams.set('health', query.health);
    if (query.cursor) url.searchParams.set('cursor', query.cursor);
    if (query.limit != null) url.searchParams.set('limit', String(query.limit));

    const res = await fetch(url.toString(), {
      headers: buildOperatorHeaders(
        this.operatorKey,
        this.agentId,
        undefined,
        this.laneId,
      ),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throwApiError(res, body, `GrantsClient.listGrants failed: ${res.status}`);
    }
    const parsed = JSON.parse(body) as {
      items?: GrantView[];
      nextCursor?: string | null;
      hasMore?: boolean;
      unreadableRails?: UnreadableRail[];
    };
    return {
      items: parsed.items ?? [],
      nextCursor: parsed.nextCursor ?? null,
      hasMore: parsed.hasMore ?? false,
      ...(parsed.unreadableRails?.length
        ? { unreadableRails: parsed.unreadableRails }
        : {}),
    };
  }

  /**
   * Every grant matching `query`, following the cursor to completion. Use when a
   * caller needs the whole set (reach tagging, catch-up, an owner listing) rather
   * than a single page — `listGrants` returns only one page (server default 30),
   * so a holder with more grants than a page would otherwise be silently
   * truncated. `maxPages` bounds the loop as a runaway guard.
   */
  async listAllGrants(
    query: Omit<ListGrantsQuery, 'cursor'> = {},
    maxPages = 50,
  ): Promise<GrantView[]> {
    return (await this.listAllGrantsWithRails(query, maxPages)).items;
  }

  /**
   * The same sweep, keeping the part `listAllGrants` throws away: which rails the
   * caller was not allowed to read.
   *
   * The distinction is not cosmetic. An empty page from an unreadable rail looks
   * exactly like "you hold no grants", and a caller that cannot tell them apart
   * reports the wrong one: a brokered connector agent with a live grant refused
   * its task and told the buyer to ask for the grant they had just issued, because
   * its key lacked `connections:read` and this method answered "none".
   */
  async listAllGrantsWithRails(
    query: Omit<ListGrantsQuery, 'cursor'> = {},
    maxPages = 50,
  ): Promise<{ items: GrantView[]; unreadableRails: UnreadableRail[] }> {
    const all: GrantView[] = [];
    const rails = new Map<string, UnreadableRail>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.listGrants({ ...query, cursor });
      all.push(...res.items);
      for (const rail of res.unreadableRails ?? []) rails.set(rail.rail, rail);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return { items: all, unreadableRails: [...rails.values()] };
  }
}
