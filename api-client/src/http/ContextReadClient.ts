import { getBackendUrl } from '../utils/urlUtils.js';
import { pollSurfaceError } from '../shared/rateLimit.js';
import { buildOperatorHeaders } from './operatorHeaders.js';

export const CONTEXT_READ_TYPES = [
  'messages',
  'artifacts',
  'agreements',
  'tasks',
] as const;
export type ContextReadType = (typeof CONTEXT_READ_TYPES)[number];

/**
 * Entry points a read can name as `via=<kind>:<id>` — the server's `parseVia`
 * grammar. `counterparty` parses but reads nothing: it resolves a scope graph,
 * not content, which is why {@link CONTEXT_READ_VIA} admits it for no type.
 */
export const VIA_KINDS = [
  'chat',
  'agreement',
  'task',
  'counterparty',
  'artifact',
] as const;
export type ViaKind = (typeof VIA_KINDS)[number];

/**
 * Which entry points each read type actually accepts, mirroring the server's
 * `CONTEXT_READ_VIA`. Stated once here so the tool descriptions, the argument
 * check, and this type all read off the same list instead of three prose
 * copies that drift — and so a wrong pairing is refused with the reason rather
 * than as a bare 400 from a round-trip away.
 */
export const CONTEXT_READ_VIA: Record<ContextReadType, readonly ViaKind[]> = {
  messages: ['chat'],
  artifacts: ['chat', 'agreement', 'task', 'artifact'],
  agreements: ['chat', 'agreement'],
  tasks: ['agreement', 'task'],
};

/** `chat:<id>, agreement:<id>` — the accepted entries for one read type, for humans. */
export function viaHint(type: ContextReadType): string {
  return CONTEXT_READ_VIA[type].map((k) => `${k}:<id>`).join(', ');
}

/** Split `chat:abc` into its parts, or null when it is not a `via` at all. */
export function parseVia(via: string): { kind: ViaKind; id: string } | null {
  const at = via.indexOf(':');
  if (at <= 0) return null;
  const kind = via.slice(0, at);
  const id = via.slice(at + 1);
  if (!id) return null;
  return VIA_KINDS.includes(kind as ViaKind)
    ? { kind: kind as ViaKind, id }
    : null;
}

export interface ContextReadQuery {
  agreementId?: string;
  via: string;
  cursor?: string;
  limit?: number;
  after?: string;
  direction?: 'forward' | 'backward';
  state?: string;
  contextGrantId?: string;
}

export interface ContextReadEnvelope<T = unknown> {
  type: ContextReadType;
  via: { kind: ViaKind; id: string };
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
  latestSequence?: string | null;
}

/** Aggregated chat snapshot from `GET /context/snapshot` (follow-up). */
/**
 * One participant on the snapshot roster. `kind` is the declared holder kind the
 * server stamped on the row, so a reader takes what a participant IS from the
 * row rather than from which array it arrived in. Optional so a backend that
 * predates it still parses.
 */
export interface ContextSnapshotParticipant {
  role: string;
  kind?: string;
  isYou?: boolean;
  [key: string]: unknown;
}

export interface ContextSnapshotResult {
  /** Server-resolved orientation; writes recheck authority. */
  workBrief?: Record<string, unknown> & { position?: import('@ziggs-ai/contracts').WorkPositionView };
  work?: Record<string, unknown>;
  history: unknown[];
  agreements: unknown[];
  /** Bounded room inventory, without bodies. Absent on older backends. */
  artifacts?: ContextReadEnvelope<{
    artifactId: string;
    name: string | null;
    contentType: string;
    timestamp: string | null;
  }>;
  /** Direct artifact grants missing from the room inventory. Id and name only. */
  grantedArtifacts?: {
    items: Array<{ artifactId: string; name: string | null; via: string }>;
    omitted: number;
  };
  agents: Array<ContextSnapshotParticipant & { agentId: string }>;
  users: Array<ContextSnapshotParticipant & { userId: string }>;
  latestSequence?: string | null;
  chatMissing?: boolean;
}

/**
 * Protocol-first uniform context reads.
 * Wraps `GET /context/read/:type` — one client, one envelope, four types.
 */
