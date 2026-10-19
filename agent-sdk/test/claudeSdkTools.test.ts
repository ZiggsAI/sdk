/**
 * Claude-brain chat tool ergonomics: replying to whoever woke you must not
 * require the model to restate the recipient (a missing receiverId cost a
 * failed tool call + a full extra LLM turn per reply).
 */
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chatSendTool } from '../src/brain/claudeSdkTools.js';

type SendEffect = { kind: string; receiverId?: string; text?: string; sessionId?: string };

const ctxWith = (over: Record<string, unknown>) => ({
  operatorKey: 'op-key',
  agentId: 'agent-me',
  chatId: 'chat-1',
  ...over,
});

describe('chat_send receiver defaulting', () => {
  it('does not infer a recipient from the wake sender', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await chatSendTool.handler(
      { text: 'hi there' },
      ctxWith({ eff, senderId: 'user-9' }),
    );
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as SendEffect;
    assert.equal(effect.kind, 'send-message');
    assert.equal(effect.receiverId, undefined);
    assert.equal(effect.sessionId, 'chat-1');
  });

  it('an explicit receiverId wins over the wake-sender default', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await chatSendTool.handler(
      { text: 'hi', receiverId: 'agent-7' },
      ctxWith({ eff, senderId: 'user-9' }),
    );
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as SendEffect;
    assert.equal(effect.receiverId, 'agent-7');
  });

  it('sends with NO receiver when the wake has no sender and none is given', async () => {
    // A batch/timer wake carries nobody to reply to. Refusing here cost a turn
    // and told the model to name an id it does not have; the room does know —
    // the backend resolves the recipient when a chat has one other member.
    const eff = mock.fn(async () => ({ ok: true }));
    await chatSendTool.handler({ text: 'hi' }, ctxWith({ eff }));
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as SendEffect;
    assert.equal(effect.kind, 'send-message');
    assert.equal(effect.receiverId, undefined);
    assert.equal(effect.sessionId, 'chat-1');
  });
});

/**
 * Reaching a human: `chat_open` mints a room with the principal and `chat_send`
 * has to be able to speak in it. It could not — the wake's sender was defaulted
 * into the new room, and a wake's sender is usually an `rpb_*` participant
 * reference, which addresses one subject inside ONE room and nobody anywhere
 * else. The backend refused it (INVALID_ROOM_PARTICIPANT_REF), the agent gave up,
 * and the person who asked for the work was never told.
 */
describe('chat_send does not carry a room-scoped address into another room', () => {
  it('drops the wake sender when sending in a DIFFERENT chat', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await chatSendTool.handler(
      { text: 'a question for you', chatId: 'chat-with-my-human' },
      ctxWith({ eff, senderId: 'rpb_abc_123' }),
    );
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as SendEffect;
    assert.equal(effect.sessionId, 'chat-with-my-human');
    assert.equal(effect.receiverId, undefined);
  });

  it('does not infer a recipient even in the same room', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await chatSendTool.handler(
      { text: 'replying here', chatId: 'chat-1' },
      ctxWith({ eff, senderId: 'rpb_abc_123' }),
    );
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as SendEffect;
    assert.equal(effect.receiverId, undefined);
  });

  it('preserves explicitly passed references for server validation', async () => {
    // The model reads these refs off a snapshot of the other room, where they
    // are the only ids it has been shown.
    const eff = mock.fn(async () => ({ ok: true }));
    await chatSendTool.handler(
      { text: 'hi', chatId: 'chat-2', receiverId: 'rpb_from_chat_1' },
      ctxWith({ eff, senderId: 'rpb_from_chat_1' }),
    );
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as SendEffect;
    assert.equal(effect.receiverId, 'rpb_from_chat_1');
  });

  it('keeps a real account id when sending in another chat', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await chatSendTool.handler(
      { text: 'hi', chatId: 'chat-2', receiverId: 'ido:::ido@ziggsai.com' },
      ctxWith({ eff, senderId: 'rpb_from_chat_1' }),
    );
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as SendEffect;
    assert.equal(effect.receiverId, 'ido:::ido@ziggsai.com');
  });
  it('preserves an explicit destination-room participant reference for server validation', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await chatSendTool.handler(
      { text: 'hi', chatId: 'chat-2', receiverId: 'rpb_destination_person' },
      ctxWith({ eff, senderId: 'rpb_wake_sender' }),
    );
    assert.equal((eff.mock.calls.at(-1)?.arguments?.[0] as SendEffect).receiverId, 'rpb_destination_person');
  });
});

