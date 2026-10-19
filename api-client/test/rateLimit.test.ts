import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/types.js';
import {
  RateLimitedError,
  isRateLimited,
  parseRetryAfterMs,
  pollSurfaceError,
} from '../src/shared/rateLimit.js';

/**
 * ZIG-1019 — a throttled agent used to retry in 1s, and every refused call
 * still counted against the cap, so it kept itself locked out. These lock the
 * two halves of the fix: the server's wait is read off the response, and only
 * a 429 gets that treatment.
 *
 * ZIG-1124 — non-429 poll failures are ApiError (status/body/code), not a
 * plain Error with the status baked into the message text.
 */

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

test('parseRetryAfterMs prefers Retry-After in delta-seconds', () => {
  assert.equal(parseRetryAfterMs(headers({ 'retry-after': '12' })), 12_000);
});

test('parseRetryAfterMs accepts an HTTP-date Retry-After', () => {
  const at = new Date(Date.now() + 20_000).toUTCString();
  const ms = parseRetryAfterMs(headers({ 'retry-after': at }));
  assert.ok(ms !== null && ms > 15_000 && ms <= 21_000, `got ${ms}`);
});

test('parseRetryAfterMs falls back to RateLimit-Reset', () => {
  // What the backend actually sends alongside a 429 (standardHeaders: true).
  assert.equal(parseRetryAfterMs(headers({ 'ratelimit-reset': '26' })), 26_000);
});

test('parseRetryAfterMs is null when the server said nothing', () => {
  assert.equal(parseRetryAfterMs(headers({})), null);
});

test('a zero or negative wait still floors at a second — never a hot retry', () => {
  assert.equal(parseRetryAfterMs(headers({ 'retry-after': '0' })), 1_000);
  assert.equal(parseRetryAfterMs(headers({ 'ratelimit-reset': '-5' })), 1_000);
});

test('an absurd wait is capped rather than parking the loop', () => {
  assert.equal(parseRetryAfterMs(headers({ 'retry-after': '99999' })), 120_000);
});

test('pollSurfaceError returns a RateLimitedError carrying the wait for a 429', () => {
  const body = '{"error":"Polling rate limit exceeded."}';
  const err = pollSurfaceError(
    'InboxClient.getInbox',
    { status: 429, headers: headers({ 'ratelimit-reset': '26' }) },
    body,
  );
  assert.ok(err instanceof RateLimitedError);
  assert.ok(err instanceof ApiError);
  assert.equal(err.retryAfterMs, 26_000);
  assert.equal(err.status, 429);
  assert.equal(err.body, body);
  assert.equal(err.message, 'Polling rate limit exceeded.');
  assert.ok(isRateLimited(err));
});

test('pollSurfaceError returns ApiError for non-429 statuses', () => {
  const body = '{"error":"Access denied"}';
  const err = pollSurfaceError(
    'InboxClient.getInbox',
    { status: 403, headers: headers({}) },
    body,
  );
  assert.ok(err instanceof ApiError);
  assert.ok(!(err instanceof RateLimitedError));
  assert.equal(err.status, 403);
  assert.equal(err.body, body);
  assert.equal(err.message, 'Access denied');
  assert.equal(isRateLimited(err), false);
});

test('a 429 with no headers is still recognised, with no wait to honour', () => {
  const err = pollSurfaceError(
    'ContextReadClient.read messages',
    { status: 429, headers: headers({}) },
    '',
  );
  assert.ok(isRateLimited(err));
  assert.equal((err as RateLimitedError).retryAfterMs, null);
});

test('a coverage refusal on the poll surface keeps its code and is not a rate limit', () => {
  const sentence = 'The agreement covering this conversation is no longer active.';
  const body = JSON.stringify({
    error: sentence,
    code: 'CONVERSATION_COVERAGE_ENDED',
  });
  const err = pollSurfaceError(
    'ContextReadClient.read messages',
    { status: 429, headers: headers({ 'retry-after': '8' }) },
    body,
  );
  assert.ok(err instanceof ApiError);
  assert.ok(!(err instanceof RateLimitedError));
  assert.equal(err.code, 'CONVERSATION_COVERAGE_ENDED');
  assert.equal(err.message, sentence);
  assert.equal(isRateLimited(err), false);
});

test('a plain ApiError(429) without retryAfterMs is not isRateLimited', () => {
  // ZIG-1124: only RateLimitedError (or duck-typed wait field) counts — a bare
  // status 429 used to pass isRateLimited and leave consumers with undefined wait.
  assert.equal(isRateLimited(new ApiError('slow', 429)), false);
});
