import { runtimeLog } from '../shared/runtimeLog.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { buildOperatorHeaders } from './operatorHeaders.js';

export interface AgentSearchOptions {
  limit?: number;
  minScore?: number;
}

export interface AgentSearchResult {
  success: boolean;
  agents?: AgentProfile[];
  /**
   * Teammates whose name matched, as people to message. Their agents are not
   * listed: someone else's agent is reached through the person it answers for.
   */
  people?: AgentSearchPerson[];
  error?: string;
  message?: string;
}

export interface AgentSearchPerson {
  userId: string;
  displayName: string;
}

export interface AgentProfile {
  agentId: string;
  name: string;
  description?: string;
  tags?: string[];
  matchScore?: number;
  status?: 'online' | 'available' | 'offline';
  /**
   * how the caller can reach this row, derived per row (never a
   * hardcoded label). `restricted` = an exact-id lookup matched an unpublished
   * agent the caller cannot reach — the id is echoed but no name is disclosed.
   */
  reachability?: 'published' | 'same-org' | 'linked' | 'managed' | 'restricted';
  reliability?: {
    sampleSize: number;
    band: string;
    medianResponseMs: number;
    lastActivityDaysAgo: number;
  };
  category?: string;
  version?: string;
}

export class AgentSearchClient {
  private readonly operatorKey: string;
  private readonly agentId?: string;
  private readonly baseUrl: string;

  /**
   * @param operatorKey Agent-scoped or fleet operator key.
   * @param agentId Required for fleet keys (sent as X-Agent-Id). Omit for agent-scoped keys.
   */
  constructor(operatorKey: string, agentId?: string) {
    if (!operatorKey) throw new Error('AgentSearchClient: operatorKey is required');
    this.operatorKey = operatorKey;
    this.agentId = agentId;
    this.baseUrl = getBackendUrl();
  }

  async searchAgents(query: string, options: AgentSearchOptions = {}): Promise<AgentSearchResult> {
    if (!query || typeof query !== 'string') {
      return { success: false, error: 'query is required' };
    }
    const params = new URLSearchParams({ q: query });
    if (typeof options.limit === 'number') params.set('limit', String(options.limit));
    if (typeof options.minScore === 'number') params.set('minScore', String(options.minScore));

    const url = `${this.baseUrl}/agents/search?${params}`;
    try {
      const response = await fetch(url, { method: 'GET', headers: this._buildHeaders() });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        runtimeLog.warn(
          'AgentSearchClient',
          `⚠️ searchAgents failed agent=${this.agentId} ${response.status} ${response.statusText} url=${url} body=${errorText.slice(0, 200)}`,
        );
        return { success: false, error: `Search failed: ${response.status}`, message: errorText };
      }
      const { results = [], people = [] } = await response.json() as {
        results?: AgentProfile[];
        people?: AgentSearchPerson[];
      };
      return { success: true, agents: results, people };
    } catch (error) {
      runtimeLog.warn(
        'AgentSearchClient',
        `⚠️ searchAgents error agent=${this.agentId} url=${url} message=${(error as Error).message}`,
      );
      return { success: false, error: (error as Error).message || 'Failed to search agents' };
    }
  }

  async getAgentById(agentId: string): Promise<AgentSearchResult & Partial<AgentProfile>> {
    if (!agentId) return { success: false, error: 'agentId is required' };
    const url = `${this.baseUrl}/agents/${encodeURIComponent(agentId)}`;
    try {
      const response = await fetch(url, { method: 'GET', headers: this._buildHeaders() });
      if (response.status === 404) {
        runtimeLog.warn(
          'AgentSearchClient',
          `⚠️ getAgentById 404 agent=${this.agentId} target=${agentId} url=${url}`,
        );
        return { success: false, error: 'agent not found' };
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        runtimeLog.warn(
          'AgentSearchClient',
          `⚠️ getAgentById failed agent=${this.agentId} target=${agentId} ${response.status} ${response.statusText} body=${body.slice(0, 200)}`,
        );
        return { success: false, error: `Failed to get agent details: ${response.status}` };
      }
      const agent = await response.json() as AgentProfile;
      return { success: true, ...agent };
    } catch (error) {
      runtimeLog.warn(
        'AgentSearchClient',
        `⚠️ getAgentById error agent=${this.agentId} target=${agentId} url=${url} message=${(error as Error).message}`,
      );
      return { success: false, error: (error as Error).message || 'Failed to get agent details' };
    }
  }

  private _buildHeaders(): Record<string, string> {
    return buildOperatorHeaders(this.operatorKey, this.agentId, {
      'Content-Type': 'application/json',
    });
  }
}
