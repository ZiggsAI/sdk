/**
 * ZIG-1191 — a wake that fails must not be reported as done.
 *
 * Measured on prod 2026-08-06: the agents service redeployed mid-conversation,
 * every wake on the live lane then failed with `No conversation found with
 * session ID: …` (the Claude transcript lived on the replaced container while the
 * session id survived in the lane store), and each failure was acked anyway. Two
 * hand-off publish notifications were consumed and lost, leaving a third party's
 * claim blocked on a provider consent that no wake would ever give. The human saw
 * one "Something went wrong. Please try again." per attempt.
 *
 * Two properties are pinned here: a lost transcript is recovered rather than
 * retried forever, and a failed handover holds the watermark instead of acking.
 */
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { EventQueue } from '../src/platform/EventQueue.js';
import { SeenMessages } from '../src/platform/SeenMessages.js';
import { ClaudeBrain, isMissingSessionError } from '../src/brain/ClaudeBrain.js';
import { pollInboxOnce, type InboxLoopDeps } from '../src/platform/inboxLoop.js';
import { ToolManager } from '../src/tools/ToolManager.js';
import { CLAUDE_SDK_TOOLS } from '../src/brain/claudeSdkTools.js';
import type { Effect, EffectHandler } from '../src/types.js';

describe('isMissingSessionError', () => {
  it('recognises the CLI error for a transcript that is gone', () => {
    assert.equal(
      isMissingSessionError(
        new Error(
          'Claude Code returned an error result: No conversation found with session ID: cddb66e3-a7dd-43bf-911a-5c6445f4ae00',
        ),
      ),
      true,
    );
  });

  // Narrow on purpose: the retry it unlocks re-runs a turn, so no other failure
  // may claim it.
  it('does not claim any other failure', () => {
    for (const message of [
      'fetch failed',
      'Claude Code returned an error result: overloaded_error',
      'session expired',
      'No conversation found',
    ]) {
      assert.equal(isMissingSessionError(new Error(message)), false, message);
    }
    assert.equal(isMissingSessionError(null), false);
    assert.equal(isMissingSessionError({ message: 42 }), false);
  });
});

// ── the lane whose transcript went with the container ────────────────────────

const WORKFLOW = {
  id: 'claude-test',
  description: 'test',
  initial: 'ready',
  states: { ready: { kind: 'parked' as const, transitions: [] } },
};

function resultMessage(sessionId: string) {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: 'handled',
    stop_reason: null,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: sessionId,
  };
}

function claudeAgent(queryFn: unknown) {
  const toolManager = new ToolManager();
  toolManager.registerAll(CLAUDE_SDK_TOOLS);
  return new ClaudeBrain({
    workflow: WORKFLOW,
    toolManager,
    description: 'Test Claude SDK agent',
    model: 'claude-sonnet-5-5',
    anthropicKey: 'test-key',
    operatorKey: 'op-key',
    agentId: 'claude-test',
    queryFn: queryFn as never,
  });
}

const eff: EffectHandler = async (effect: Effect) => {
  if (effect.kind === 'read-context')
    return { history: [], agreements: [], agents: [], users: [{ userId: 'user-1' }] };
  return {};
};

const wake = (agent: ClaudeBrain, ctx: Record<string, unknown>) =>
  agent.tick({
    event: { type: 'message', text: 'please accept it', senderId: 'user-1', senderType: 'USER' },
    identity: { agentId: 'claude-test', sessionId: 'chat-1', laneKey: 'claude-test:chat-1' },
    ctx: ctx as never,
    eff,
  });

