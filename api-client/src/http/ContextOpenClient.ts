import { isRetiredRoomRef, looksLikeHandle, parseRef } from '../handles.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { pollSurfaceError } from '../shared/rateLimit.js';
import { buildOperatorHeaders } from './operatorHeaders.js';

export const CONTEXT_OPEN_KINDS = [
  'artifact',
  'task',
  'agreement',
] as const;
export type ContextOpenKind = (typeof CONTEXT_OPEN_KINDS)[number];

export type ContextOpenOutcome = 'ok' | 'unreadable' | 'hidden';

export interface ContextOpenRef {
  kind: ContextOpenKind;
  id: string;
}

export interface ContextOpenBody {
  /** A handle (T…/A…/F…), a Ziggs URL holding one, or an older id. */
  ref?: string;
  artifactId?: string;
  taskId?: string;
  agreementId?: string;
  cursor?: string;
  after?: string;
  limit?: number;
  /** An HTML page comes as its text; true returns the HTML as written. */
  html?: boolean;
}

/** Backend-evaluated action, scoped to a resource. Never a permission token. */
export interface ResourceActionCall {
  tool: string;
  args: Record<string, unknown>;
  required?: string[];
  unavailableReason?: string;
  approvers?: Array<{ id: string; name: string | null; role: string }>;
}
export interface ResourceAction extends Partial<ResourceActionCall> {
  action: string;
  state: 'available' | 'needs_decision' | 'unavailable' | 'not_evaluated';
  reasonCode?: string;
  reason?: unknown;
  scope?: { kind: string; id: string; agreementId?: string };
  recovery?: ResourceActionCall;
}


export interface ContextOpenAccess {
  summary: string;
  document?: { empty: boolean; extractionStatus?: string | null };
  continuation?: { kind: 'owner_decision'; summary: string; request?: { scopeKind: 'agreement' | 'task'; scopeId: string; permission: 'read'; temporal: 'from-start'; durationHours: number } };
}

export interface ContextOpenResult {
  /** Server-resolved caller; absent on older servers, null for human callers. */
  actingAgentId?: string | null;
  /** Optional for servers predating resource action projections. */
  actions?: ResourceAction[];
  outcome: ContextOpenOutcome;
  ref: ContextOpenRef;
  access: ContextOpenAccess;
  workContext: { executionContextId: string | null };
  page?: {
    type: string;
    via: { kind: string; id: string };
    items: unknown[];
    hasMore: boolean;
    nextCursor: string | null;
    latestSequence?: string | null;
  };
}

export type ContextExplainResult = Omit<ContextOpenResult, 'page'>;

/**
 * Open or explain a returned reference. The server resolves the read path;
 * the caller does not send type, via, or a grant id.
 */
export class ContextOpenClient {
  constructor(
    private readonly operatorKey: string,
    private readonly agentId?: string,
    private readonly baseUrl?: string,
  ) {
    if (!operatorKey) throw new Error('ContextOpenClient: operatorKey is required');
  }

  async open(body: ContextOpenBody): Promise<ContextOpenResult> {
    return this.post<ContextOpenResult>('/context/open', body);
  }

  async explain(body: ContextOpenBody): Promise<ContextExplainResult> {
    return this.post<ContextExplainResult>('/context/access/explain', body);
  }

  private async post<T>(path: string, body: ContextOpenBody): Promise<T> {
    const normalized = normalizeContextOpenBody({ ...body });
    const url = `${this.baseUrl || getBackendUrl()}${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...buildOperatorHeaders(
          this.operatorKey,
          this.agentId,
          { 'Content-Type': 'application/json' },
        ),
      },
      body: JSON.stringify(normalized),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw pollSurfaceError(`ContextOpenClient ${path}`, res, text);
    }
    const result = JSON.parse(text);
    if (result?.ref?.kind === 'address') {
      throw Object.assign(
        new Error('Room references are retired; select an exact artifact, task or agreement'),
        { code: 'INVALID_INPUT' },
      );
    }
    return result as T;
  }
}

export function normalizeContextOpenBody(args: Record<string, unknown>): ContextOpenBody {
  // A mistyped handle is refused here, before any call: its check letter
  // fails. Any other id goes to the server, which knows older shapes.
  const invalid = (message: string) => Object.assign(new Error(message), { code: 'INVALID_INPUT' });
  if ('addressId' in args) throw invalid('addressId is retired; select an exact artifact, task or agreement');
  const keys = ['ref', 'artifactId', 'taskId', 'agreementId'].filter(key => args[key] !== undefined);
  if (keys.length !== 1) throw invalid('Pass exactly one resource reference: ref, artifactId, taskId, or agreementId');
  const key = keys[0]!;
  const raw = typeof args[key] === 'string' ? (args[key] as string).trim() : '';
  if (!raw) throw invalid(`${key} must be a non-empty resource reference`);
  const ref = parseRef(raw);
  if (isRetiredRoomRef(raw)) throw invalid('Room references are retired; select an exact artifact, task or agreement');
  if (!ref && looksLikeHandle(raw)) throw invalid(`${raw} is not a handle: its check letter does not match. Check it for a typo`);
  const body: ContextOpenBody = { [key]: ref?.id ?? raw };
  if (typeof args['cursor'] === 'string') body.cursor = args['cursor'];
  if (typeof args['after'] === 'string') body.after = args['after'];
  if (typeof args['limit'] === 'number') body.limit = args['limit'];
  // A page opens as its text; html: true asks for it as written.
  if (args['html'] === true) body.html = true;
  return body;
}
