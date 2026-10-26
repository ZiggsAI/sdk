import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openConversationCapability } from '../src/capabilities/chat.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';

/**
 * ZIG-1216 — chat_open used to return the same note whichever outcome it got,
 * so an agent could not tell a reused conversation (which already holds
 * history it should read) from a fresh one (which holds nothing).
 */

function respondWith(body: Record<string, unknown>) {
  mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify(body), { status: 201 }),
  );
}

const ENV: CapabilityEnv = {
  creds: { operatorKey: 'op', agentId: 'agent-a' },
  surface: 'mcp',
};

const open = (args: Record<string, unknown> = { participantId: 'user-7' }) =>
  openConversationCapability.handler(args, ENV) as Promise<{
    chatId: string;
    reused?: boolean;
    note: string;
  }>;

describe('chat_open says what happened to each invited id', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('names who was added, who was already there, and which agent waits for approval', async () => {
    respondWith({
      chatId: 'room',
      reused: true,
      invited: [
        { id: 'paul', kind: 'person', status: 'added' },
        { id: 'itay', kind: 'person', status: 'already-here' },
        { id: 'coffee', kind: 'agent', status: 'pending', admissionId: 'adm_1' },
      ],
    });
    const res = (await open({
      chatId: 'room',
      participantIds: ['paul', 'itay', 'coffee'],
    })) as { invited?: unknown[]; note: string; appUrl: string; people: string[]; pending: string[] };
    assert.equal(res.invited?.length, 3);
    assert.equal(res.appUrl, 'https://ziggsai.com/app/chat/room');
    assert.deepEqual(res.pending, ['coffee']);
    assert.deepEqual(res.people, ['paul', 'itay', 'agent-a']);
    assert.match(res.note, /Added: paul\./);
    assert.match(res.note, /Already in the room: itay\./);
    assert.match(res.note, /waiting for one person there to say yes: coffee\./);
  });
});

describe('chat_open reports each agent named at creation (ZIG-2033)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('says the room is new and which agent waits for one yes', async () => {
    respondWith({
      chatId: 'room',
      reused: false,
      invited: [{ id: 'researcher', kind: 'agent', status: 'pending', admissionId: 'cad_1' }],
    });
    const res = await open({ participantIds: ['paul', 'researcher'], idempotencyKey: 'k' });
    assert.match(res.note, /Created a new conversation/);
    assert.match(res.note, /waiting for one person there to say yes: researcher\./);
  });
});