describe('ClaudeBrain recovers a resumed session that no longer exists', () => {
  it('retries once on a fresh session and keeps the new id', async () => {
    const resumes: Array<string | undefined> = [];
    const queryFn = mock.fn(async function* (input: { options?: { resume?: string } }) {
      resumes.push(input.options?.resume);
      // Wake 1 records the transcript; wake 2 finds it gone with the container.
      if (resumes.length === 2) {
        throw new Error(
          'Claude Code returned an error result: No conversation found with session ID: cddb66e3',
        );
      }
      yield resultMessage(resumes.length === 1 ? 'cddb66e3' : 'sess-fresh');
    });
    const agent = claudeAgent(queryFn);

    // A lane resumes only a transcript recorded for this same work and
    // audience, so the stale id has to come from a real earlier wake.
    const first = await wake(agent, {});
    assert.equal(first.ctx.claudeSessionId, 'cddb66e3');
    const out = await wake(agent, first.ctx as unknown as Record<string, unknown>);

    assert.deepEqual(resumes, [undefined, 'cddb66e3', undefined], 'the retry must not resume');
    assert.equal(out.parked, true);
    assert.equal(out.ctx.claudeSessionId, 'sess-fresh');
  });

  it('does not retry a failure that a fresh session would not fix', async () => {
    const queryFn = mock.fn(async function* () {
      throw new Error('overloaded_error');
      // eslint-disable-next-line no-unreachable
      yield resultMessage('never');
    });
    const agent = claudeAgent(queryFn);

    await assert.rejects(wake(agent, { claudeSessionId: 'sess-live' }), /overloaded_error/);
    assert.equal(queryFn.mock.callCount(), 1);
  });

  it('propagates a retry that fails too — one attempt, not a loop', async () => {
    let calls = 0;
    const queryFn = mock.fn(async function* () {
      calls += 1;
      if (calls > 1) throw new Error('No conversation found with session ID: gone');
      yield resultMessage('gone');
    });
    const agent = claudeAgent(queryFn);

    const first = await wake(agent, {});
    await assert.rejects(
      wake(agent, first.ctx as unknown as Record<string, unknown>),
      /No conversation found/,
    );
    // The recording wake, the resume that failed, and the single retry.
    assert.equal(queryFn.mock.callCount(), 3);
  });

  it('has nothing to recover when the lane never had a session to resume', async () => {
    const queryFn = mock.fn(async function* () {
      throw new Error('No conversation found with session ID: whatever');
      // eslint-disable-next-line no-unreachable
      yield resultMessage('never');
    });
    const agent = claudeAgent(queryFn);

    await assert.rejects(wake(agent, {}), /No conversation found/);
    assert.equal(queryFn.mock.callCount(), 1);
  });
});

describe('SeenMessages.unmark', () => {
  it('lets a failed message through on redelivery', () => {
    const seen = new SeenMessages();
    seen.mark('msg-1');
    assert.equal(seen.has('msg-1'), true);
    seen.unmark('msg-1');
    assert.equal(seen.has('msg-1'), false);
  });

  it('is a no-op for an id that was never marked', () => {
    const seen = new SeenMessages();
    seen.unmark('nope');
    assert.equal(seen.has('nope'), false);
  });

  it('does not disturb its neighbours', () => {
    const seen = new SeenMessages();
    seen.mark('a');
    seen.mark('b');
    seen.mark('c');
    seen.unmark('b');
    assert.deepEqual(
      ['a', 'b', 'c'].map((id) => seen.has(id)),
      [true, false, true],
    );
  });
});

describe('EventQueue reports a failed dispatch to whoever enqueued it', () => {
  it('rejects when processEvent throws', async () => {
    const queue = new EventQueue(async () => {
      throw new Error('tick failed');
    });
    await assert.rejects(queue.enqueue({ type: 'message' }, 'lane-1'), /tick failed/);
  });

  it('resolves when it succeeds', async () => {
    const queue = new EventQueue(async () => {});
    await queue.enqueue({ type: 'message' }, 'lane-1');
  });

  // The lane runs one tick for a coalesced batch, so the failure belongs to
  // every event merged into it — none of them was handled.
  it('rejects every event coalesced into a failed batch', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let call = 0;
    const queue = new EventQueue(async () => {
      call++;
      if (call === 1) {
        await gate;
        return;
      }
      throw new Error('batch failed');
    });

    const first = queue.enqueue({ n: 1 }, 'lane-1');
    const second = queue.enqueue({ n: 2 }, 'lane-1');
    const third = queue.enqueue({ n: 3 }, 'lane-1');
    release();

    await first;
    await assert.rejects(second, /batch failed/);
    await assert.rejects(third, /batch failed/);
  });

  it('tells the caller when its event was dropped for queue length', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const queue = new EventQueue(async () => gate, { maxQueueLengthPerLane: 1 });

    const inFlight = queue.enqueue({ n: 0 }, 'lane-1');
    const dropped = queue.enqueue({ n: 1 }, 'lane-1');
    const kept = queue.enqueue({ n: 2 }, 'lane-1');

    await assert.rejects(dropped, /dropped an event/);
    release();
    await inFlight;
    await kept;
  });
});

