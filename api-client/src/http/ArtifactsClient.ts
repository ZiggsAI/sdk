import type { WriteSource } from '../capabilities/sources.js';
import type { ListReachableArtifactsResult } from '@ziggs-ai/contracts';
import { runtimeLog } from '../shared/runtimeLog.js';
import { throwApiError } from '../shared/apiError.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { buildOperatorHeaders } from './operatorHeaders.js';

/**
 * Inline `POST /artifacts` body cap (matches backend
 * `ARTIFACT_PUBLIC_TEXT_MAX_CHARS`). Over this → file rail or multi-part; the
 * server does not auto-split.
 */
export const ARTIFACT_INLINE_TEXT_MAX_CHARS = 50_000;

/** Named escape hatch for agents that hit the inline cap. */
export const ARTIFACT_INLINE_TEXT_OVER_LIMIT_HINT =
  `text exceeds ${ARTIFACT_INLINE_TEXT_MAX_CHARS} characters. ` +
  'For larger content use ziggs_artifact_upload_url (file rail), or split into ' +
  'an index artifact plus part artifacts and list the part ids in the index. ' +
  'The server does not auto-split.';

export type ArtifactVisibility = 'chat' | 'agent-private';

export interface ListArtifactsOptions {
  after?: string;
  limit?: number;
}

export interface ListArtifactsQuery {
  chatId?: string;
  agreementId?: string;
  taskId?: string;
  serviceAgreementId?: string;
  /**
   * `'me'` lists artifacts YOU authored, in any scope or none. The
   * only listing that surfaces a free-standing artifact, since the others read
   * attach tables. Mutually exclusive with the scope filters.
   */
  authoredBy?: 'me';
}

/**
 * The reachable-artifact listing, as the server sends it.
 *
 * `truncated` was missing here, and it is the field that says the answer is
 * incomplete — a caller typed against the old shape could not see that some
 * sources were dropped, which is the same "short list read as a whole one"
 * failure the grants rail names `unreadableRails` for. `artifacts` is also
 * typed now, where it was `unknown[]`.
 */
export type ListArtifactsResult = ListReachableArtifactsResult;

/**
 * What `GET /artifacts/find` actually looked at.
 *
 * The whole reason the route is separate from the listing: a short answer from
 * a search is ambiguous — nothing matched, or nothing was searched? Everything
 * here exists so a caller can tell those apart without knowing anything about
 * how artifacts are stored or which grants it holds. `completeness: 'complete'`
 * means the query ran over the named arms with none cut short; it never means
 * the artifact is not somewhere else in Ziggs.
 */
export interface FindArtifactsCoverage {
  method: 'lexical';
  /** The fields the query ran against — not the fields an artifact has. */
  searchedFields: string[];
  /** Reach arms that produced the candidate set, with their sizes. */
  arms: Record<string, number>;
  /** Arms that hit their cap, so older rows in them were never searched. */
  truncatedArms: string[];
  completeness: 'complete' | 'partial' | 'unknown';
  limitations: string[];
  hasMore: boolean;
  nextCursor: string | null;
}

export type FindArtifactsResult = ListReachableArtifactsResult & {
  coverage: FindArtifactsCoverage;
};

export interface FindArtifactsOptions {
  limit?: number;
  /** Opaque `nextCursor` from a previous page, passed back verbatim. */
  before?: string;
}

export interface WriteArtifactInput {
  text: string;
  /** Short list name. An upload defaults to filename when omitted. */
  name?: string;
  contentType?: string;
  visibility?: ArtifactVisibility;
  /** When the artifact is associated with a chat. */
  chatId?: string;
  /** When the artifact is associated with an agreement. */
  agreementId?: string;
  /** Optional task binding — creates a TaskArtifactLink alongside the primary scope link. */
  taskId?: string;
  serviceAgreementId?: string;
  service?: Record<string, unknown>;
  /**
   * Optional idempotency key. A redelivered write with the same key (same
   * sender) no-ops server-side and returns the original artifact. Derive it
   * deterministically from durable inputs so a stateless crash-replay
   * reproduces it.
   */
  idempotencyKey?: string;
  /**
   * When the deliverable lives outside Ziggs: both provider and http(s) URL.
   * The `text` is the in-Ziggs summary. Ziggs does not fetch the URL.
   */
  externalRef?: ArtifactExternalRef;
  /** What this text drew on. See {@link WriteSource}. */
  sources?: WriteSource[];
}