describe('cross-room questions must not silently become human broadcasts', () => {
  it('sends unaddressed room context without choosing a recipient', async () => {
    const eff = mock.fn(async () => ({ users: [{ userId: 'sophie' }], agents: [{ agentId: 'old-delegate' }, { agentId: 'agent-me' }] }));
    await chatSendTool.handler({ chatId: 'other-room', text: 'Hiring status?' }, ctxWith({ eff, senderId: 'luke' }));
    assert.equal(eff.mock.calls.length, 1);
    assert.equal((eff.mock.calls[0].arguments[0] as SendEffect).kind, 'send-message');
  });
  it('keeps explicit person addressing and explicit broadcasts available without inference', async () => {
    for (const receiverId of ['sophie', 'human']) {
      const eff = mock.fn(async () => ({ ok: true }));
      await chatSendTool.handler({ chatId: 'other-room', receiverId, text: 'Hello' }, ctxWith({ eff, senderId: 'luke' }));
      assert.equal(eff.mock.calls.length, 1);
      assert.equal((eff.mock.calls[0].arguments[0] as SendEffect).receiverId, receiverId);
    }
  });
});

import { createDeliveryWriteKeys } from '../src/runtime/deliveryWriteKeys.js';

describe('chat_send messageId derivation (delivery law, idempotent writes)', () => {
  const sentIds = async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    const writeKeys = createDeliveryWriteKeys('agent-me:chat-1', { type: 'message', messageId: 'm-1' });
    await chatSendTool.handler({ text: 'a' }, ctxWith({ eff, senderId: 'user-9', writeKeys }));
    await chatSendTool.handler({ text: 'b' }, ctxWith({ eff, senderId: 'user-9', writeKeys }));
    return eff.mock.calls.map((c) => (c.arguments?.[0] as { messageId?: string }).messageId);
  };

  it('defaults the messageId to the content-derived wake key; a crash-replay re-derives the same ids (ZIG-1045)', async () => {
    const first = await sentIds();
    const replay = await sentIds(); // fresh DeliveryWriteKeys from the same wake inputs
    assert.match(String(first[0]), /^sdk_idem_wk_[0-9a-f]{40}_m_[0-9a-f]{16}$/);
    assert.match(String(first[1]), /^sdk_idem_wk_[0-9a-f]{40}_m_[0-9a-f]{16}$/);
    assert.notEqual(first[0], first[1]); // distinct texts → distinct keys
    assert.deepEqual(replay, first);
  });

  it('an explicit LLM idempotencyKey still wins over the wake default', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    const writeKeys = createDeliveryWriteKeys('agent-me:chat-1', { type: 'message', messageId: 'm-1' });
    await chatSendTool.handler(
      { text: 'hi', idempotencyKey: 'retry-7' },
      ctxWith({ eff, senderId: 'user-9', writeKeys }),
    );
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as { messageId?: string };
    assert.equal(effect.messageId, 'sdk_idem_retry-7');
  });

  it('falls back to a random sdk_ id when the wake has no durable identity', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    const writeKeys = createDeliveryWriteKeys('agent-me:chat-1', { type: 'state-timeout', state: 'idle', waitedMs: 5 });
    await chatSendTool.handler({ text: 'a' }, ctxWith({ eff, senderId: 'user-9', writeKeys }));
    await chatSendTool.handler({ text: 'b' }, ctxWith({ eff, senderId: 'user-9', writeKeys }));
    const ids = eff.mock.calls.map((c) => (c.arguments?.[0] as { messageId?: string }).messageId);
    assert.match(String(ids[0]), /^sdk_(?!idem_)/);
    assert.notEqual(ids[0], ids[1]); // random per send, as before
  });
});

import { contextSnapshotTool, listTasksTool, CLAUDE_SDK_TOOLS } from '../src/brain/claudeSdkTools.js';

describe('task_list (ZIG-977)', () => {
  it('is registered on the hosted Claude tool surface', () => {
    assert.ok(CLAUDE_SDK_TOOLS.some((t) => t.schema.function['name'] === 'task_list'));
  });

  it('ZIG-1278: chat_open is on the default Claude tool surface', () => {
    assert.ok(CLAUDE_SDK_TOOLS.some((t) => t.schema.function['name'] === 'chat_open'));
  });

  it('requires operatorKey in tool context', async () => {
    await assert.rejects(
      () => listTasksTool.handler({ assignedToMe: true }, { agentId: 'agent-me' } as never),
      /operatorKey/,
    );
  });
});

describe('context_snapshot default cap (ZIG-860)', () => {
  it('caps message history at 12 by default — an uncapped snapshot ballooned every wake', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({}, ctxWith({ eff }));
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as { opts?: { maxMessages?: number } };
    assert.equal(effect.opts?.maxMessages, 12);
  });

  it('honors an explicit larger maxMessages', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({ maxMessages: 50 }, ctxWith({ eff }));
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as { opts?: { maxMessages?: number } };
    assert.equal(effect.opts?.maxMessages, 50);
  });
});

