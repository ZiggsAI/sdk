import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';
import { buildOperatorHeaders } from './operatorHeaders.js';

/**
 * Labels-only pointer to context the agent could request access to (P4).
 * covers chats, agreements, and connections; connection labels are the
 * provider name only (never tokens/account labels).
 */
export interface DiscoverableItem {
  type: 'chat' | 'agreement' | 'connection';
  label: string;
  scopeRef: { kind: 'chat' | 'agreement' | 'org' | 'connection'; id: string };
  orgId: string;
}

/**
 * P4 discovery — labels-only pointers to context the agent could REQUEST but
 * does not yet hold (`GET /context/discovery/available`). Grants the agent
 * already holds are listed via the unified `GrantsClient` (GET /grants).
 */
export class ContextDiscoveryClient {
  private readonly operatorKey: string;
  private readonly agentId?: string;
  private readonly baseUrl: string;

  /**
   * @param operatorKey Agent-scoped or fleet operator key.
   * @param agentId Required for fleet keys (sent as X-Agent-Id). Omit for agent-scoped keys.
   */
  constructor(operatorKey: string, agentId?: string, baseUrl?: string) {
    if (!operatorKey) {
      throw new Error('ContextDiscoveryClient: operatorKey is required');
    }
    this.operatorKey = operatorKey;
    this.agentId = agentId;
    this.baseUrl = baseUrl || getBackendUrl();
  }

  /**
   * P4: what context EXISTS in the agent's engaged orgs that it does NOT hold
   * a grant for — so it can request access rather than fail blind. Labels only.
   * Defensively re-shapes each row to the whitelist (type/label/scopeRef/orgId)
   * so an over-broad server response can never leak content/tokens through here.
   */
  async discoverGrantable(): Promise<DiscoverableItem[]> {
    const res = await fetch(`${this.baseUrl}/context/discovery/available`, {
      headers: buildOperatorHeaders(this.operatorKey, this.agentId),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throwApiError(
        res,
        body,
        `ContextDiscoveryClient.discoverGrantable failed: ${res.status}`,
      );
    }
    const parsed = JSON.parse(body) as { items?: DiscoverableItem[] };
    return (parsed.items ?? []).map((i) => ({
      type: i.type,
      label: i.label,
      scopeRef: { kind: i.scopeRef.kind, id: i.scopeRef.id },
      orgId: i.orgId,
    }));
  }
}