/** Every file format the server stores — the contracts list, re-exported under the names callers already use. */
export { ARTIFACT_FILE_FORMATS, type ArtifactExternalRef, type ArtifactFileFormat } from '@ziggs-ai/contracts';

export interface ArtifactUploadUrlInput {
  /** Short list name. Defaults to filename on the server when omitted. */
  name?: string;
  filename: string;
  mime: string;
  /** Exact UTF-8 / file byte length of the object that will be PUT. */
  byteSize: number;
  format?: ArtifactFileFormat;
  visibility?: ArtifactVisibility;
  chatId?: string;
  agreementId?: string;
  taskId?: string;
  serviceAgreementId?: string;
  service?: Record<string, unknown>;
  idempotencyKey?: string;
  /**
   * Optional raw bytes. When set, the client PUTs to the presigned URL and
   * returns `checksum` for {@link ArtifactsClient.completeFile}.
   */
  content?: Uint8Array | Buffer;
  /** Optional base64 of the same bytes as `content`. */
  contentBase64?: string;
}

export interface ArtifactUploadUrlResult {
  artifactId: string;
  uploadUrl: string;
  expiresAt: string;
  storageKey: string;
  /** Set when this client performed the S3 PUT. */
  putOk?: boolean;
  /** sha256 hex when content was supplied and PUT succeeded. */
  checksum?: string;
}

export type ArtifactFileView = Record<string, unknown> & {
  artifactId?: string;
  extractionStatus?: string | null;
  extractionError?: string | null;
  filename?: string | null;
};

function resolveUploadBytes(
  input: ArtifactUploadUrlInput,
): Buffer | null {
  if (input.content != null) {
    return Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content);
  }
  if (input.contentBase64 != null && input.contentBase64 !== '') {
    return Buffer.from(input.contentBase64, 'base64');
  }
  return null;
}

/**
 * Replaces `ContextReader`'s artifact reads + `ContextWriter`'s breadcrumb
 * writes. `visibility: 'agent-private'` is the new home for agent thoughts —
 * they persist, are searchable, but are not visible to other chat parties.
 */
/**
 * turn a runtime lane id into a scope the backend can accept.
 *
 * A task with no origin chat runs on the lane `agrn-<agreementId>` (see
 * Agent.laneSessionIdForTask). That is a routing key, not a chat: no such
 * chat row exists, so passing it as `chatId` made every breadcrumb and recorded
 * thought on an agreement lane come back 403 "not authorized for this scope" —
 * a fictional scope reading like an auth failure. The work is agreement-scoped,
 * so say so; same rule settled for deliverables.
 */
import { agreementIdFromLane } from '@ziggs-ai/contracts';
import type { ArtifactExternalRef, ArtifactFileFormat } from '@ziggs-ai/contracts';
export { AGREEMENT_LANE_PREFIX } from '@ziggs-ai/contracts';

export function artifactScopeForSession(
  sessionId: string,
): { chatId: string } | { agreementId: string } {
  const agreementId = agreementIdFromLane(sessionId);
  if (agreementId) return { agreementId };
  return { chatId: sessionId };
}

export class ArtifactsClient {
  private readonly operatorKey: string;
  private readonly agentId?: string;

  /** Authority is supplied by withWorkExecution / withWorkExecutionId. */
  constructor(operatorKey: string, agentId?: string) {
    if (!operatorKey) throw new Error('ArtifactsClient: operatorKey is required');
    this.operatorKey = operatorKey;
    this.agentId = agentId;
  }

