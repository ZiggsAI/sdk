import { ApiError, RateLimitedError } from '../types.js';
import {
  isCoverageRefusal,
  parseErrorCode,
  parseErrorMessage,
  parseRetryAfterMs,
} from './apiError.js';

/**
 * a 429 is not a generic failure, it is an instruction with a
 * deadline attached.
 *
 * The poll surface (`/inbox`, `/context/read`) is capped per actor, and every
 * refused call still counts against that cap. A caller that retries on the
 * usual exponential ladder (1s, 2s, 4s…) therefore spends its way deeper into
 * the hole: observed live as an agent that could not read the conversation it
 * had just been woken for, because its own retries kept the bucket empty.
 *
 * The server already says exactly how long to wait — `Retry-After`, or
 * `RateLimit-Reset` from the standard headers. These helpers carry that number
 * to whoever is doing the backing off.
 *
 * {@link RateLimitedError} extends {@link ApiError}; non-429 poll
 * failures are ApiError too (same shape as {@link throwApiError}).
 */

export { RateLimitedError, parseRetryAfterMs };

/** True for a 429 that carries a wait field — survives structured clones. */
export function isRateLimited(
  err: unknown,
): err is { retryAfterMs: number | null; status: number } {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { status?: number }).status === 429 &&
    'retryAfterMs' in err
  );
}

/**
 * Build the error for a failed poll-surface response. Same shape as
 * {@link throwApiError}: ApiError with status/body/code, or RateLimitedError
 * when the server said 429.
 */
export function pollSurfaceError(
  label: string,
  res: { status: number; headers: { get(name: string): string | null } },
  body: string,
): ApiError {
  const message = parseErrorMessage(body, `${label} failed: ${res.status}`);
  const code = parseErrorCode(body);
  if (res.status === 429 && !isCoverageRefusal(code)) {
    return new RateLimitedError(
      message,
      parseRetryAfterMs(res.headers),
      body,
      code,
    );
  }
  return new ApiError(message, res.status, body, code);
}