/**
 * ZIG-1081: an agent told to "start by reading your scope with context_snapshot"
 * has no way to know its own chatId, so the model filled the optional field with
 * "". `??` let the blank beat the lane default and the tool then rejected it as
 * missing — one failed tool call plus a recovery turn at the top of every wake.
 */
describe('blank string arguments fall back to the lane default (ZIG-1081)', () => {
  it('context_snapshot: chatId "" uses the lane session instead of throwing', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({ chatId: '' }, ctxWith({ eff }));
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as { sessionId?: string };
    assert.equal(effect.sessionId, 'chat-1');
  });

  it('context_snapshot: whitespace-only chatId is treated the same as absent', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({ chatId: '   ' }, ctxWith({ eff }));
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as { sessionId?: string };
    assert.equal(effect.sessionId, 'chat-1');
  });

  it('context_snapshot: a real chatId still wins over the lane session', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await contextSnapshotTool.handler({ chatId: 'chat-other' }, ctxWith({ eff }));
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as { sessionId?: string };
    assert.equal(effect.sessionId, 'chat-other');
  });

  it('context_snapshot: with no lane and no argument, the error names the lever', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await assert.rejects(
      () => contextSnapshotTool.handler({ chatId: '' }, { operatorKey: 'op', agentId: 'a', eff } as never),
      /no chat to snapshot.*no arguments/s,
    );
    assert.equal(eff.mock.calls.length, 0);
  });

  it('chat_send: blank chatId and receiverId fall back to the wake', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await chatSendTool.handler(
      { text: 'hi', chatId: '', receiverId: '' },
      ctxWith({ eff, senderId: 'user-9' }),
    );
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as { sessionId?: string; receiverId?: string };
    assert.equal(effect.sessionId, 'chat-1');
    assert.equal(effect.receiverId, undefined);
  });
});

describe('chat_send to an existing participant', () => {
  afterEach(() => mock.restoreAll());

  it('answers the person who woke you in the room that woke you, not a pair room', async () => {
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('no pair-room lookup expected');
    });
    const eff = mock.fn(async () => ({ ok: true, result: 'sent' }));
    await chatSendTool.handler(
      { text: 'Hello, I am the stand-in.', to: 'user-buyer' },
      ctxWith({ eff, senderId: 'user-buyer' }),
    );
    assert.equal(eff.mock.calls.length, 1, 'the answer goes through the wake-room effect');
    const effect = eff.mock.calls[0]?.arguments?.[0] as SendEffect;
    assert.equal(effect.sessionId, 'chat-1');
    assert.equal(effect.receiverId, 'user-buyer');
  });

  it('POSTs /chats/messages and does not use the wake room', async () => {
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(
        JSON.stringify({ success: true, message: 'ok', chatId: 'pair-1' }),
        { status: 200 },
      );
    });
    const eff = mock.fn(async () => ({ ok: true }));
    const result = await chatSendTool.handler(
      { text: 'hi', to: 'user-buyer' },
      ctxWith({ eff, senderId: 'rpb_wake' }),
    );
    assert.equal(eff.mock.calls.length, 0, 'person-send must not go through the wake-room effect');
    assert.match(urls[0] ?? '', /\/chats\/messages$/);
    assert.equal(bodies[0]?.['to'], 'user-buyer');
    assert.equal(bodies[0]?.['chatId'], undefined);
    // ZIG-1897: the send reports itself — the room it landed in, the message it
    // created, and that accepted is not read. A backend that says nothing about
    // the destination gets that one line and no invented recipient.
    assert.match(
      (result as { delivered: string }).delivered,
      /was accepted into chat pair-1\. Accepted is not read/,
    );
    assert.equal((result as { chatId: string }).chatId, 'pair-1');
    assert.equal((result as { messageId: string }).messageId, bodies[0]?.messageId);
    assert.equal((result as { to?: unknown }).to, undefined);
  });

  it('lets explicit chatId win; to becomes the receiver', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await chatSendTool.handler(
      { text: 'hi', chatId: 'chat-other', to: 'user-buyer' },
      ctxWith({ eff }),
    );
    const effect = eff.mock.calls.at(-1)?.arguments?.[0] as SendEffect;
    assert.equal(effect.sessionId, 'chat-other');
    assert.equal(effect.receiverId, 'user-buyer');
  });

  it('names to as the lever when this wake has no chat', async () => {
    const eff = mock.fn(async () => ({ ok: true }));
    await assert.rejects(
      () =>
        chatSendTool.handler(
          { text: 'hi' },
          { operatorKey: 'op', agentId: 'a', eff } as never,
        ),
      /to naming a person.*chat_open/s,
    );
    assert.equal(eff.mock.calls.length, 0);
  });
});