  async list(
    q: ListArtifactsQuery,
    opts: ListArtifactsOptions = {},
  ): Promise<ListArtifactsResult> {
    const selectors = [q.chatId, q.agreementId, q.taskId, q.authoredBy].filter(
      Boolean,
    );
    if (selectors.length !== 1) {
      throw new Error(
        'ArtifactsClient.list: pass exactly one of chatId, agreementId, taskId, or authoredBy',
      );
    }
    const url = new URL(`${getBackendUrl()}/artifacts`);
    if (q.chatId) url.searchParams.set('chatId', q.chatId);
    if (q.agreementId) url.searchParams.set('agreementId', q.agreementId);
    if (q.taskId) url.searchParams.set('taskId', q.taskId);
    if (q.authoredBy) url.searchParams.set('authoredBy', q.authoredBy);
    if (opts.after) url.searchParams.set('after', opts.after);
    if (opts.limit != null) url.searchParams.set('limit', String(opts.limit));
    const res = await fetch(url.toString(), { headers: this._headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throwApiError(
        res,
        body,
        `listArtifacts failed: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as ListArtifactsResult;
  }

  /**
   * `GET /artifacts/find` — lexical search over the artifacts this agent can
   * already reach: what it authored, what its readable containers hold, and
   * what artifact grants it holds. Bounded by the active lane and shared-room
   * containment, exactly as a point read is.
   *
   * This is not `list()` with a query string. `list()` answers "what is in this
   * container"; a person's cross-container view lives behind `reach` arms that
   * an agent has no business asking for. The server refuses `reach`,
   * `authoredBy` and `chatId` here rather than ignoring them, so a narrowing
   * filter can never be silently dropped — hence no options for them.
   *
   * The result always carries `coverage`. An empty `artifacts` is a statement
   * about what was searched, not about the world.
   */
  async find(
    query: string,
    opts: FindArtifactsOptions = {},
  ): Promise<FindArtifactsResult> {
    const q = query?.trim();
    if (!q) {
      throw new Error(
        'ArtifactsClient.find: a query is required — find searches what you can reach, it does not list it',
      );
    }
    const url = new URL(`${getBackendUrl()}/artifacts/find`);
    url.searchParams.set('q', q);
    if (opts.limit != null) url.searchParams.set('limit', String(opts.limit));
    if (opts.before) url.searchParams.set('before', opts.before);
    const res = await fetch(url.toString(), { headers: this._headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throwApiError(
        res,
        body,
        `findArtifacts failed: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as FindArtifactsResult;
  }

  /**
   * Record an agent thought as an `agent-private` artifact. Replaces the
   * `ContextWriter.recordEvent({ kind: 'thought' })` hack.
   *
   * Note: the artifact write endpoint lives in the existing chat/agreement
   * write paths; this helper is the SDK contract. Until the backend write
   * endpoint is updated to accept `visibility`, this falls back to logging
   * locally (operators can still wire their own sink).
   */
  async recordThought(
    sessionId: string,
    text: string,
    opts: { idempotencyKey?: string; serviceAgreementId?: string } = {},
  ): Promise<void> {
    // `sessionId` may be an agreement lane, which is not a chat.
    return this.write({
      ...artifactScopeForSession(sessionId),
      text,
      contentType: 'thought',
      visibility: 'agent-private',
      idempotencyKey: opts.idempotencyKey,
      serviceAgreementId: opts.serviceAgreementId,
    });
  }

  async write(input: WriteArtifactInput): Promise<void> {
    if (!input.text || !input.text.trim()) return;
    this._assertScopeXor(input);
    try {
      await this.writeStrict(input);
    } catch (e) {
      // Soft-fail on the wire only: breadcrumb writes are not load-bearing.
      // Caller mistakes (scope xor, empty text) still throw above.
      runtimeLog.warn('ArtifactsClient', `⚠️ ${(e as Error).message}`);
    }
  }

  /**
   * the deliberate-record variant: a deliverable the model chose to
   * record must fail loudly and hand back the artifactId, unlike `write`'s
   * soft-fail breadcrumb contract. This is the one wire call for both agent
   * surfaces (the SDK artifact_record tool and ziggs-mcp's
   * ziggs_artifact_record).
   */
  async writeStrict(input: WriteArtifactInput): Promise<{ artifactId?: string }> {
    if (!input.text || !input.text.trim()) {
      throw new Error('ArtifactsClient.writeStrict: text is required');
    }
    this._assertScopeXor(input);
    const text = input.text.trim();
    // Refuse before the wire so MCP/SDK get a named escape hatch
    // instead of a bare class-validator string.
    if (text.length > ARTIFACT_INLINE_TEXT_MAX_CHARS) {
      throw new Error(
        `ArtifactsClient.writeStrict: ${ARTIFACT_INLINE_TEXT_OVER_LIMIT_HINT}`,
      );
    }
    const url = `${getBackendUrl()}/artifacts`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        text,
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        contentType: input.contentType ?? 'text',
        visibility: input.visibility ?? 'chat',
        chatId: input.chatId,
        agreementId: input.agreementId,
        taskId: input.taskId,
        serviceAgreementId: input.serviceAgreementId,
        service: input.service,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.externalRef
          ? { externalRef: input.externalRef }
          : {}),
        ...(input.sources ? { sources: input.sources } : {}),
      }),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throwApiError(
        res,
        body,
        `recordArtifact failed: ${res.status} ${res.statusText}`,
      );
    }
    try {
      const parsed = body ? (JSON.parse(body) as { artifactId?: string }) : {};
      return { artifactId: parsed.artifactId };
    } catch {
      return {};
    }
  }

  /**
   * attach an existing artifact to a chat, a task, or an agreement.
   *
   * Attaching confers nothing on its own: it places the artifact inside the
   * container, and that container's audience (chat members / task or agreement
   * parties) can read it from then on. This is how a free-standing artifact
   * reaches anyone without granting it to one specific agent.
   */
  async attachToChat(
    artifactId: string,
    chatId: string,
  ): Promise<{ success: boolean }> {
    return this._attach(`/chats/${encodeURIComponent(chatId)}/artifacts`, {
      artifactId,
    });
  }

  async attachToTask(
    artifactId: string,
    taskId: string,
    role: 'input' | 'output' = 'output',
  ): Promise<{ success: boolean }> {
    return this._attach(`/tasks/${encodeURIComponent(taskId)}/artifacts`, {
      artifactId,
      role,
    });
  }

  async attachToAgreement(
    artifactId: string,
    agreementId: string,
  ): Promise<{ success: boolean }> {
    return this._attach(
      `/agreements/${encodeURIComponent(agreementId)}/artifacts`,
      { artifactId },
    );
  }

  /**
   * File artifact rail — presign PUT, then client uploads bytes to `uploadUrl`,
   * then {@link completeFile}. Optional `content` / `contentBase64` performs the
   * S3 PUT here and returns a sha256 so complete can follow immediately.
   */
  async uploadUrl(input: ArtifactUploadUrlInput): Promise<ArtifactUploadUrlResult> {
    if (!input.filename?.trim()) {
      throw new Error('ArtifactsClient.uploadUrl: filename is required');
    }
    if (!input.mime?.trim()) {
      throw new Error('ArtifactsClient.uploadUrl: mime is required');
    }
    if (!Number.isInteger(input.byteSize) || input.byteSize < 1) {
      throw new Error('ArtifactsClient.uploadUrl: byteSize must be a positive integer');
    }
    this._assertScopeXor({
      text: '.',
      chatId: input.chatId,
      agreementId: input.agreementId,
    });

    const bytes = resolveUploadBytes(input);
    if (bytes && bytes.byteLength !== input.byteSize) {
      throw new Error(
        `ArtifactsClient.uploadUrl: byteSize ${input.byteSize} does not match content length ${bytes.byteLength}`,
      );
    }

    const parsed = await this._post<ArtifactUploadUrlResult>(
      '/artifacts/upload-url',
      {
        filename: input.filename.trim(),
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        mime: input.mime.trim(),
        byteSize: input.byteSize,
        format: input.format,
        visibility: input.visibility,
        chatId: input.chatId,
        agreementId: input.agreementId,
        taskId: input.taskId,
        serviceAgreementId: input.serviceAgreementId,
        service: input.service,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      },
      'artifact upload-url',
    );
    if (!parsed.artifactId || !parsed.uploadUrl) {
      throw new Error('artifact upload-url response missing artifactId/uploadUrl');
    }

    if (bytes) {
      const put = await fetch(parsed.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': input.mime.trim() },
        // Blob/Uint8Array — Buffer is not always a DOM BodyInit under tsc DOM libs.
        body: new Uint8Array(bytes),
      });
      if (!put.ok) {
        const putBody = await put.text().catch(() => '');
        throw new Error(
          `S3 PUT failed: ${put.status} ${put.statusText}${putBody ? ` — ${putBody.slice(0, 200)}` : ''}`,
        );
      }
      const { createHash } = await import('node:crypto');
      parsed.checksum = createHash('sha256').update(bytes).digest('hex');
      parsed.putOk = true;
    }
    return parsed;
  }

  async completeFile(
    artifactId: string,
    checksum: string,
  ): Promise<ArtifactFileView> {
    if (!artifactId) throw new Error('ArtifactsClient.completeFile: artifactId is required');
    if (!/^[a-f0-9]{64}$/i.test(checksum)) {
      throw new Error('ArtifactsClient.completeFile: checksum must be sha256 hex');
    }
    return this._post<ArtifactFileView>(
      `/artifacts/${encodeURIComponent(artifactId)}/complete`,
      { checksum: checksum.toLowerCase() },
      'artifact complete',
    );
  }

  async download(
    artifactId: string,
  ): Promise<{ downloadUrl: string; expiresAt: string; filename: string }> {
    if (!artifactId) throw new Error('ArtifactsClient.download: artifactId is required');
    const parsed = await this._get<{
      downloadUrl?: string;
      expiresAt?: string;
      filename?: string;
    }>(
      `/artifacts/${encodeURIComponent(artifactId)}/download`,
      'artifact download',
    );
    if (!parsed.downloadUrl || !parsed.expiresAt || !parsed.filename) {
      throw new Error('artifact download response incomplete');
    }
    return {
      downloadUrl: parsed.downloadUrl,
      expiresAt: parsed.expiresAt,
      filename: parsed.filename,
    };
  }

  async reExtract(artifactId: string): Promise<ArtifactFileView> {
    if (!artifactId) throw new Error('ArtifactsClient.reExtract: artifactId is required');
    return this._post<ArtifactFileView>(
      `/artifacts/${encodeURIComponent(artifactId)}/re-extract`,
      {},
      'artifact re-extract',
    );
  }

  /** shared fetch → text → throwApiError → JSON parse for file rail. */
  private async _post<T extends object>(
    path: string,
    body: Record<string, unknown>,
    label: string,
  ): Promise<T> {
    const res = await fetch(`${getBackendUrl()}${path}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throwApiError(
        res,
        text,
        `${label} failed: ${res.status} ${res.statusText}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async _get<T extends object>(
    path: string,
    label: string,
  ): Promise<T> {
    const res = await fetch(`${getBackendUrl()}${path}`, {
      headers: this._headers(),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throwApiError(
        res,
        text,
        `${label} failed: ${res.status} ${res.statusText}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async _attach(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ success: boolean }> {
    await this._post(path, body, 'attachArtifact');
    return { success: true };
  }

  /**
   * at most one container, and none is fine.
   *
   * This used to demand exactly one, which is what made a deliverable fail at the
   * last step when the model had not worked out which container it was standing
   * in. A write with no scope is now a free-standing artifact; `taskId` alone
   * binds it to a task. Both containers at once is still a mistake worth naming,
   * since only one of them would take effect.
   */
  private _assertScopeXor(input: WriteArtifactInput): void {
    if (input.chatId && input.agreementId) {
      // the refusal names the recovery, because this is the one gate
      // for every caller — the exposed tool surfaces inherit it rather than each
      // wording their own. Wording matters: this fires at the last step of a
      // finished task, where a bare "pick one" leaves the deliverable unfiled.
      throw new Error(
        'pass at most one of chatId or agreementId — a deliverable under an ' +
          'agreement wants agreementId alone (its parties see it); use chatId ' +
          'only for a chat-scoped note. To put it in both places, record it ' +
          'with agreementId, then attach it to the chat.',
      );
    }
  }

  private _headers(): Record<string, string> {
    return buildOperatorHeaders(
      this.operatorKey,
      this.agentId,
      { 'content-type': 'application/json' },
    );
  }
}
