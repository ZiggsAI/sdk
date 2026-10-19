import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyToolError, toolError } from '../src/toolError.js';

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
    readonly code?: string | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const shapeOf = (input: unknown) =>
  JSON.parse(toolError(input).content[0].text).error as {
    code: string;
    message: string;
    hint?: string;
  };

describe('toolError (ZIG-667 / ZIG-1124)', () => {
  it('maps a 403 scope denial from ApiError fields, not message scraping', () => {
    const shape = classifyToolError(
      new FakeApiError('not authorized for this scope', 403, undefined, 'NOT_AUTHORIZED_FOR_SCOPE'),
    );
    assert.equal(shape.code, 'NOT_AUTHORIZED_FOR_SCOPE');
    assert.equal(shape.message, 'not authorized for this scope');
    assert.match(shape.hint ?? '', /ziggs_access_request/);
    assert.match(shape.hint ?? '', /does not show this room's history/);
    assert.doesNotMatch(shape.hint ?? '', /replacement conversation/);
    assert.doesNotMatch(shape.hint ?? '', /ziggs_context_issue_grant|ziggs_link_propose/);
  });

  /**
   * ZIG-1088 — a human-authority denial refuses the caller for BEING an agent,
   * before it reads what was asked, so "ask for a grant on this scope" is the
   * wrong advice and no retry can pass. Prefer the backend machine code
   * (HUMAN_AUTHORITY_ERROR_CODE) when ApiError carries it (ZIG-1124).
   */
  it('gives a human-authority denial its own code from err.code, not prose', () => {
    const shape = classifyToolError(
      new FakeApiError(
        "An impersonated agent cannot perform this action (context:grant:issue); " +
          "it requires the account owner's authority. Use grant " +
          "delegation or request the owner's approval instead.",
        403,
        undefined,
        'AGENT_LACKS_HUMAN_AUTHORITY',
      ),
    );
    assert.equal(shape.code, 'AGENT_LACKS_HUMAN_AUTHORITY');
    assert.match(shape.hint ?? '', /account owner/);
    assert.match(shape.hint ?? '', /cannot authorize a human-only operation/);
    assert.doesNotMatch(shape.hint ?? '', /ziggs_context_delegate|ziggs_artifact_share|ziggs_access_request/);
    assert.doesNotMatch(shape.hint ?? '', /ziggs_link_propose/);
  });

  it('keeps non-scope 403s generic — no context-domain hint for connection denials', () => {
    const shape = classifyToolError(new FakeApiError('Grant invalid', 403));
    assert.equal(shape.code, 'NOT_AUTHORIZED');
    assert.equal(shape.message, 'Grant invalid');
    assert.equal(shape.hint, undefined);
  });

  it('maps other HTTP statuses to stable codes from err.status', () => {
    assert.equal(classifyToolError(new FakeApiError('not found', 404)).code, 'NOT_FOUND');
    assert.equal(classifyToolError(new FakeApiError('already linked', 409)).code, 'CONFLICT');
    assert.equal(classifyToolError(new FakeApiError('upstream exploded', 500)).code, 'UPSTREAM_ERROR');
    assert.equal(classifyToolError(new FakeApiError('expired', 401)).code, 'NOT_AUTHENTICATED');
  });

  it('passes through non-HTTP errors as TOOL_ERROR with the original message', () => {
    const shape = classifyToolError(
      'confirm must be true — org switch changes which workspace you act in',
    );
    assert.equal(shape.code, 'TOOL_ERROR');
    assert.match(shape.message, /confirm must be true/);
  });

  it('emits a parseable MCP error result', () => {
    const result = toolError(
      new FakeApiError('not authorized for this scope', 403),
    );
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text) as {
      error: { code: string; message: string; hint?: string };
    };
    assert.equal(parsed.error.code, 'NOT_AUTHORIZED');
    assert.deepEqual(result.structuredContent, parsed);
  });
});

/**
 * ZIG-1086: the recovery hint existed but fired by accident. Callers used to
 * pass `err.message` and drop `ApiError.status`. ZIG-1124 deletes the message
 * scrape entirely — status and code are fields on the thrown error.
 */
