import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, RateLimitedError } from '../src/types.js';
import {
  parseErrorCode,
  parseErrorMessage,
  throwApiError,
} from '../src/shared/apiError.js';

/**
 * One reader for the one shape the API answers in.
 *
 * This was copy-pasted into six clients. Two copies had been fixed to prefer the
 * specific `message` over a Nest reason phrase and four had not, so the same
 * backend failure surfaced as "art_x is agent-private" through one client and
 * "Bad Request" through another.
 */
test('reads the Ziggs shape: the message lives in `error`', () => {
  assert.equal(
    parseErrorMessage(
      JSON.stringify({ error: 'Artifact art_x is agent-private' }),
      'fallback',
    ),
    'Artifact art_x is agent-private',
  );
});

test('carries a code-bearing body by its message, not its code', () => {
  assert.equal(
    parseErrorMessage(
      JSON.stringify({ error: 'connect first', code: 'NO_USER_CONNECTION' }),
      'fallback',
    ),
    'connect first',
  );
});

// A body from something that is NOT behind our exception filter — a proxy, or
// another Nest service. There, `error` is the reason phrase and `message` is the
// cause, so the cause has to win.
test('prefers `message` over the reason phrase on a Nest-shaped body', () => {
  assert.equal(
    parseErrorMessage(
      JSON.stringify({
        statusCode: 400,
        message: 'price must be a positive number',
        error: 'Bad Request',
      }),
      'fallback',
    ),
    'price must be a positive number',
  );
});

test('joins a validation array into one line', () => {
  assert.equal(
    parseErrorMessage(
      JSON.stringify({
        statusCode: 400,
        message: ['text must be a string', 'holderId should not be empty'],
        error: 'Bad Request',
      }),
      'fallback',
    ),
    'text must be a string; holderId should not be empty',
  );
});

test('`details` still wins when a surface sends it', () => {
  assert.equal(
    parseErrorMessage(
      JSON.stringify({ details: 'upstream said no', error: 'nope' }),
      'fallback',
    ),
    'upstream said no',
  );
});

test('falls back to the raw body when it is not JSON', () => {
  assert.equal(
    parseErrorMessage('<html>502 Bad Gateway</html>', 'fallback'),
    '<html>502 Bad Gateway</html>',
  );
});

test('falls back to the default for an empty or contentless body', () => {
  assert.equal(parseErrorMessage('', 'fallback'), 'fallback');
  assert.equal(parseErrorMessage(JSON.stringify({}), 'fallback'), 'fallback');
  // Valid JSON carrying no message: never echo its raw text, or the caller reads
  // "null" as the reason.
  assert.equal(parseErrorMessage(JSON.stringify(null), 'fallback'), 'fallback');
  assert.equal(parseErrorMessage('123', 'fallback'), 'fallback');
});

test('treats a quoted JSON string body as the message', () => {
  assert.equal(
    parseErrorMessage(JSON.stringify('grant expired'), 'fallback'),
    'grant expired',
  );
});

test('ignores empty strings and empty arrays rather than returning them', () => {
  assert.equal(
    parseErrorMessage(JSON.stringify({ error: '', message: [] }), 'fallback'),
    'fallback',
  );
});

test('throwApiError keeps the status, raw body, and machine code on the error', () => {
  const body = JSON.stringify({
    error: 'Artifact art_x not found',
    code: 'ARTIFACT_NOT_FOUND',
  });
  try {
    throwApiError({ status: 404 }, body, 'fallback');
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof ApiError);
    assert.equal(e.message, 'Artifact art_x not found');
    assert.equal(e.status, 404);
    assert.equal(e.body, body);
    assert.equal(e.code, 'ARTIFACT_NOT_FOUND');
  }
});

test('parseErrorCode reads the machine code and ignores a missing one', () => {
  assert.equal(
    parseErrorCode(JSON.stringify({ error: 'nope', code: 'NO_USER_CONNECTION' })),
    'NO_USER_CONNECTION',
  );
  assert.equal(parseErrorCode(JSON.stringify({ error: 'nope' })), null);
  assert.equal(parseErrorCode('not-json'), null);
});

test('throwApiError turns a 429 into RateLimitedError with Retry-After', () => {
  const body = JSON.stringify({ error: 'slow down' });
  try {
    throwApiError(
      {
        status: 429,
        headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? '8' : null) },
      },
      body,
      'fallback',
    );
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof RateLimitedError);
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterMs, 8_000);
    assert.equal(e.message, 'slow down');
    assert.equal(e.body, body);
  }
});

test('a coverage refusal keeps its code and sentence and is not a rate limit', () => {
  const sentence =
    "You have used the 3 free messages this agent's contact setting allows with seo-growth. Hire it to keep talking.";
  const body = JSON.stringify({
    error: sentence,
    code: 'CONVERSATION_ALLOWANCE_EXHAUSTED',
  });
  for (const status of [403, 429]) {
    try {
      throwApiError({ status, headers: { get: () => '8' } }, body, 'fallback');
      assert.fail('expected a throw');
    } catch (e) {
      assert.ok(e instanceof ApiError);
      assert.ok(!(e instanceof RateLimitedError));
      assert.equal(e.status, status);
      assert.equal(e.code, 'CONVERSATION_ALLOWANCE_EXHAUSTED');
      assert.equal(e.message, sentence);
    }
  }
});