export class ContextReadClient {
  private readonly operatorKey: string;
  private readonly agentId?: string;
  private readonly baseUrl: string;

  /** Authority is supplied by withWorkExecution / withWorkExecutionId. */
  constructor(operatorKey: string, agentId?: string, baseUrl?: string) {
    if (!operatorKey) throw new Error('ContextReadClient: operatorKey is required');
    this.operatorKey = operatorKey;
    this.agentId = agentId;
    this.baseUrl = baseUrl || getBackendUrl();
  }



  async read<T = unknown>(
    type: ContextReadType,
    query: ContextReadQuery,
  ): Promise<ContextReadEnvelope<T>> {
    if (!query.via?.trim()) {
      throw new Error('ContextReadClient.read: via is required');
    }
    const url = new URL(
      `${this.baseUrl}/context/read/${encodeURIComponent(type)}`,
    );
    url.searchParams.set('via', query.via.trim());
    if (query.agreementId) url.searchParams.set('agreementId', query.agreementId);
    if (query.cursor) url.searchParams.set('cursor', query.cursor);
    if (query.limit != null) url.searchParams.set('limit', String(query.limit));
    if (query.after) url.searchParams.set('after', query.after);
    if (query.direction) url.searchParams.set('direction', query.direction);
    if (query.state) url.searchParams.set('state', query.state);
    if (query.contextGrantId) {
      url.searchParams.set('contextGrantId', query.contextGrantId);
    }

    const headers: Record<string, string> = buildOperatorHeaders(
      this.operatorKey,
      this.agentId,
      undefined,
    );
    if (query.contextGrantId) {
      headers['X-Context-Grant-Id'] = query.contextGrantId;
    }

    const res = await fetch(url.toString(), { headers });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      // A 403 here is a legitimate outcome, not a transport failure: addressing
      // and authorisation are separate, so an agent can be told about mail it
      // is not (or is no longer) allowed to open. one ApiError shape
      // (429 → RateLimitedError with Retry-After).
      throw pollSurfaceError(`ContextReadClient.read ${type}`, res, body);
    }
    return JSON.parse(body) as ContextReadEnvelope<T>;
  }

  /**
   * Aggregated chat snapshot — `GET /context/snapshot?via=chat:<id>`. The
   * server composes history + agreements + roster through the same grant-fenced
   * readers as {@link read}, so hosted agents pull one fenced view per poll cycle.
   * Rejects with an `Error & { status }` on non-OK so callers can branch (404).
   */
  async snapshot(
    chatId: string,
    opts: { maxMessages?: number; contextGrantId?: string; agreementId?: string; taskId?: string; artifactId?: string; via?: string } = {},
  ): Promise<ContextSnapshotResult> {
    if (!chatId?.trim()) {
      throw new Error('ContextReadClient.snapshot: chatId is required');
    }
    const url = new URL(`${this.baseUrl}/context/snapshot`);
    url.searchParams.set('via', opts.taskId ? `task:${opts.taskId}` : opts.via ?? (chatId.startsWith('agrn-') ? `agreement:${opts.agreementId ?? chatId.slice(5)}` : `chat:${chatId}`));
    if (opts.agreementId) url.searchParams.set('agreementId', opts.agreementId);
    if (opts.artifactId) url.searchParams.set('artifactId', opts.artifactId);
    if (opts.maxMessages != null) {
      url.searchParams.set('maxMessages', String(opts.maxMessages));
    }
    if (opts.contextGrantId) {
      url.searchParams.set('contextGrantId', opts.contextGrantId);
    }

    const headers: Record<string, string> = buildOperatorHeaders(
      this.operatorKey,
      this.agentId,
      undefined,
    );
    if (opts.contextGrantId) {
      headers['X-Context-Grant-Id'] = opts.contextGrantId;
    }

    const res = await fetch(url.toString(), { headers });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      // ApiError for every non-OK (429 → RateLimitedError).
      throw pollSurfaceError('ContextReadClient.snapshot', res, body);
    }
    return JSON.parse(body) as ContextSnapshotResult;
  }
}
