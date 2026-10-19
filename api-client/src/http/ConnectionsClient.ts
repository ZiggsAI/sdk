import { decodeOperatorKeyClaims } from '../shared/operatorKey.js';
import { getBackendUrl } from "../utils/urlUtils.js";
import { throwApiError } from "../shared/apiError.js";
import { buildOperatorHeaders } from "./operatorHeaders.js";
import { GrantsClient } from "./GrantsClient.js";
import type { GrantView } from "./grants.js";

// defense-in-depth mirror of the backend leak-guard
// (assertProxyResponseDoesNotLeakTokens). The backend strips the *specific*
// vault token from the response; clients never see that token, so this layer
// instead pattern-scans the proxied body for high-signal provider credential
// shapes and refuses to hand a likely-leaked secret to the model.
const LEAKED_SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[posru]_[A-Za-z0-9]{16,}\b/, // GitHub PAT / OAuth / user / server / refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, // fine-grained GitHub PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack bot/user/app/refresh tokens
  /\bxapp-[A-Za-z0-9-]{10,}\b/, // Slack app-level token
  /"(?:access_token|refresh_token)"\s*:\s*"[^"]{8,}"/, // raw OAuth token JSON keys
];

export function assertNoLeakedConnectionSecret(serialized: string): void {
  for (const re of LEAKED_SECRET_PATTERNS) {
    if (re.test(serialized)) {
      throw new Error(
        "connection proxy response withheld: it appears to contain a credential (token-leak guard)",
      );
    }
  }
}

/** Thrown by ConnectionsClient with the HTTP status and raw body attached. */
export interface ConnectionsError extends Error {
  status?: number;
  body?: string;
}

export interface ConnectionProxyParams {
  connectionId: string;
  grantId: string;
  action: string;
  payload?: unknown;
}

/** A grant row from the per-connection lister (GET /connections/:id/grants). */
export interface ConnectionGrant {
  grantId?: string;
  holderId?: string;
  caveats?: unknown[];
  [key: string]: unknown;
}

/**
 * every connection grant the acting agent holds, grouped by
 * connection, via the unified GET /grants. `provider` comes from the grant's
 * resolved scope label.
 */
export interface ConnectionWithGrants {
  connectionId: string;
  provider: string | null;
  grants: GrantView[];
}

export interface McpConnectionRequestParams {
  serverUrl: string;
  tools: string[];
  reason?: string;
  /**
   * Who to ask, from the people the server offers this wake (the work brief's
   * `actingFor.customer.id` / `.operator.id`). Required by the server; the
   * per-user relay may send it as `onBehalfOfUserId` instead.
   */
  recipientId?: string;
  /**
   * Working chat the consent card is opened into. Required by the backend for
   * the agent-tool path; the per-user gateway trigger omits it.
   */
  chatId?: string;
  /**
   * Target the consent request at this end-user (X-On-Behalf-Of-User) instead
   * of the operator — the per-user MCP gateway's connect prompt.
   */
  onBehalfOfUserId?: string;
}

/**
 * the one connections client for every surface. Consolidates the
 * former agent-sdk private ZiggsConnectClient and ziggs-mcp's inline fetches
 * (proxy, requestMcpConnection). Proxied provider calls never
 * return the raw OAuth token; every proxy response is additionally scanned by
 * the client-side leak guard before it reaches the caller. Grant *listing*
 * across connections is the unified GET /grants; the per-connection grant
 * mutations (issue / attenuate / revoke) live here.
 */
export class ConnectionsClient {
  private readonly operatorKey: string;
  private readonly agentId?: string;
  private readonly baseUrl: string;
  private readonly laneId?: string;

