import { isCoverageRefusal } from './apiError.js';
import { presentResourceCall } from '../capabilities/resourceActions.js';
import type { ResourceActionCall } from '../http/ContextOpenClient.js';

/**
 * One refusal shape for MCP, SDK tools, and agent runtimes.
 *
 * classify from the thrown {@link ApiError} fields (`status`,
 * `code`, `body` / `message`). No client-prefix strip, no HTTP-status regex,
 * no re-parsing a JSON body that was concatenated into the message string.
 */

export interface OperationError {
  code: string;
  message: string;
  hint?: string;
  /**
   * What the caller may pick from, when the refusal is a choice: the
   * agreements of WORK_SELECTION_REQUIRED, the workspaces of
   * WORKSPACE_SELECTION_REQUIRED. Carried through verbatim so an assistant can
   * ask its human instead of re-reading the message.
   */
  choices?: unknown[];
  /**
   * The call that is the next step, when the server sent one: the access
   * request of WORK_ACCESS_REQUIRED, ready to send. Carried through verbatim,
   * the same shape an open's action recovery has.
   */
  recovery?: Record<string, unknown>;
  /** Scoped restart position returned when too many observation streams exist. */
  recoveryCursor?: string;
  /** hidden | unreadable, the same outcome open and access_explain give. */
  outcome?: string;
  /** The resource the outcome is about. */
  ref?: { kind: string; id: string };
  /** For an unreadable resource: the request to make, as open lists it. */
  actions?: unknown[];
}

/**
 * The shared refusal vocabulary every read tool answers in (hidden,
 * unreadable, invalid input), so an assistant can branch on the code instead
 * of parsing each tool's sentence.
 */
const SHARED_REFUSALS = new Set(['RESOURCE_HIDDEN', 'RESOURCE_UNREADABLE', 'INVALID_INPUT']);

const SCOPE_DENIED_HINT =
  'For missing access to a returned artifact, chat, agreement, or task, use ' +
  'ziggs_access_request with that original resource id and your purpose. It creates ' +
  'a pending access approval agreement; it grants no access. After approval, ' +
  'ziggs_open the same resource using the same agent identity. For earlier chat ' +
  'messages request temporal=from-start; replying also requires permission=reply. ' +
  'Do not issue yourself a grant. A new room does not show this room\'s history.';

// a human-authority denial is not "try again with more scope": no
// retry by this caller can ever pass it, because the guard refuses on being an
// agent at all, before it looks at what was asked. Without a next action the
// only strategy left is repetition, which is what agents did.
const HUMAN_AUTHORITY_HINT =
  'Ask the account owner to perform this action in their signed-in session. ' +
  'Requesting resource access cannot authorize a human-only operation; retrying as an agent will not change that.';

/**
 * What covers a conversation, refused. These arrive as 429 or 403,
 * and a 429 read as "rate limited" tells an agent to wait and retry, which can
 * never help: the writer has to hire the agent, or their person has to set up
 * the agreement. The backend's own code and sentence are the answer.
 */
const COVERAGE_HINT =
  'Retry only after the condition in this refusal changes. Use the returned recovery call when present. ' +
  'For missing resource permission, ziggs_access_request asks your customer or operator and returns who can approve; ' +
  'funding, ended agreements, and task-only terms require the responsible party to change those terms.';

function codeForStatus(status: number): string {
  if (status === 401) return 'NOT_AUTHENTICATED';
  if (status === 403) return 'NOT_AUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_ERROR';
  if (status >= 400) return 'BAD_REQUEST';
  return 'TOOL_ERROR';
}

/**
 * An `ApiError` from api-client, recognised by shape rather than `instanceof`:
 * a bundled or duplicated copy of the class would fail an identity check while
 * carrying exactly the fields we need.
 */
function thrownFields(err: unknown): {
  message: string;
  status: number | null;
  code: string | null;
  choices: unknown[] | null;
} {
  if (typeof err === 'string') {
    return { message: err, status: null, code: null, choices: null };
  }
  if (typeof err !== 'object' || err === null) {
    return { message: String(err), status: null, code: null, choices: null };
  }
  const o = err as {
    message?: unknown;
    status?: unknown;
    code?: unknown;
    body?: unknown;
  };
  const status =
    typeof o.status === 'number' && o.status >= 100 && o.status < 600
      ? o.status
      : null;
  const code = typeof o.code === 'string' && o.code ? o.code : null;
  const message =
    typeof o.message === 'string' && o.message ? o.message : String(err);
  return { message, status, code, choices: choicesIn(o.body) };
}

