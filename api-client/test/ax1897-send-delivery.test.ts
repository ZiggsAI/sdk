import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentSendResult } from '../src/capabilities/index.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';
import type { SendChatMessageResult } from '../src/http/ChatClient.js';

/**
 * ZIG-1897 — an agent that sent an answer read `success: true` and reported the
 * answer delivered. Three different facts hide behind that word: the message
 * exists, it went somewhere the server chose, and somebody may or may not be
 * woken by it.
 */
const SURFACES = ['mcp', 'sdk'] as const;

function env(surface: 'mcp' | 'sdk'): CapabilityEnv {
  return {
    creds: { operatorKey: 'op_test', agentId: 'agent_me' },
    surface,
    webUrl: 'http://localhost:1234',
  };
}

const sent = (delivery?: SendChatMessageResult['delivery'] & { wakesAgent?: boolean }): SendChatMessageResult =>
  ({
    success: true,
    message: 'Message sent successfully',
    messageId: 'msg_1',
    chatId: 'chat_1',
    ...(delivery ? { delivery } : {}),
  }) as SendChatMessageResult;

test('an agent addressee does not establish execution, even on a legacy server', () => {
  for (const surface of SURFACES) {
    const out = presentSendResult(
      sent({
        accepted: true,
        to: { id: 'agent_worker', type: 'agent' },
        broadcast: false,
        wakesAgent: true,
      }),
      env(surface),
    );
    assert.match(out.delivered, /addressed to agent_worker \(agent\)/, surface);
    assert.match(out.delivered, /routing is unconfirmed/, surface);
    assert.doesNotMatch(out.delivered, /which wakes them/);
    assert.match(out.delivered, /Accepted is not read/, surface);
    assert.equal('routing' in out, false, surface);
  }
});

test('a counted message says what counted it, in the server\'s words', () => {
  const out = presentSendResult(
    {
      ...sent({
        accepted: true,
        to: { id: 'seo-growth', type: 'agent' },
        broadcast: false,
      }),
      coverage: {
        agreementId: 'agr_listing',
        messagesUsed: 2,
        messageLimit: 3,
        message: '2 of 3 free messages used with seo-growth.',
      },
    },
    env('mcp'),
  );
  assert.match(out.delivered, /2 of 3 free messages used with seo-growth\.$/);
});

test('a legacy false wake flag does not deny human mailbox coverage', () => {
  const out = presentSendResult(
    sent({
      accepted: true,
      to: { id: 'user_buyer', type: 'user' },
      broadcast: false,
      wakesAgent: false,
    }),
    env('mcp'),
  );
  assert.match(out.delivered, /addressed to user_buyer \(user\)/);
  assert.match(out.delivered, /person may be covered by an assistant/);
  assert.doesNotMatch(out.delivered, /nobody is woken/);
  assert.equal('routing' in out, false);
});

test('a widened send says it reached the room, not one addressee', () => {
  // The caller may have omitted the recipient and had it widened here; a send
  // that woke nobody must not read like one that reached the agent it meant.
  const out = presentSendResult(
    sent({
      accepted: true,
      to: { id: 'human', type: 'human-broadcast' },
      broadcast: true,
      wakesAgent: false,
    }),
    env('mcp'),
  );
  assert.match(out.delivered, /the humans in the room, not one addressee/);
  assert.match(out.delivered, /does not wake assistants or stand-ins/);
  assert.match(out.delivered, /same chat.*returned participant id/);
  assert.match(out.delivered, /fresh message id or idempotency key/);
  assert.doesNotMatch(out.delivered, /routing is unconfirmed/);
});

test('broadcast guidance survives a current receipt on every client surface', () => {
  const message = 'Human-only broadcast. Existing conversation permissions still apply.';
  for (const surface of SURFACES) {
    const out = presentSendResult({
      ...sent({
        accepted: true, to: { id: 'human', type: 'human-broadcast' },
        broadcast: true, assignee: null, reachable: 'no',
        reason: 'No assistant is assigned', lastRead: null,
      }),
      message,
    }, env(surface));
    assert.equal(out.message, message);
    assert.match(out.delivered, /does not wake assistants or stand-ins/);
    assert.match(out.delivered, /Existing conversation permissions still apply/);
    assert.doesNotMatch(out.delivered, /routing is unconfirmed|Assigned to nobody/);
    assert.equal(out.chatId, 'chat_1');
  }
});

test('a server that reports no destination has none invented for it', () => {
  const out = presentSendResult(sent(), env('sdk'));
  assert.match(out.delivered, /accepted into chat chat_1/);
  assert.match(out.delivered, /nothing here says anyone has seen it/);
  assert.equal(out.to, undefined);
  assert.equal('routing' in out, false);
});

test('the message it created is always named', () => {
  for (const surface of SURFACES) {
    const out = presentSendResult(sent(), env(surface));
    assert.equal(out.chatId, 'chat_1', surface);
    assert.equal(out.messageId, 'msg_1', surface);
    assert.equal(out.ok, true, surface);
  }
});

test('current receipts keep routing distinct from acceptance on both surfaces', () => {
  for (const surface of SURFACES) {
    for (const type of ['agent', 'user', 'human-broadcast']) {
      const out = presentSendResult(sent({
        accepted: true, to: { id: 'recipient', type },
        broadcast: type === 'human-broadcast',
      }), env(surface));
      assert.equal('routing' in out, false);
      assert.equal('wakesAgent' in out, false);
      assert.match(out.delivered, /does not confirm a wake or reply/);
    }
  }
});