  /**
   * @param laneId the wake's lane (a chat id, or `agrn-<agreementId>`), sent as
   *   X-Ziggs-Lane. It tells the broker which hire this wake is in, and the
   *   broker reads off it WHO the agent is acting for: an agent that serves
   *   several hirers holds all of their grants at once and is the holder of
   *   every one, so without a lane one hirer's grant is indistinguishable from
   *   another's, and a grant one customer gave can be spent while working for
   *   somebody else.
   *   ArtifactsClient sends the same header for the same reason.
   */
  constructor(
    operatorKey: string,
    agentId?: string,
    baseUrl?: string,
    laneId?: string,
  ) {
    if (!operatorKey)
      throw new Error("ConnectionsClient: operatorKey is required");
    this.operatorKey = operatorKey;
    this.agentId = agentId;
    this.baseUrl = baseUrl || getBackendUrl();
    this.laneId = laneId;
  }

  /**
   * Present a ConnectionGrant to the broker and perform a provider action.
   * Returns the provider result — never the raw OAuth token. Requires an
   * impersonated agent (the grant holder).
   */
  async proxy({
    connectionId,
    grantId,
    action,
    payload,
  }: ConnectionProxyParams): Promise<unknown> {
    if (!connectionId) throw new Error("proxy: connectionId is required");
    if (!grantId) throw new Error("proxy: grantId is required");
    if (!action) throw new Error("proxy: action is required");
    if (!this.agentId && !decodeOperatorKeyClaims(this.operatorKey)?.connectionClientId) {
      throw new Error(
        "proxy: agentId is required — connection broker calls must impersonate the grant holder agent",
      );
    }
    const text = await this._requestRaw(
      "POST",
      `/connections/${encodeURIComponent(connectionId)}/proxy`,
      { grantId, action, payload: payload ?? {} },
    );
    assertNoLeakedConnectionSecret(text);
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const result = (parsed as Record<string, unknown> | null)?.["result"];
    return result ?? parsed;
  }

  /**
   * List ConnectionGrants on a connection. When impersonating an agent the
   * server already scopes rows to that holder; the client-side filter is kept
   * as defense-in-depth (same behavior as the former ZiggsConnectClient).
   */
  async listGrants({
    connectionId,
  }: {
    connectionId: string;
  }): Promise<ConnectionGrant[]> {
    if (!connectionId) throw new Error("listGrants: connectionId is required");
    if (!this.agentId && !decodeOperatorKeyClaims(this.operatorKey)?.connectionClientId) {
      throw new Error(
        "listGrants: agentId is required — grants are scoped to the impersonated agent",
      );
    }
    const res = (await this._request(
      "GET",
      `/connections/${encodeURIComponent(connectionId)}/grants`,
      undefined,
    )) as Record<string, unknown>;
    const grants = (res["grants"] as ConnectionGrant[]) || [];
    return this.agentId ? grants.filter((g) => g["holderId"] === this.agentId) : grants;
  }

  /**
   * cross-connection discovery over the unified GET /grants:
   * every live connection grant this agent holds, grouped by connection, so a
   * proxy caller's connectionId/grantId no longer has to arrive out of band.
   * Moved here from ziggs-mcp's inline helper. The response is scanned
   * defensively for leaked secrets, as `proxy` does.
   */
  async listForHolder(): Promise<ConnectionWithGrants[]> {
    const grantsClient = new GrantsClient(
      this.operatorKey,
      this.agentId,
      this.baseUrl,
      this.laneId,
    );
    // All pages of the agent's live connection grants (not just the first page).
    const { items, unreadableRails } =
      await grantsClient.listAllGrantsWithRails({
        scopeKind: "connection",
        health: "active",
      });
    // An unreadable rail is not an empty one. Returning [] here made
    // every caller say "no connection grant" when the truth was "this key may not
    // look" — the needs gate refused work the agent could do, and the MCP tool
    // told the owner to issue a grant that already existed. Throwing puts the
    // missing scope in the message, where the person who can fix it will read it.
    const railBlocked = unreadableRails.find((r) => r.rail === "connection");
    if (railBlocked && items.length === 0) {
      throw new Error(
        `Cannot read this agent's connection grants: the operator key is missing the ` +
          `"${railBlocked.requiredScope}" scope, so the grant list came back empty whether or not ` +
          'a grant exists. Re-mint the key with that scope (the "launcher-mcp-broker" preset includes it).',
      );
    }
    const byConnection = new Map<string, ConnectionWithGrants>();
    for (const g of items) {
      const connectionId = g.scope.id;
      let group = byConnection.get(connectionId);
      if (!group) {
        group = { connectionId, provider: g.scope.label ?? null, grants: [] };
        byConnection.set(connectionId, group);
      }
      group.grants.push(g);
    }
    const result = [...byConnection.values()];
    assertNoLeakedConnectionSecret(JSON.stringify(result));
    return result;
  }