/** The `recovery` call of a refusal body, when the server sent one. */
function recoveryIn(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'string' || !body) return null;
  try {
    const parsed = JSON.parse(body) as { recovery?: unknown };
    const recovery = parsed?.recovery;
    if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return null;
    return recovery as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The `choices` list of a refusal body, when the server sent one. */
function choicesIn(body: unknown): unknown[] | null {
  if (typeof body !== 'string' || !body) return null;
  try {
    const parsed = JSON.parse(body) as { choices?: unknown };
    return Array.isArray(parsed?.choices)
      ? parsed.choices
      : null;
  } catch {
    return null;
  }
}

/**
 * Classify a thrown client error (or a plain string this layer raised) into a
 * stable shape on either tool surface.
 */
export function describeOperationError(input: unknown, surface: 'sdk' | 'mcp' = 'sdk'): OperationError {
  input = unwrapApiError(input);
  const shape = classify(input);
  const { choices } = thrownFields(input);
  const recovery =
    typeof input === 'object' && input !== null
      ? recoveryIn((input as { body?: unknown }).body)
      : null;
  let recoveryCursor: string | undefined;
  if (shape.code === 'INBOX_OBSERVATION_LIMIT' && input && typeof input === 'object') {
    try {
      const body = JSON.parse((input as { body?: string }).body ?? '{}') as { recoveryCursor?: unknown };
      if (typeof body.recoveryCursor === 'string' && /^ibxo1_[0-9a-f-]{36}$/.test(body.recoveryCursor)) recoveryCursor = body.recoveryCursor;
    } catch { /* Malformed recovery metadata does not hide the original refusal. */ }
  }
  const result = {
    ...shape,
    ...(recoveryCursor ? { recoveryCursor } : {}),
    ...(choices ? { choices } : {}),
    ...(recovery ? { recovery: typeof recovery.tool === 'string'
      ? { ...presentResourceCall(recovery as unknown as ResourceActionCall, surface) }
      : recovery } : {}),
  };
  if (recovery) delete result.hint;
  if (surface === 'sdk' && result.hint) result.hint = result.hint.replace(/\bziggs_(\w+)/g, '$1');
  return result;
}

function classify(input: unknown): OperationError {
  const { message, status, code: machineCode } = thrownFields(input);

  if (machineCode && SHARED_REFUSALS.has(machineCode)) {
    return { code: machineCode, message };
  }
  if (machineCode === 'AGENT_LACKS_HUMAN_AUTHORITY') {
    return {
      code: 'AGENT_LACKS_HUMAN_AUTHORITY',
      message,
      hint: HUMAN_AUTHORITY_HINT,
    };
  }
  // Can read the agreement, cannot work on it: the server's sentence and its
  // recovery are the answer, and the generic scope hint would send the agent
  // back for the read it already has.
  if (machineCode === 'WORK_ACCESS_REQUIRED') {
    return { code: machineCode, message };
  }
  if (machineCode && isCoverageRefusal(machineCode)) {
    return { code: machineCode, message, hint: COVERAGE_HINT };
  }
  if (machineCode === 'NOT_AUTHORIZED_FOR_SCOPE') {
    return {
      code: 'NOT_AUTHORIZED_FOR_SCOPE',
      message,
      hint: SCOPE_DENIED_HINT,
    };
  }

  // The server owns the decision. A word such as "scope" may mean a token
  // restriction, a resource grant, or a policy boundary; prose cannot tell us
  // which request would authorize it. Preserve every supplied machine code.
  return { code: machineCode ?? (status === null ? 'TOOL_ERROR' : codeForStatus(status)), message };
}


/** Tool runners wrap failures with context. Preserve the original API refusal. */
function unwrapApiError(input: unknown): unknown {
  const seen = new Set<unknown>();
  let current = input;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const row = current as { code?: unknown; status?: unknown; body?: unknown; cause?: unknown };
    if (typeof row.code === 'string' || typeof row.status === 'number' || typeof row.body === 'string') return current;
    current = row.cause;
  }
  return input;
}
