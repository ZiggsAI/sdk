import { getBackendUrl } from '../utils/urlUtils.js';
import { pollSurfaceError } from '../shared/rateLimit.js';
import { buildOperatorHeaders } from './operatorHeaders.js';

/** Matches GET /context/callers — holders, workspaces, session, owned agents. */
export type CallerContextView = {
  principalId: string;
  activeOrgId: string | null;
  holders: Array<Record<string, unknown>>;
  preJoinWorkspaces: Array<Record<string, unknown>>;
  session: { user: Record<string, unknown> | null };
  workspaces: { orgs: unknown[]; activeOrgId: string | null };
  ownedAgents: { agents: unknown[] };
};

/**
 * One read of who the caller counts as: tree holders, session, workspaces,
 * owned agents. Same payload the web app shell uses.
 */
export class CallerContextClient {
  constructor(
    private readonly operatorKey: string,
    private readonly agentId?: string,
    private readonly baseUrl?: string,
  ) {
    if (!operatorKey) throw new Error('CallerContextClient: operatorKey is required');
  }

  async getCallers(): Promise<CallerContextView> {
    const url = `${this.baseUrl || getBackendUrl()}/context/callers`;
    const res = await fetch(url, {
      method: 'GET',
      headers: buildOperatorHeaders(this.operatorKey, this.agentId),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw pollSurfaceError('CallerContextClient GET /context/callers', res, text);
    }
    return JSON.parse(text) as CallerContextView;
  }
}