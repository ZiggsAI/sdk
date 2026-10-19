import { isMcpOAuthDelegateSession } from '../shared/operatorKey.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';
import { buildOperatorHeaders } from './operatorHeaders.js';
import type { Creds } from '../types.js';

export interface MyOrg {
  orgId: string;
  name: string;
  kind: string;
  role?: string;
}

/**
 * the operator's full org membership (not just granted
 * scopes, which is all the grant listers see). Lets a delegate resolve an org
 * name to an id and offer a pick-list instead of demanding a pasted org_.. id.
 * Moved here from ziggs-mcp so every surface rides the one client.
 */
export async function fetchMyOrgs(creds: Creds, baseUrl?: string): Promise<MyOrg[]> {
  const url = `${baseUrl || getBackendUrl()}/orgs/me`;
  const res = await fetch(url, {
    method: 'GET',
    headers: buildOperatorHeaders(creds.operatorKey, creds.agentId),
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    throwApiError(res, body, `GET /orgs/me failed: ${res.status}`);
  }
  const parsed = body ? (JSON.parse(body) as { orgs?: MyOrg[] }) : {};
  return (parsed.orgs ?? []).map((o) => ({
    orgId: o.orgId,
    name: o.name,
    kind: o.kind,
    role: o.role,
  }));
}

export type OrgResolution =
  | { status: 'ok'; orgId: string }
  | { status: 'ambiguous'; matches: MyOrg[] }
  | { status: 'not-found' };

/**
 * resolve an org selector (exact org_.. id OR a name/handle) against
 * the operator's memberships. Exact id wins; otherwise case-insensitive name
 * match. Ambiguous names return the candidates rather than guessing.
 */
export function resolveOrgSelector(orgs: MyOrg[], selector: string): OrgResolution {
  const byId = orgs.find((o) => o.orgId === selector);
  if (byId) return { status: 'ok', orgId: byId.orgId };
  const needle = selector.toLowerCase();
  const byName = orgs.filter((o) => o.name.toLowerCase() === needle);
  if (byName.length === 1) return { status: 'ok', orgId: byName[0].orgId };
  if (byName.length > 1) return { status: 'ambiguous', matches: byName };
  return { status: 'not-found' };
}

/**
 * runtime acting org from the server (self-hire / agent
 * row): GET /agents/delegate/access. Moved here from ziggs-mcp's inline
 * fetch ( "one client for every surface").
 *
 * Only valid for MCP OAuth Claude-delegate sessions. Hosted / fleet
 * impersonation must use {@link fetchHostedAgentAccess}.
 */
export async function fetchDelegateAccess(
  creds: Creds,
  baseUrl?: string,
): Promise<Record<string, unknown>> {
  const url = `${baseUrl || getBackendUrl()}/agents/delegate/access`;
  const res = await fetch(url, {
    method: 'GET',
    headers: buildOperatorHeaders(creds.operatorKey, creds.agentId),
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    throwApiError(
      res,
      body,
      `GET /agents/delegate/access failed: ${res.status}`,
    );
  }
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

/**
 * session access for hosted / fleet impersonation (owner key +
 * X-Agent-Id, or an agent-scoped key that is not a Claude OAuth delegate).
 *
 * `GET /agents/delegate/access` refuses those credentials (or reports
 * disconnected), even though every other tool works. The credential's tenant
 * is already on the actor (`GET /orgs/me` → `activeOrgId`).
 */
export async function fetchHostedAgentAccess(
  creds: Creds,
  baseUrl?: string,
): Promise<Record<string, unknown>> {
  const url = `${baseUrl || getBackendUrl()}/orgs/me`;
  const res = await fetch(url, {
    method: 'GET',
    headers: buildOperatorHeaders(creds.operatorKey, creds.agentId),
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    throwApiError(res, body, `GET /orgs/me failed: ${res.status}`);
  }
  const parsed = body
    ? (JSON.parse(body) as {
        orgs?: MyOrg[];
        activeOrgId?: string | null;
        activeOrg?: { orgId?: string; name?: string; kind?: string } | null;
      })
    : {};
  const activeOrgId =
    typeof parsed.activeOrgId === 'string' && parsed.activeOrgId
      ? parsed.activeOrgId
      : null;
  const match = (parsed.orgs ?? []).find((o) => o.orgId === activeOrgId);
  // Prefer `activeOrg` — membership list often omits the agent home
  // org under fleet impersonation.
  const fromActive = parsed.activeOrg;
  const orgName =
    (typeof fromActive?.name === 'string' && fromActive.name) ||
    match?.name ||
    null;
  const orgKind =
    (typeof fromActive?.kind === 'string' && fromActive.kind) ||
    match?.kind ||
    null;
  return {
    connected: true,
    orgId: activeOrgId,
    orgName,
    orgKind,
  };
}

/**
 * pick the access reader that matches the acting agent.
 * Claude OAuth delegates → self-hire status; everything else → hosted path.
 */
export async function fetchSessionAccess(
  creds: Creds,
  baseUrl?: string,
): Promise<Record<string, unknown>> {
  if (isMcpOAuthDelegateSession(creds)) {
    return fetchDelegateAccess(creds, baseUrl);
  }
  return fetchHostedAgentAccess(creds, baseUrl);
}