describe('chat_open reports whether it reused or created (ZIG-1216)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('reports a reuse, and says the room may hold history', async () => {
    respondWith({ chatId: 'chat_1', reused: true });

    const res = await open();

    assert.equal(res.reused, true);
    assert.match(res.note, /Reused/);
    assert.match(res.note, /history/);
    assert.doesNotMatch(res.note, /or reused/);
  });

  it('reports a fresh room, and says there is nothing to catch up on', async () => {
    respondWith({ chatId: 'chat_2', reused: false });

    const res = await open();

    assert.equal(res.reused, false);
    assert.match(res.note, /Created a new conversation/);
    assert.doesNotMatch(res.note, /or reused/);
  });

  it('says nothing it cannot know when the backend omits the field', async () => {
    // A backend from before ZIG-1216. Defaulting to false here would report a
    // reused conversation as fresh — a confident wrong answer, worse than the
    // vague one. The field is absent, not false.
    respondWith({ chatId: 'chat_3' });

    const res = await open();

    assert.equal('reused' in res, false);
    assert.match(res.note, /or reused/);
  });

  it('forwards lookup-only intent and identifies the acting agent', async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ chatId: 'original', reused: true }));
    });
    const result = await openConversationCapability.handler({ participantId: 'user-7', createIfMissing: false }, ENV) as Record<string, unknown>;
    assert.equal(body?.createIfMissing, false);
    assert.equal(result.actingAgentId, 'agent-a');
  });

  it('keeps the grant guidance in every branch', async () => {
    for (const body of [
      { chatId: 'c', reused: true },
      { chatId: 'c', reused: false },
      { chatId: 'c' },
    ]) {
      respondWith(body);
      const res = await open();
      assert.match(res.note, /ziggs_grant_list with scopeKind \["chat"\]/);
      assert.doesNotMatch(res.note, /issued you a grant/);
      mock.restoreAll();
    }
  });
  for (const surface of ['sdk', 'mcp'] as const) {
    it(`${surface} forwards group creation and explicit invitations on the shared capability`, async () => {
      const calls: Record<string, unknown>[] = [];
      mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
        assert.ok(String(url).endsWith('/chats'));
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ chatId: 'group', reused: calls.length > 1 }));
      });
      const input = { participantIds: ['itay', 'paul'], idempotencyKey: 'q3' };
      await openConversationCapability.handler(input, { ...ENV, surface });
      assert.deepEqual(calls[0], input);
      const invitation = { chatId: 'group', participantIds: ['paul'] };
      const res = await openConversationCapability.handler(invitation, { ...ENV, surface }) as { chatId: string; note: string };
      assert.deepEqual(calls[1], invitation);
      assert.equal(res.chatId, 'group');
      assert.match(res.note, /history access remains bounded/);
    });
  }

  it('forwards a group name and returns it, and refuses a name on a pair', async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ chatId: 'group', reused: false, name: 'Development updates' }));
    });
    const result = await openConversationCapability.handler({
      participantIds: ['itay', 'paul'],
      idempotencyKey: 'q3',
      name: '  Development updates  ',
    }, ENV) as Record<string, unknown>;
    assert.equal(body?.name, 'Development updates');
    assert.equal(result.name, 'Development updates');
    mock.restoreAll();
    const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
    await assert.rejects(
      () => openConversationCapability.handler({ participantId: 'user-7', name: 'Nope' }, ENV),
      /Pair rooms take no name/,
    );
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('rejects incomplete group intent before making an HTTP request', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
    for (const args of [
      { participantIds: ['itay', 'paul'] },
      { participantIds: [] },
      { participantIds: ['itay', 'paul'], participantId: 'itay' },
      { chatId: 'room', participantId: 'paul' },
    ]) {
      await assert.rejects(() => openConversationCapability.handler(args, ENV));
    }
    assert.equal(fetch.mock.callCount(), 0);
  });

});

describe('chat_open names a separate room (ZIG-2160)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('sends the name with newChat and refuses it on the pair room', async () => {
    let sent: Record<string, unknown> = {};
    mock.method(globalThis, 'fetch', async (_url: unknown, init?: { body?: string }) => {
      sent = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return new Response(JSON.stringify({ chatId: 'room', reused: false, name: 'Q3 planning' }), {
        status: 201,
      });
    });
    await open({ participantId: 'user-7', newChat: true, name: 'Q3 planning' });
    assert.equal(sent.name, 'Q3 planning');
    assert.equal(sent.newChat, true);

    await assert.rejects(
      open({ participantId: 'user-7', name: 'Q3 planning' }),
      /Pair rooms take no name/,
    );
  });

  it('accepts an idempotency key on a pair and only names chatId when that was passed', async () => {
    let sent: Record<string, unknown> = {};
    mock.method(globalThis, 'fetch', async (_url: unknown, init?: { body?: string }) => {
      sent = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return new Response(JSON.stringify({ chatId: 'room', reused: true }), { status: 201 });
    });
    await open({ participantId: 'user-7', idempotencyKey: 'retry-1' });
    assert.equal(sent.idempotencyKey, 'retry-1');
    await assert.rejects(
      open({ participantId: 'user-7', chatId: 'room-x' }),
      (err: Error) => {
        assert.match(err.message, /chatId requires participantIds/);
        assert.doesNotMatch(err.message, /idempotencyKey/);
        return true;
      },
    );
  });
});