// ── the inbox pass ───────────────────────────────────────────────────────────

const ACK_TO = '2026-08-06T02:00:02.350Z';

/**
 * One resource delivery is the smallest envelope that exercises the ack
 * decision: no chat read, no task channel, one handover that can fail. Mirrors
 * the publish notification that was lost on prod.
 */
function mockInboxTransport(): { acks: string[] } {
  const acks: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/inbox/ack')) {
      acks.push(String(JSON.parse(String(init?.body ?? '{}')).upTo ?? ''));
      return new Response(JSON.stringify({ ackedUpTo: ACK_TO }), { status: 200 });
    }
    if (u.endsWith('/inbox')) {
      return new Response(
        JSON.stringify({
          asOf: ACK_TO,
          deliveries: [
            {
              kind: 'agreement',
              resourceId: 'agr_1',
              chatId: null,
              agreementId: 'agr_1',
              taskId: null,
              actorId: 'user-1',
              assigneeId: 'agent-me',
              ts: '2026-08-06T02:00:02.139Z',
            },
          ],
          deliveriesCapped: false,
          chats: [],
          ackTo: ACK_TO,
          tasksAwaitingMe: [],
          truncatedTasks: 0,
          proposalsAwaitingMe: [],
          truncatedProposals: 0,
          connectionRequestsAwaitingMe: [],
          truncatedConnectionRequests: 0,
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  });
  return { acks };
}

function harnessDeps(
  onResourceEvent: InboxLoopDeps['onResourceEvent'],
  seen = new SeenMessages(),
): InboxLoopDeps {
  return {
    creds: { operatorKey: 'op', agentId: 'agent-me' },
    ownAgentId: 'agent-me',
    baseUrl: 'http://test',
    seen,
    label: 'test',
    onMessage: async () => {},
    onResourceEvent,
  };
}

describe('an inbox pass holds the watermark when a handover fails', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('acks when everything was handled', async () => {
    const { acks } = mockInboxTransport();
    const pass = await pollInboxOnce(harnessDeps(async () => {}));
    assert.equal(pass.failures, 0);
    assert.equal(pass.acked, true);
    assert.deepEqual(acks, [ACK_TO]);
  });

  it('does not ack a window whose handover threw', async () => {
    const { acks } = mockInboxTransport();
    const pass = await pollInboxOnce(
      harnessDeps(async () => {
        throw new Error('No conversation found with session ID: gone');
      }),
    );
    assert.equal(pass.failures, 1);
    assert.equal(pass.acked, false);
    assert.equal(pass.resourceEvents, 0);
    assert.deepEqual(acks, []);
  });

  it('forgets the delivery it failed, so the redelivery is not skipped as seen', async () => {
    const { acks } = mockInboxTransport();
    const seen = new SeenMessages();
    let attempts = 0;
    const deps = harnessDeps(async () => {
      attempts++;
      if (attempts === 1) throw new Error('tick failed');
    }, seen);

    const held = await pollInboxOnce(deps);
    assert.equal(held.acked, false);

    // Same envelope again — this is what the server does with a held watermark.
    const recovered = await pollInboxOnce(deps);
    assert.equal(attempts, 2, 'the redelivered event must reach the host again');
    assert.equal(recovered.failures, 0);
    assert.equal(recovered.acked, true);
    assert.deepEqual(acks, [ACK_TO]);
  });

  it('never acknowledges failed handovers even with the legacy force flag', async () => {
    const { acks } = mockInboxTransport();
    const pass = await pollInboxOnce(
      harnessDeps(async () => {
        throw new Error('permanently unhandleable');
      }),
      0,
      { forceAck: true },
    );
    assert.equal(pass.failures, 1);
    assert.equal(pass.acked, false, 'a retry budget cannot prove delivery');
    assert.deepEqual(acks, []);
  });
});