describe('toolError reads thrown status and code (ZIG-1086 / ZIG-1124)', () => {
  it('a token scope denial does not invent a resource-access recovery', () => {
    const shape = shapeOf(new FakeApiError('missing scope: context:admin', 403));
    assert.equal(shape.code, 'NOT_AUTHORIZED');
    assert.equal(shape.hint, undefined);
  });

  it('classifies by real status for every rail, not just scope denials', () => {
    assert.equal(shapeOf(new FakeApiError('Not Found', 404)).code, 'NOT_FOUND');
    assert.equal(shapeOf(new FakeApiError('slow down', 429)).code, 'RATE_LIMITED');
    assert.equal(shapeOf(new FakeApiError('boom', 503)).code, 'UPSTREAM_ERROR');
  });

  it('a non-scope 403 stays generic even with a known status', () => {
    const shape = shapeOf(new FakeApiError('Grant invalid', 403));
    assert.equal(shape.code, 'NOT_AUTHORIZED');
    assert.equal(shape.hint, undefined);
  });

  it('still accepts a plain string for refusals this layer raises itself', () => {
    const shape = shapeOf('Task not found: tsk_1');
    assert.equal(shape.code, 'TOOL_ERROR');
    assert.equal(shape.message, 'Task not found: tsk_1');
  });

  it('a thrown non-ApiError keeps its message and stays untyped', () => {
    const shape = shapeOf(new Error('socket hang up'));
    assert.equal(shape.code, 'TOOL_ERROR');
    assert.equal(shape.message, 'socket hang up');
  });

  it('prefers err.code over status+prose for human-authority', () => {
    // Message alone would classify as a scope denial; machine code must win
    // so agents do not get the "ask for a grant" hint (ZIG-1124).
    const shape = shapeOf(
      new FakeApiError(
        'not authorized for this scope',
        403,
        undefined,
        'AGENT_LACKS_HUMAN_AUTHORITY',
      ),
    );
    assert.equal(shape.code, 'AGENT_LACKS_HUMAN_AUTHORITY');
    assert.doesNotMatch(shape.hint ?? '', /ziggs_link_propose/);
  });

  // ZIG-1998 — a stranger out of free messages is asked to hire, not to wait.
  it('keeps a coverage refusal as itself, not a rate limit', () => {
    const exhausted = shapeOf(
      new FakeApiError(
        'You have used your 3 free messages with seo-growth. Hire it to keep talking.',
        429,
        undefined,
        'CONVERSATION_ALLOWANCE_EXHAUSTED',
      ),
    );
    assert.equal(exhausted.code, 'CONVERSATION_ALLOWANCE_EXHAUSTED');
    assert.match(exhausted.message, /Hire it to keep talking/);
    assert.match(exhausted.hint ?? '', /Retry only after the condition/);
    const paused = shapeOf(
      new FakeApiError('paused', 403, undefined, 'LISTING_PAUSED'),
    );
    assert.equal(paused.code, 'LISTING_PAUSED');
    // A real rate limit is still one.
    assert.equal(
      shapeOf(new FakeApiError('slow down', 429, undefined, 'RATE_LIMITED'))
        .code,
      'RATE_LIMITED',
    );
  });

  it('carries the ready request of a can-read, cannot-work refusal', () => {
    const recovery = {
      tool: 'access_request',
      args: {
        scopeKind: 'agreement',
        scopeId: 'agr_1',
        permission: 'work',
        recipientId: 'usr_1',
      },
      required: ['reason'],
    };
    const shape = classifyToolError(
      new FakeApiError(
        'agent_2 can read agreement agr_1 but cannot work on it',
        403,
        JSON.stringify({
          error: 'agent_2 can read agreement agr_1 but cannot work on it',
          code: 'WORK_ACCESS_REQUIRED',
          recovery,
        }),
        'WORK_ACCESS_REQUIRED',
      ),
    );
    assert.equal(shape.code, 'WORK_ACCESS_REQUIRED');
    assert.equal(shape.hint, undefined);
    assert.deepEqual(shape.recovery, {
      ...recovery,
      tool: 'ziggs_access_request',
    });
    // A body without one adds nothing.
    assert.equal(
      classifyToolError(new FakeApiError('no', 403, '{"error":"no"}'))
        .recovery,
      undefined,
    );
  });
});
