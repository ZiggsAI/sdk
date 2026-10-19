import { ApiError, RateLimitedError } from '../types.js';

/**
 * Read the message out of a Ziggs error response.
 *
 * The API answers every failure in one shape — `{ error: "<what went wrong>" }`,
 * plus `code` when the server supplied a machine-readable one — because one global
 * exception filter builds it (backend `common/http-exception.filter.ts`, pinned in
 * `common/error-response.spec.ts`). So `error` is read first and is normally the
 * whole answer.
 *
 * `message` and `details` remain as fallbacks for responses that did NOT come from
 * that filter: a proxy, a gateway, or a Nest-shaped body from some other service.
 * On a Nest-shaped body `error` holds the reason phrase ("Bad Request") while
 * `message` holds the real cause, so when both are present the more specific one
 * wins — that ordering is why this lives in ONE place. It used to be copy-pasted
 * into five clients, two of which had been fixed for it and three of which had not,
 * so the same failure read differently depending on which client you called.
 */
export function parseErrorMessage(
  responseBody: string,
  defaultMessage: string,
): string {
  if (!responseBody) return defaultMessage;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    // Not JSON at all — an HTML error page or a bare string is still better than
    // nothing, so hand back what the server actually said.
    return responseBody || defaultMessage;
  }
  // Valid JSON that is not an object: a quoted string IS the message; anything
  // else (null, a number) carries no message, and echoing its raw text would put
  // "null" in front of a caller.
  if (typeof parsed !== 'object' || parsed === null) {
    return typeof parsed === 'string' && parsed ? parsed : defaultMessage;
  }
  const body = parsed as Record<string, unknown>;

  const text = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
      const joined = value.map(String).filter(Boolean).join('; ');
      return joined || undefined;
    }
    return typeof value === 'string' && value ? value : undefined;
  };

  const error = text(body['error']);
  const message = text(body['message']);
  // A Nest-shaped body carries both: prefer the specific `message` over the
  // reason phrase sitting in `error`.
  const preferMessage = !!message && !!body['statusCode'];

  return (
    text(body['details']) ??
    (preferMessage ? message : (error ?? message)) ??
    defaultMessage
  );
}

/** Machine code from `{ error, code }` when the filter (or thrower) supplied one. */
export function parseErrorCode(responseBody: string): string | null {
  if (!responseBody) return null;
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const code = (parsed as Record<string, unknown>)['code'];
    return typeof code === 'string' && code ? code : null;
  } catch {
    return null;
  }
}

const MAX_RETRY_AFTER_MS = 120_000;

/**
 * Read the wait out of a 429 response. `Retry-After` wins (it is the explicit
 * one) and is accepted in both forms — delta-seconds or an HTTP date;
 * `RateLimit-Reset` is the standard-headers fallback, in seconds. Capped so a
 * bad header cannot park a loop for an hour, floored at a second so a `0` does
 * not reproduce the hot-retry it is meant to stop.
 *
 * Lives next to {@link throwApiError} so every client path (not only the poll
 * surface) can honour the server's number.
 */
export function parseRetryAfterMs(headers: {
  get(name: string): string | null;
}): number | null {
  const explicit = headers.get('retry-after');
  if (explicit) {
    const seconds = Number(explicit);
    if (Number.isFinite(seconds)) return clampRetryMs(seconds * 1000);
    const at = Date.parse(explicit);
    if (!Number.isNaN(at)) return clampRetryMs(at - Date.now());
  }
  const reset = headers.get('ratelimit-reset');
  if (reset) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds)) return clampRetryMs(seconds * 1000);
  }
  return null;
}

function clampRetryMs(ms: number): number {
  if (!Number.isFinite(ms)) return 1_000;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, Math.round(ms)));
}

/**
 * Coverage refusals name themselves. A 429 with one of these codes is not a
 * wait-and-retry: the writer has to hire, or someone has to set the agreement
 * up. The backend answers them as 403; this keeps a stale 429 from becoming a
 * rate limit too.
 */
const COVERAGE_REFUSALS = new Set([
  'CONVERSATION_ALLOWANCE_EXHAUSTED',
  'CONTACT_POLICY_REFUSED',
  'LISTING_PAUSED',
  'CONVERSATION_COVERAGE_REQUIRED',
  'CONVERSATION_COVERAGE_ENDED',
  'CONVERSATION_NOT_FUNDED',
  'CONVERSATION_SPONSORSHIP_REQUIRED',
  'TASK_ONLY_AGENT',
]);

export function isCoverageRefusal(code: string | null | undefined): boolean {
  return !!code && COVERAGE_REFUSALS.has(code);
}

/**
 * Throw the parsed failure as an {@link ApiError} (or {@link RateLimitedError}
 * for a 429 that is not a coverage refusal), preserving status, body, machine
 * code, and Retry-After.
 */
export function throwApiError(
  response: { status: number; headers?: { get(name: string): string | null } },
  responseBody: string,
  defaultMessage: string,
): never {
  const message = parseErrorMessage(responseBody, defaultMessage);
  const code = parseErrorCode(responseBody);
  if (response.status === 429 && !isCoverageRefusal(code)) {
    throw new RateLimitedError(
      message,
      response.headers ? parseRetryAfterMs(response.headers) : null,
      responseBody,
      code,
    );
  }
  throw new ApiError(message, response.status, responseBody, code);
}
