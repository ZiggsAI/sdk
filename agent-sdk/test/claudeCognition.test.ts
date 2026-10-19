/**
 * ZIG-777: the shared Claude-cognition kernel — the lockdown query-options
 * factory and the event→prompt helpers that ClaudeBrain builds on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeQueryOptions,
  buildClaudeEventPrompt,
  summarizeContext,
  extractAssistantText,
  resolveClaudeModel,
} from '../src/brain/claudeCognition.js';
import type { RawEvent } from '../src/runtime/buildOutcome.js';
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type SDKAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk';

const base = {
  systemPrompt: ['PROTOCOL', 'ROLE'],
  model: 'claude-x',
  mcpServers: { ziggs: {} as never },
  maxTurns: 7,
};

describe('claudeQueryOptions (ZIG-777)', () => {
  it('applies the fixed lockdown option set', () => {
    const o = claudeQueryOptions(base);
    // ToolSearch is the one built-in: it loads deferred Ziggs tools (ZIG-2116).
    assert.deepEqual(o.tools, ['ToolSearch']);
    assert.equal(o.strictMcpConfig, true);
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.permissionMode, 'bypassPermissions');
    assert.equal(o.allowDangerouslySkipPermissions, true);
    assert.equal(o.maxTurns, 7);
    assert.deepEqual(o.systemPrompt, ['PROTOCOL', 'ROLE', SYSTEM_PROMPT_DYNAMIC_BOUNDARY]);
    assert.equal(o.model, 'claude-x');
  });

  // ZIG-788: caching is a prefix match, so these two properties are the whole
  // feature — the shared protocol has to come first for its prefix to be
  // reachable across agents, and nothing may sit after the boundary or it
  // lands outside the cached span.
  it('puts the shared protocol block first, ahead of the per-agent role', () => {
    const blocks = claudeQueryOptions(base).systemPrompt as string[];
    assert.equal(blocks[0], 'PROTOCOL');
    assert.equal(blocks[1], 'ROLE');
  });

  it('ends on the boundary, so the whole prompt is inside the cached prefix', () => {
    const blocks = claudeQueryOptions(base).systemPrompt as string[];
    assert.equal(blocks.at(-1), SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    assert.equal(
      blocks.filter((b) => b === SYSTEM_PROMPT_DYNAMIC_BOUNDARY).length,
      1,
    );
  });

  it('omits resume unless provided', () => {
    assert.equal('resume' in claudeQueryOptions(base), false);
    assert.equal(claudeQueryOptions({ ...base, resume: 'sess-9' }).resume, 'sess-9');
  });

  it('defaults cwd to $CLAUDE_SDK_CWD or /tmp, and honors an explicit cwd', () => {
    assert.equal(claudeQueryOptions(base).cwd, process.env.CLAUDE_SDK_CWD ?? '/tmp');
    assert.equal(claudeQueryOptions({ ...base, cwd: '/work' }).cwd, '/work');
  });

  it('includes stderr only when provided', () => {
    assert.equal('stderr' in claudeQueryOptions(base), false);
    const sink = () => {};
    assert.equal(claudeQueryOptions({ ...base, stderr: sink }).stderr, sink);
  });

  it('passes the api key via env (inheriting process.env) without a global mutation', () => {
    assert.equal('env' in claudeQueryOptions(base), false);
    const o = claudeQueryOptions({ ...base, apiKey: 'sk-test-123' });
    assert.equal(o.env?.ANTHROPIC_API_KEY, 'sk-test-123');
    // Inherits the parent env (e.g. PATH) rather than replacing it wholesale.
    assert.equal(o.env?.PATH, process.env.PATH);
  });
});

describe('resolveClaudeModel', () => {
  it('prefers an explicit claude-* model', () => {
    assert.equal(resolveClaudeModel('claude-opus-4-8', undefined), 'claude-opus-4-8');
  });
  it('falls back to a services.llm claude-* model', () => {
    assert.equal(resolveClaudeModel('gpt-5.4', 'claude-haiku-4-5'), 'claude-haiku-4-5');
  });
  it('never returns a non-claude model — defaults to a safe claude id', () => {
    assert.equal(resolveClaudeModel('gpt-5.4', 'gpt-4o'), 'claude-sonnet-5-5');
    assert.equal(resolveClaudeModel(undefined, undefined), 'claude-sonnet-5-5');
  });
});

describe('extractAssistantText (ZIG-787)', () => {
  const asAssistant = (content: unknown[]): SDKAssistantMessage =>
    ({ type: 'assistant', message: { content } } as unknown as SDKAssistantMessage);

  it('joins only text blocks and skips tool_use / thinking blocks', () => {
    const msg = asAssistant([
      { type: 'text', text: 'Hello ' },
      { type: 'tool_use', name: 'ziggs_inbox', input: {} },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'world' },
    ]);
    assert.equal(extractAssistantText(msg), 'Hello world');
  });

  it('returns empty for a pure tool-use turn or missing content', () => {
    assert.equal(extractAssistantText(asAssistant([{ type: 'tool_use', name: 'x', input: {} }])), '');
    assert.equal(extractAssistantText({ type: 'assistant', message: {} } as unknown as SDKAssistantMessage), '');
  });
});

describe('summarizeContext / buildClaudeEventPrompt (ZIG-777)', () => {
  it('renders the host clock and a delayed timer with its original reason', () => {
    const p = buildClaudeEventPrompt({
      type: 'wake-at',
      reason: 'Check the opening-week approval',
      scheduledFor: Date.parse('2026-09-15T07:07:50Z'),
      epoch: 2,
    }, '', new Date('2026-09-15T07:12:49Z'));
    assert.match(p, /Current time: 2026-09-15T07:12:49.000Z/);
    assert.match(p, /Timer reason: Check the opening-week approval/);
    assert.match(p, /Timer scheduled for: 2026-09-15T07:07:50.000Z \(299 seconds late\)/);
    assert.match(p, /actual timestamp of your last ask or reminder/);
  });

  it('uses one clock for batched timer and task deadline context', () => {
    const p = buildClaudeEventPrompt({
      type: 'batch',
      events: [
        { type: 'wake-at', scheduledFor: Date.parse('2026-09-15T07:27:40Z'), reason: 'approval reminder' },
        { type: 'task_result', result: { taskId: 'task-1', dueAt: '2026-09-15T07:45:25Z' } },
      ],
    }, '', new Date('2026-09-15T07:27:25Z'));
    assert.equal(p.match(/Current time:/g)?.length, 1);
    assert.match(p, /due in 15 seconds/);
    assert.match(p, /about 18 minutes from now/);
    assert.match(p, /re-arm for the remaining interval without sending/);
  });

  it('handles timer events with no valid scheduled timestamp', () => {
    for (const scheduledFor of [undefined, NaN, Infinity]) {
      const p = buildClaudeEventPrompt({ type: 'wake-at', scheduledFor }, '');
      assert.match(p, /Event type: wake-at/);
      assert.doesNotMatch(p, /Timer scheduled for:|Invalid Date/);
    }
  });

  for (const verdict of ['approved', 'rejected']) {
    it(`treats approval:${verdict} as an answer to inspect, not a claim greeting`, () => {
      const p = buildClaudeEventPrompt({
        type: 'resource_changed',
        agreementId: 'agr-approval',
        resource: { reason: `approval:${verdict}`, actorId: 'approver', kind: 'agreement' },
      }, '');
      assert.match(p, new RegExp(`approval slot on this agreement was ${verdict} by approver`));
      assert.match(p, /room where you asked/);
      assert.match(p, /Do not treat approval of your own request as a new hire/);
      assert.match(p, /open standing listing accepted by its provider is store setup/);
      assert.match(p, /actual hire is active and names a concrete buyer/);
      assert.match(p, /rejected: ask what to change/);
      assert.doesNotMatch(p, /Work signal: listing claimed/);
    });
  }

  for (const verdict of ['fulfilled', 'rejected']) {
    it(`resumes a context request after ${verdict} without creating a hire`, () => {
      const p = buildClaudeEventPrompt({ type: 'resource_changed',
        resource: { kind: 'agreement', reason: `context_request_${verdict}` },
      }, '');
      assert.match(p, /owner answered your context access request/);
      assert.match(p, verdict === 'fulfilled' ? /Read the original resource/ : /Access was rejected/);
      assert.match(p, /do not create a new task/);
    });
  }

  it('summarizes a context snapshot (and empties on null)', () => {
    assert.equal(summarizeContext(null), '');
    assert.equal(
      summarizeContext({ history: [1, 2], agreements: [1], users: [] }),
      'history=2 messages, agreements=1, users=0',
    );
    assert.match(
      summarizeContext({
        history: [],
        agreements: [],
        users: [],
        grantedArtifacts: {
          items: [{ artifactId: 'art_shared', name: 'Shared brief', via: 'artifact:art_shared' }],
          omitted: 2,
        },
      }),
      /Readable artifacts not in this room: art_shared \(Shared brief\)\. 2 more on grant_list\./,
    );
    assert.doesNotMatch(
      summarizeContext({
        history: [],
        agreements: [],
        users: [],
        grantedArtifacts: {
          items: [{ artifactId: 'art_shared', name: 'Shared brief', via: 'artifact:art_shared', text: 'SECRET' }],
          omitted: 0,
        },
      }),
      /SECRET/,
    );
  });

  it('renders the event fields and the closing instruction', () => {
    const event = { type: 'message', text: 'hi', senderId: 'u1' } as unknown as RawEvent;
    const p = buildClaudeEventPrompt(event, 'history=1 messages, agreements=0, users=1');
    assert.match(p, /Event type: message/);
    assert.match(p, /Message: hi/);
    assert.match(p, /Sender: u1/);
    assert.match(p, /Session context snapshot:/);
    assert.match(p, /context_snapshot/);
    // Hosted agents are push-driven: the host owns the inbox/watermark, the
    // brain must never be told to poll or ack (the delegate-protocol leftovers
    // that fed the wake loop).
    assert.doesNotMatch(p, /ziggs_inbox|\back\b|delegate/);
  });

  it('ZIG-1035: frames lifecycle notices as Notification, not Message', () => {
    const event = {
      type: 'notification',
      entryType: 'notification',
      text: 'Task created: t1',
    } as unknown as RawEvent;
    const p = buildClaudeEventPrompt(event, '');
    assert.match(p, /Notification: Task created: t1/);
    assert.doesNotMatch(p, /Message: Task created/);
  });

  it('ZIG-1052: hire approval prompt is a work signal, not a silent Notification', () => {
    const event = {
      type: 'agreement_lifecycle',
      operation: 'proposal_approved',
      agreementId: 'agr-hire-1',
      text: 'Proposal approved: agr-hire-1',
    } as unknown as RawEvent;
    const p = buildClaudeEventPrompt(event, '');
    assert.match(p, /Agreement lifecycle: Proposal approved/);
    assert.match(p, /Work signal: proposal approved/);
    assert.match(p, /Agreement: agr-hire-1/);
    assert.doesNotMatch(p, /Notification: Proposal approved/);
  });

  it('ZIG-1278: resource_changed proposal_approved is a claim work signal (chat_open buyer)', () => {
    const event = {
      type: 'resource_changed',
      senderId: 'buyer-9',
      agreementId: 'agr-claim-9',
      resource: {
        kind: 'agreement',
        reason: 'proposal_approved',
        agreementId: 'agr-claim-9',
        resourceId: 'agr-claim-9',
        actorId: 'buyer-9',
      },
    } as unknown as RawEvent;
    const p = buildClaudeEventPrompt(event, '');
    assert.match(p, /Work signal: listing claimed/);
    assert.match(p, /chat_open/);
    assert.match(p, /participantId=buyer-9/);
    assert.match(p, /agreementId=agr-claim-9/);
    assert.match(p, /usually made at claim/);
    assert.doesNotMatch(p, /no chat yet/);
    assert.match(p, /Buyer \(claim actor\): buyer-9/);
    assert.match(p, /Agreement: agr-claim-9/);
    // Must not collapse into the lifecycle task_create-only wording.
    assert.doesNotMatch(p, /If you proposed this agreement, spawn the first task/);
  });

  it('does not describe a contact-policy withheld wake', () => {
    const event = {
      type: 'resource_changed',
      resource: {
        kind: 'message',
        reason: 'contact_policy_withheld',
        resourceId: 'msg_1',
        chatId: 'chat-1',
      },
    } as unknown as RawEvent;
    const p = buildClaudeEventPrompt(event, '');
    assert.doesNotMatch(p, /not woken for it/);
    assert.doesNotMatch(p, /delivered and is readable/);
  });

  it('surfaces the task result payload on completion wakes (ZIG-860)', () => {
    const event = {
      type: 'task_result',
      text: 'Task t1 completed',
      senderId: 'ziggs-system',
      result: {
        taskId: 't1',
        agreementId: 'agr-1',
        state: 'completed',
        result: { op: 'fetch_releases_result', ok: true, releases: [{ tag: 'v1.0.0' }] },
      },
    } as unknown as RawEvent;
    const p = buildClaudeEventPrompt(event, '');
    assert.match(p, /Task: t1/);
    assert.match(p, /Task state: completed/);
    assert.match(p, /Task result: .*fetch_releases_result/);
    assert.match(p, /v1\.0\.0/);
  });

  it('truncates an oversized task result payload (ZIG-860)', () => {
    const event = {
      type: 'task_result',
      result: { taskId: 't2', state: 'completed', result: 'x'.repeat(20_000) },
    } as unknown as RawEvent;
    const p = buildClaudeEventPrompt(event, '');
    assert.match(p, /…\[truncated 8000 chars\]/);
  });

  it('unwraps a coalesced batch frame and renders every event (ZIG-880)', () => {
    const event = {
      type: 'batch',
      events: [
        { type: 'message', text: 'Task task-1 completed', senderId: 'ziggs-system' },
        {
          type: 'task_result',
          result: { taskId: 'task-1', state: 'completed', result: '{"op":"fetch_releases_result","releases":[{"tag":"v0.4.0"}]}' },
        },
        { type: 'message', text: 'unrelated chatter', senderId: 'user-1' },
      ],
    } as unknown as RawEvent;
    const p = buildClaudeEventPrompt(event, '');
    assert.match(p, /3 coalesced events/);
    assert.match(p, /Event 1 of 3/);
    assert.match(p, /Event 2 of 3/);
    assert.match(p, /Task result: .*fetch_releases_result/);
    assert.match(p, /v0\.4\.0/);
    assert.match(p, /unrelated chatter/);
    // the batch wrapper itself must not shadow the payloads
    assert.doesNotMatch(p, /Event type: batch/);
  });

  it('renders a single (non-batch) event exactly as before (ZIG-880)', () => {
    const event = { type: 'message', text: 'hello', senderId: 'u1' } as unknown as RawEvent;
    const p = buildClaudeEventPrompt(event, '');
    assert.match(p, /Event type: message/);
    assert.doesNotMatch(p, /coalesced/);
  });
});