  /** Issue a connection grant to an agent holder (connection owner side). */
  async issueGrant({
    connectionId,
    holderId,
    caveats,
  }: {
    connectionId: string;
    holderId: string;
    caveats?: unknown;
  }): Promise<unknown> {
    if (!connectionId) throw new Error("issueGrant: connectionId is required");
    if (!holderId) throw new Error("issueGrant: holderId is required");
    return this._request(
      "POST",
      `/connections/${encodeURIComponent(connectionId)}/grants`,
      {
        holderId,
        caveats,
      },
    );
  }

  /**
   * Attenuate (re-delegate) a connection grant with tighter caveats. Narrowing
   * a grant whose connection you own mints immediately; a grant whose owner is
   * a different party returns `{ status: 'pending_approval', agreementId }`
   * (consent flow) and no grant is minted yet.
   */
  async attenuateGrant({
    connectionId,
    grantId,
    holderId,
    caveats,
  }: {
    connectionId: string;
    grantId: string;
    holderId: string;
    caveats?: unknown;
  }): Promise<unknown> {
    if (!connectionId)
      throw new Error("attenuateGrant: connectionId is required");
    if (!grantId) throw new Error("attenuateGrant: grantId is required");
    if (!holderId) throw new Error("attenuateGrant: holderId is required");
    return this._request(
      "POST",
      `/connections/${encodeURIComponent(connectionId)}/grants/${encodeURIComponent(grantId)}/attenuate`,
      { holderId, caveats },
    );
  }

  /** Revoke a single connection grant. */
  async revokeGrant({
    connectionId,
    grantId,
  }: {
    connectionId: string;
    grantId: string;
  }): Promise<unknown> {
    if (!connectionId) throw new Error("revokeGrant: connectionId is required");
    if (!grantId) throw new Error("revokeGrant: grantId is required");
    return this._request(
      "DELETE",
      `/connections/${encodeURIComponent(connectionId)}/grants/${encodeURIComponent(grantId)}`,
      undefined,
    );
  }

  /**
   * agent-initiated MCP connection request: ask the principal to
   * connect a remote MCP server and grant this agent the listed tools. Opens a
   * connection-consent agreement in the working chat; on approval the
   * server is connected (if needed) and the agent is granted the tools.
   */
  async requestMcpConnection({
    serverUrl,
    tools,
    reason,
    chatId,
    recipientId,
    onBehalfOfUserId,
  }: McpConnectionRequestParams): Promise<Record<string, unknown>> {
    if (!serverUrl)
      throw new Error("requestMcpConnection: serverUrl is required");
    return (await this._request(
      "POST",
      "/connections/mcp/requests",
      { serverUrl, tools, reason, chatId, ...(recipientId ? { recipientId } : {}) },
      onBehalfOfUserId
        ? { "X-On-Behalf-Of-User": onBehalfOfUserId }
        : undefined,
    )) as Record<string, unknown>;
  }

  private async _requestRaw(
    method: string,
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<string> {
    const init: RequestInit = {
      method,
      headers: buildOperatorHeaders(
        this.operatorKey,
        this.agentId,
        {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...extraHeaders,
        },
        this.laneId,
      ),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      // ApiError (status/body/code); ConnectionsError remains the
      // documented duck type for callers that branch on `.status`.
      throwApiError(
        response,
        text,
        `${method} ${path} failed: ${response.status}`,
      );
    }
    return text;
  }

  private async _request(
    method: string,
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const text = await this._requestRaw(method, path, body, extraHeaders);
    return text ? JSON.parse(text) : null;
  }
}
