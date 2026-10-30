import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SeenMessages } from '../src/platform/SeenMessages.js';
import {
  heldPassAfter,
  pollInboxOnce,
  runInboxLoop,
  chatsInWakeOrder,
} from '../src/platform/inboxLoop.js';

describe('SeenMessages', () => {
  it('tracks and dedupes message ids', () => {
    const seen = new SeenMessages(3);
    seen.mark('a');
    seen.mark('b');
    assert.equal(seen.has('a'), true);
    assert.equal(seen.has('c'), false);
    seen.mark('c');
    seen.mark('d');
    seen.mark('e');
    assert.equal(seen.has('a'), false);
    assert.equal(seen.has('b'), false);
    assert.equal(seen.has('c'), true);
    assert.equal(seen.has('e'), true);
  });
});

describe('pollInboxOnce', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('observes blocked task control once without waking or settling the assignment', async () => {
    const observed: string[] = [];
    const executionBlocked = { code: 'EXECUTION_ACCESS_REQUIRED', message: 'Task paused' };
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      assert.ok(String(url).endsWith('/inbox') && !init?.method, 'blocked work must not be read or acknowledged as handled');
      return new Response(JSON.stringify({
        asOf: '2026-10-30T00:00:00Z', ackTo: null,
        deliveries: [{ kind: 'task-state', resourceId: 't1', responsibilityId: 'r1', assigneeId: 'worker', ts: '2026-10-30T00:00:00Z', executionBlocked }],
        tasksAwaitingMe: [{ taskId: 't1', state: 'active', executionBlocked }],
        chats: [], proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [],
      }));
    });
    const result = await pollInboxOnce({
      creds: { operatorKey: 'test-key', agentId: 'worker' }, ownAgentId: 'worker', seen: new SeenMessages(20),
      onMessage: async () => { assert.fail('no model wake'); },
      onResourceEvent: async () => { assert.fail('no resource wake'); },
      onTask: async () => { assert.fail('no task wake'); },
      onTaskControlCheck: async taskId => { observed.push(taskId); },
    });
    assert.deepEqual(observed, ['t1']);
    assert.equal(result.tasksDelivered, 0);
    assert.equal(result.acked, false);
  });

  it('delivers unread chat messages and acks scope', async () => {
    const delivered: string[] = [];
    const receiverIds: Array<string | undefined> = [];
    const calls: string[] = [];
    const readLanes: Array<string | undefined> = [];

    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith('/inbox') && !init?.method) {
        return new Response(
          JSON.stringify({
            asOf: '2026-06-15T08:00:00.000Z',
            deliveries: [
              {
                kind: 'message',
                responsibilityId: 'msg-1', resourceId: 'msg-1',
                chatId: 'chat-1',
                agreementId: null,
                taskId: null,
                actorId: 'user-1',
                assigneeId: 'agent-1',
                ts: '2026-06-15T07:59:00.000Z',
              },
            ],
            deliveriesCapped: false,
            chats: [
              { chatId: 'chat-1', count: 1, latestAt: '2026-06-15T07:59:00.000Z' },
            ],
            ackTo: '2026-06-15T07:59:00.000Z',
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
      if (String(url).includes('/context/read/messages')) {
        readLanes.push((init?.headers as Record<string, string> | undefined)?.['X-Ziggs-Lane']);
        return new Response(
          JSON.stringify({
            type: 'messages',
            via: { kind: 'chat', id: 'chat-1' },
            items: [
              {
                messageId: 'msg-1',
                text: 'hello after reconnect',
                chatId: 'chat-1',
                sender: { agentId: 'user-1' },
                receiver: { id: 'user-alice', type: 'user' },
                receiverId: 'user-alice',
                timestamp: '2026-06-15T07:58:00.000Z',
              },
            ],
            hasMore: false,
            nextCursor: null,
            latestSequence: '2026-06-15T07:58:00.000Z',
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith('/inbox/ack')) {
        return new Response(
          JSON.stringify({
            ackedUpTo: '2026-06-15T07:59:00.000Z',
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });

    const seen = new SeenMessages();
    const result = await pollInboxOnce({
      creds: { operatorKey: 'op', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      baseUrl: 'http://test',
      seen,
      label: 'test',
      onMessage: async (text, metadata) => {
        delivered.push(text);
        receiverIds.push(
          (metadata as { receiverId?: string } | undefined)?.receiverId,
        );
      },
      onResourceEvent: async () => {},
    });

    assert.equal(result.messagesDelivered, 1);
    assert.equal(result.acked, true);
    assert.deepEqual(delivered, ['hello after reconnect']);
    assert.deepEqual(receiverIds, ['user-alice']);
    // The room's mail is read with the room as the lane, as its wake reads it:
    // a stranger's room is filed in their workspace, not the agent's.
    assert.deepEqual(readLanes, [undefined]);
    assert.match(calls.find((u) => u.includes('/inbox/ack')) ?? '', /inbox\/ack/);
  });

  // ZIG-2034 — with the SDK's own receiver check gone, this rule is what keeps
  // a company's other agents asleep: the backend's pick arrives as the row's
  // assignee, and only a row stamped for this agent reaches its host.
  it('a message row assigned to a sibling agent never reaches the host', async () => {
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/inbox') && !init?.method) {
        const row = (resourceId: string, assigneeId: string, ts: string) => ({
          kind: 'message',
          responsibilityId: resourceId, resourceId,
          chatId: 'chat-1',
          agreementId: null,
          taskId: null,
          actorId: 'user-1',
          assigneeId,
          ts,
        });
        return new Response(
          JSON.stringify({
            asOf: '2026-09-29T08:00:00.000Z',
            deliveries: [
              row('msg-mine', 'agent-1', '2026-09-29T07:59:00.000Z'),
              row('msg-sibling', 'agent-sibling', '2026-09-29T07:59:30.000Z'),
            ],
            deliveriesCapped: false,
            chats: [],
            ackTo: 'ibxa1_opaque-token',
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
      if (String(url).includes('/context/read/messages')) {
        const item = (messageId: string, text: string, receiverId: string) => ({
          messageId,
          text,
          chatId: 'chat-1',
          sender: { agentId: 'user-1' },
          receiverId,
          timestamp: '2026-09-29T07:59:00.000Z',
        });
        return new Response(
          JSON.stringify({
            type: 'messages',
            via: { kind: 'chat', id: 'chat-1' },
            items: [
              item('msg-mine', 'for agent-1', 'agent-1'),
              item('msg-sibling', 'for the sibling', 'agent-sibling'),
            ],
            hasMore: false,
            nextCursor: null,
            latestSequence: '2026-09-29T07:59:30.000Z',
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith('/inbox/ack')) {
        return new Response(JSON.stringify({ ackedUpTo: 'ibxa1_opaque-token' }), {
          status: 200,
        });
      }
      return new Response('{}', { status: 404 });
    });

    const delivered: string[] = [];
    const result = await pollInboxOnce({
      creds: { operatorKey: 'op', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      baseUrl: 'http://test',
      seen: new SeenMessages(),
      label: 'test',
      onMessage: async (text) => {
        delivered.push(text);
      },
      onResourceEvent: async () => {},
    });

    assert.equal(result.messagesDelivered, 1);
    assert.deepEqual(delivered, ['for agent-1']);
  });

  it('stamps the sole hire onto chat messages (ZIG-1728)', async () => {
    const hires: Array<string | undefined> = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/inbox') && !init?.method) {
        return new Response(
          JSON.stringify({
            asOf: '2026-06-15T08:00:00.000Z',
            deliveries: [
              {
                kind: 'message',
                responsibilityId: 'msg-1', resourceId: 'msg-1',
                chatId: 'chat-dana',
                agreementId: 'agr_dana',
                taskId: null,
                actorId: 'dana',
                assigneeId: 'agent-1',
                ts: '2026-06-15T07:59:00.000Z',
              },
            ],
            deliveriesCapped: false,
            chats: [
              { chatId: 'chat-dana', count: 1, latestAt: '2026-06-15T07:59:00.000Z' },
            ],
            ackTo: 'tok',
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
      if (String(url).includes('/context/read/messages')) {
        return new Response(
          JSON.stringify({
            type: 'messages',
            via: { kind: 'chat', id: 'chat-dana' },
            items: [
              {
                messageId: 'msg-1',
                text: 'hi',
                chatId: 'chat-dana',
                sender: { agentId: 'dana' },
                timestamp: '2026-06-15T07:58:00.000Z',
              },
            ],
            hasMore: false,
            nextCursor: null,
            latestSequence: '2026-06-15T07:58:00.000Z',
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith('/inbox/ack')) {
        return new Response(JSON.stringify({ ackedUpTo: 'tok' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    await pollInboxOnce({
      creds: { operatorKey: 'op', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      baseUrl: 'http://test',
      seen: new SeenMessages(),
      label: 'test',
      onMessage: async (_text, metadata) => {
        hires.push((metadata as { agreementId?: string }).agreementId);
      },
      onResourceEvent: async () => {},
    });
    assert.deepEqual(hires, ['agr_dana']);
  });

  it('skips messages already seen (cross-iteration dedup)', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      if (String(url).endsWith('/inbox')) {
        return new Response(
          JSON.stringify({
            asOf: '2026-06-15T08:00:00.000Z',
            deliveries: [
              {
                kind: 'message',
                responsibilityId: 'msg-1', resourceId: 'msg-1',
                chatId: 'chat-1',
                agreementId: null,
                taskId: null,
                actorId: 'user-1',
                assigneeId: 'agent-1',
                ts: '2026-06-15T07:59:00.000Z',
              },
            ],
            deliveriesCapped: false,
            chats: [
              { chatId: 'chat-1', count: 1, latestAt: '2026-06-15T07:59:00.000Z' },
            ],
            ackTo: '2026-06-15T07:59:00.000Z',
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
      if (String(url).includes('/context/read/messages')) {
        return new Response(
          JSON.stringify({
            type: 'messages',
            via: { kind: 'chat', id: 'chat-1' },
            items: [
              {
                messageId: 'msg-dup',
                text: 'duplicate',
                chatId: 'chat-1',
                sender: { agentId: 'user-1' },
                receiver: { id: 'agent-1', type: 'agent' },
              },
            ],
            hasMore: false,
            nextCursor: null,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ackedUpTo: null }), { status: 200 });
    });

    const seen = new SeenMessages();
    seen.mark('msg-dup');
    let delivered = 0;
    const result = await pollInboxOnce({
      creds: { operatorKey: 'op', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      baseUrl: 'http://test',
      seen,
      label: 'test',
      onMessage: async () => {
        delivered++;
      },
      onResourceEvent: async () => {},
    });

    assert.equal(result.messagesDelivered, 0);
    assert.equal(delivered, 0);
  });
});

describe('pollInboxOnce — standing proposal assignment', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  function inboxWithProposal(proposal: Record<string, unknown>) {
    return async (url: string) => {
      if (String(url).endsWith('/inbox')) {
        return new Response(
          JSON.stringify({
            asOf: '2026-08-24T08:00:00.000Z',
            deliveries: [],
            deliveriesCapped: false,
            chats: [],
            ackTo: null,
            tasksAwaitingMe: [],
            truncatedTasks: 0,
            openRequestsAwaitingMe: [],
            truncatedRequests: 0,
            proposalsAwaitingMe: [proposal],
            truncatedProposals: 0,
            connectionRequestsAwaitingMe: [],
            truncatedConnectionRequests: 0,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    };
  }

  const PROPOSAL = {
    agreementId: 'agr_org_provider',
    title: 'Provide the service',
    proposedAt: '2026-08-24T07:59:00.000Z',
    pendingApprovalPartyIds: ['org-provider'],
    proposedTo: 'org-provider',
  };

  it('does not wake a sibling that merely sees the shared org proposal', async () => {
    mock.method(
      globalThis,
      'fetch',
      inboxWithProposal({ ...PROPOSAL, assignedAgentId: null }),
    );
    const events: Record<string, unknown>[] = [];
    const seen = new SeenMessages();

    const result = await pollInboxOnce({
      creds: { operatorKey: 'op', agentId: 'claim-chaser' },
      ownAgentId: 'claim-chaser',
      baseUrl: 'http://test',
      seen,
      onMessage: async () => {},
      onResourceEvent: async (event) => {
        events.push(event);
      },
    });

    assert.equal(result.resourceEvents, 0);
    assert.deepEqual(events, []);
    assert.equal(
      seen.has(`proposal:${PROPOSAL.agreementId}`),
      false,
      'ambient state is not consumed as this agent\'s work',
    );
  });

  it('wakes the role-designated agent on the agreement lane', async () => {
    mock.method(
      globalThis,
      'fetch',
      inboxWithProposal({ ...PROPOSAL, assignedAgentId: 'ziggs-agent' }),
    );
    const events: Record<string, unknown>[] = [];

    const result = await pollInboxOnce({
      creds: { operatorKey: 'op', agentId: 'ziggs-agent' },
      ownAgentId: 'ziggs-agent',
      baseUrl: 'http://test',
      seen: new SeenMessages(),
      onMessage: async () => {},
      onResourceEvent: async (event) => {
        events.push(event);
      },
    });

    assert.equal(result.resourceEvents, 1);
    assert.deepEqual(events, [
      {
        kind: 'agreement',
        ts: PROPOSAL.proposedAt,
        resourceId: PROPOSAL.agreementId,
        agreementId: PROPOSAL.agreementId,
        change: 'created',
        reason: 'proposal_pending',
      },
    ]);
  });

  it('uses only an explicit agent-keyed slot when an older server omits assignment', async () => {
    mock.method(
      globalThis,
      'fetch',
      inboxWithProposal({
        ...PROPOSAL,
        pendingApprovalPartyIds: ['ziggs-agent'],
        proposedTo: 'ziggs-agent',
      }),
    );
    let wakes = 0;

    const result = await pollInboxOnce({
      creds: { operatorKey: 'op', agentId: 'ziggs-agent' },
      ownAgentId: 'ziggs-agent',
      baseUrl: 'http://test',
      seen: new SeenMessages(),
      onMessage: async () => {},
      onResourceEvent: async () => {
        wakes++;
      },
    });

    assert.equal(wakes, 1);
    assert.equal(result.resourceEvents, 1);
  });
});

describe('pollInboxOnce — task channel (ZIG-973)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  function inboxWithTasks(tasks: unknown[], truncatedTasks = 0) {
    return async (url: string, init?: RequestInit) => {
      if (String(url).includes('/inbox') && !init?.method) {
        return new Response(
          JSON.stringify({
            asOf: '2026-07-26T08:00:00.000Z',
            deliveries: [],
            deliveriesCapped: false,
            chats: [],
            ackTo: null,
            proposalsAwaitingMe: [],
            truncatedProposals: 0,
            connectionRequestsAwaitingMe: [],
            truncatedConnectionRequests: 0,
            tasksAwaitingMe: tasks,
            truncatedTasks,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    };
  }

  const TASK = {
    taskId: 't-1',
    agreementId: 'agr-no-chat',
    title: 'do the thing',
    state: 'active',
    updatedAt: '2026-07-26T07:59:00.000Z',
  };

  it('delivers an assigned task with no chat scope at all', async () => {
    mock.method(globalThis, 'fetch', inboxWithTasks([TASK]));
    const seenTasks: string[] = [];

    const res = await pollInboxOnce({
      creds: { operatorKey: 'k', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      seen: new SeenMessages(),
      onMessage: async () => {},
      onResourceEvent: async () => {},
      onTask: async (t) => { seenTasks.push(t.taskId); },
    });

    assert.deepEqual(seenTasks, ['t-1']);
    assert.equal(res.tasksDelivered, 1);
    assert.equal(res.deliveries, 0);
  });

  it('does not redeliver an unchanged open task on the next pass', async () => {
    mock.method(globalThis, 'fetch', inboxWithTasks([TASK]));
    const seen = new SeenMessages();
    const seenTasks: string[] = [];
    const deps = {
      creds: { operatorKey: 'k', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      seen,
      onMessage: async () => {},
      onResourceEvent: async () => {},
      onTask: async (t: { taskId: string }) => { seenTasks.push(t.taskId); },
    };

    await pollInboxOnce(deps);
    const second = await pollInboxOnce(deps);

    assert.deepEqual(seenTasks, ['t-1'], 'open task stays listed but wakes once');
    assert.equal(second.tasksDelivered, 0);
  });

  it('redelivers when the task is genuinely touched (updatedAt moves)', async () => {
    const seen = new SeenMessages();
    const seenTasks: string[] = [];
    const deps = {
      creds: { operatorKey: 'k', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      seen,
      onMessage: async () => {},
      onResourceEvent: async () => {},
      onTask: async (t: { taskId: string }) => { seenTasks.push(t.taskId); },
    };

    mock.method(globalThis, 'fetch', inboxWithTasks([TASK]));
    await pollInboxOnce(deps);
    mock.restoreAll();
    mock.method(
      globalThis,
      'fetch',
      inboxWithTasks([{ ...TASK, updatedAt: '2026-07-26T08:05:00.000Z' }]),
    );
    await pollInboxOnce(deps);

    assert.deepEqual(seenTasks, ['t-1', 't-1']);
  });

  it('tolerates a host with no onTask handler', async () => {
    mock.method(globalThis, 'fetch', inboxWithTasks([TASK]));

    const res = await pollInboxOnce({
      creds: { operatorKey: 'k', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      seen: new SeenMessages(),
      onMessage: async () => {},
      onResourceEvent: async () => {},
    });

    assert.equal(res.tasksDelivered, 0);
  });
});

describe('pollInboxOnce — addressed but not readable', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  // The delivery log and the grants are separate now, so they can disagree: a
  // grant revoked between the write and the read leaves mail the agent cannot
  // open. It must skip and still ack — otherwise the same delivery re-wakes it
  // forever and nothing behind it is ever delivered.
  it('skips a chat it may not read, still delivers the rest, and acks', async () => {
    let acked: string | null = null;
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/inbox') && !init?.method) {
        return new Response(
          JSON.stringify({
            asOf: '2026-07-27T09:00:00.000Z',
            deliveries: [
              {
                kind: 'message',
                responsibilityId: 'm-open', resourceId: 'm-open',
                chatId: 'chat-ok',
                agreementId: null,
                taskId: null,
                actorId: 'agent-x',
                assigneeId: 'agent-1',
                ts: '2026-07-27T08:59:00.000Z',
              },
              {
                kind: 'message',
                responsibilityId: 'm-fenced', resourceId: 'm-fenced',
                chatId: 'chat-denied',
                agreementId: null,
                taskId: null,
                actorId: 'agent-x',
                assigneeId: 'agent-1',
                ts: '2026-07-27T08:58:00.000Z',
              },
            ],
            deliveriesCapped: false,
            chats: [
              { chatId: 'chat-ok', count: 1, latestAt: '2026-07-27T08:59:00.000Z' },
              { chatId: 'chat-denied', count: 1, latestAt: '2026-07-27T08:58:00.000Z' },
            ],
            ackTo: '2026-07-27T08:59:00.000Z',
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
      if (u.includes('/context/read/messages') && u.includes('chat-denied')) {
        return new Response(
          JSON.stringify({ error: 'not authorized for this scope' }),
          { status: 403 },
        );
      }
      if (u.includes('/context/read/messages')) {
        return new Response(
          JSON.stringify({
            type: 'messages',
            via: { kind: 'chat', id: 'chat-ok' },
            items: [
              { messageId: 'm-open', text: 'readable', chatId: 'chat-ok' },
            ],
            hasMore: false,
            nextCursor: null,
          }),
          { status: 200 },
        );
      }
      if (u.endsWith('/inbox/ack')) {
        acked = JSON.parse(String(init?.body)).upTo;
        return new Response(JSON.stringify({ ackedUpTo: acked }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const delivered: string[] = [];
    const res = await pollInboxOnce({
      creds: { operatorKey: 'op', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      baseUrl: 'http://test',
      seen: new SeenMessages(),
      label: 'test',
      onMessage: async (text) => { delivered.push(text); },
      onResourceEvent: async () => {},
    });

    assert.deepEqual(delivered, ['readable'], 'the readable chat still lands');
    assert.equal(res.messagesDelivered, 1);
    assert.equal(res.acked, true, 'the watermark must still advance');
    assert.equal(acked, '2026-07-27T08:59:00.000Z');
  });

  it('still propagates a genuine transport failure', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      if (String(url).endsWith('/inbox')) {
        return new Response('boom', { status: 500 });
      }
      return new Response('{}', { status: 200 });
    });

    await assert.rejects(
      pollInboxOnce({
        creds: { operatorKey: 'op', agentId: 'agent-1' },
        ownAgentId: 'agent-1',
        baseUrl: 'http://test',
        seen: new SeenMessages(),
        onMessage: async () => {},
        onResourceEvent: async () => {},
      }),
    );
  });
});

/**
 * ZIG-1019 — the loop used to treat a 429 like any other failure and retry from
 * 1s. Every refused call still counts against the poll cap, so a throttled
 * agent spent its way into a longer lockout: observed live as an agent that
 * could not read the conversation it had just been woken for.
 */
describe('runInboxLoop — throttling', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('waits the window the server named instead of retrying in a second', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response('{"error":"Polling rate limit exceeded."}', {
        status: 429,
        headers: { 'ratelimit-limit': '120', 'ratelimit-remaining': '0', 'ratelimit-reset': '3' },
      });
    });

    const handle = runInboxLoop({
      creds: { operatorKey: 'op', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      baseUrl: 'http://test',
      seen: new SeenMessages(10),
      label: 'test',
      onMessage: async () => {},
      onResourceEvent: async () => {},
    });

    // The old ladder (1s, 2s, 4s…) would have fired at least twice by now.
    await new Promise((r) => setTimeout(r, 1_200));
    const whileWaiting = calls;
    await handle.stop();

    assert.equal(whileWaiting, 1, `expected one refused call while waiting, saw ${whileWaiting}`);
  });

  it('keeps the ordinary backoff for a non-429 failure', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response('{"error":"boom"}', { status: 500 });
    });

    const handle = runInboxLoop({
      creds: { operatorKey: 'op', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      baseUrl: 'http://test',
      seen: new SeenMessages(10),
      label: 'test',
      onMessage: async () => {},
      onResourceEvent: async () => {},
    });

    await new Promise((r) => setTimeout(r, 1_200));
    await handle.stop();

    // Base backoff is ~1s with jitter, so a second attempt is expected here —
    // the throttle path must not have swallowed the normal retry behaviour.
    assert.ok(calls >= 2, `expected retries to continue, saw ${calls}`);
  });
});

describe('pollInboxOnce — request channel (ZIG-1185)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  function inboxWithRequests(requests: unknown[], ackTo = '2026-08-06T08:00:00.000Z') {
    return async (url: string, init?: RequestInit) => {
      if (String(url).includes('/inbox') && !init?.method) {
        return new Response(
          JSON.stringify({
            asOf: '2026-08-06T08:00:00.000Z',
            deliveries: [],
            deliveriesCapped: false,
            chats: [],
            ackTo,
            tasksAwaitingMe: [],
            truncatedTasks: 0,
            openRequestsAwaitingMe: requests,
            truncatedRequests: 0,
            proposalsAwaitingMe: [],
            truncatedProposals: 0,
            connectionRequestsAwaitingMe: [],
            truncatedConnectionRequests: 0,
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith('/inbox/ack')) {
        const ack = JSON.parse(String(init?.body));
        for (const request of requests as Array<{ agreementId: string }>) {
          assert.ok(ack.handledDeliveryIds.includes(request.agreementId), 'request must be triaged before ack');
        }
        return new Response(JSON.stringify({ ackedUpTo: ackTo }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
  }

  const REQUEST = {
    responsibilityId: 'agr_request_1',
    agreementId: 'agr_request_1',
    match: 'email',
    title: 'sort my inbox',
    ts: '2026-08-06T07:59:00.000Z',
  };

  it('triages requests via onRequest and acks (including misses)', async () => {
    mock.method(globalThis, 'fetch', inboxWithRequests([REQUEST]));
    const seen: string[] = [];
    const res = await pollInboxOnce({
      creds: { operatorKey: 'k', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      seen: new SeenMessages(),
      onMessage: async () => {},
      onResourceEvent: async () => {
        throw new Error('requests must not take the resource-event path');
      },
      onRequest: async (q) => {
        seen.push(q.agreementId);
      },
    });
    assert.deepEqual(seen, ['agr_request_1']);
    assert.equal(res.requestsTriaged, 1);
    assert.equal(res.acked, true);
  });

  it('ZIG-1278: forwards reason and actorId on non-message deliveries', async () => {
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('/inbox') && !init?.method) {
        return new Response(
          JSON.stringify({
            asOf: '2026-08-11T08:00:00.000Z',
            deliveries: [
              {
                kind: 'agreement',
                responsibilityId: 'agr_claim_1', resourceId: 'agr_claim_1',
                chatId: null,
                agreementId: 'agr_claim_1',
                taskId: null,
                actorId: 'buyer-user',
                assigneeId: 'agent-1',
                reason: 'proposal_approved',
                ts: '2026-08-11T07:59:00.000Z',
              },
            ],
            deliveriesCapped: false,
            chats: [],
            ackTo: '2026-08-11T07:59:00.000Z',
            tasksAwaitingMe: [],
            truncatedTasks: 0,
            openRequestsAwaitingMe: [],
            truncatedRequests: 0,
            proposalsAwaitingMe: [],
            truncatedProposals: 0,
            connectionRequestsAwaitingMe: [],
            truncatedConnectionRequests: 0,
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith('/inbox/ack')) {
        return new Response(
          JSON.stringify({ ackedUpTo: '2026-08-11T07:59:00.000Z' }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const events: Record<string, unknown>[] = [];
    const res = await pollInboxOnce({
      creds: { operatorKey: 'k', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      seen: new SeenMessages(),
      onMessage: async () => {},
      onResourceEvent: async (e) => {
        events.push(e);
      },
    });
    assert.equal(res.resourceEvents, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'agreement');
    assert.equal(events[0].reason, 'proposal_approved');
    assert.equal(events[0].actorId, 'buyer-user');
    assert.equal(events[0].agreementId, 'agr_claim_1');
    assert.equal(events[0].chatId, undefined);
  });

  // The single-assign law, client side: a merged view carries rows stamped for
  // OTHER windows (a sibling carrier, the owner's needs-human mail). They are
  // readable context — never a wake, never listed as handled in the ack.
  it('an ambient row (assigned elsewhere) is neither enqueued nor acked as handled', async () => {
    let ackBody: { handledDeliveryIds?: string[] } | null = null;
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('/inbox') && !init?.method) {
        return new Response(
          JSON.stringify({
            asOf: '2026-08-18T08:00:00.000Z',
            deliveries: [
              {
                kind: 'agreement',
                responsibilityId: 'agr_mine', resourceId: 'agr_mine',
                chatId: null,
                agreementId: 'agr_mine',
                taskId: null,
                actorId: 'buyer-user',
                assigneeId: 'agent-1',
                ts: '2026-08-18T07:59:00.000Z',
              },
              {
                kind: 'agreement',
                responsibilityId: 'agr_siblings', resourceId: 'agr_siblings',
                chatId: null,
                agreementId: 'agr_siblings',
                taskId: null,
                actorId: 'buyer-user',
                assigneeId: 'agent-sibling',
                ts: '2026-08-18T07:58:00.000Z',
              },
              {
                kind: 'artifact',
                responsibilityId: 'art_for_the_human', resourceId: 'art_for_the_human',
                chatId: null,
                agreementId: null,
                taskId: null,
                actorId: 'counterparty',
                assigneeId: null,
                needsHuman: true,
                ts: '2026-08-18T07:57:00.000Z',
              },
            ],
            deliveriesCapped: false,
            chats: [],
            ackTo: 'ibxa1_opaque-token',
            tasksAwaitingMe: [],
            truncatedTasks: 0,
            openRequestsAwaitingMe: [],
            truncatedRequests: 0,
            proposalsAwaitingMe: [],
            truncatedProposals: 0,
            connectionRequestsAwaitingMe: [],
            truncatedConnectionRequests: 0,
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith('/inbox/ack')) {
        ackBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response(
          JSON.stringify({ ackedUpTo: 'ibxa1_opaque-token' }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const events: Record<string, unknown>[] = [];
    const res = await pollInboxOnce({
      creds: { operatorKey: 'k', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      seen: new SeenMessages(),
      onMessage: async () => {},
      onResourceEvent: async (e) => {
        events.push(e);
      },
    });

    // Only the assigned row wakes; the sibling's and the human's pass quietly.
    assert.equal(res.resourceEvents, 1);
    assert.deepEqual(
      events.map((e) => e.resourceId),
      ['agr_mine'],
    );
    // The ack passes the token back verbatim, listing only what was MINE.
    assert.equal(res.acked, true);
    assert.ok(ackBody);
    assert.deepEqual(ackBody!.handledDeliveryIds, ['agr_mine']);
  });

  it('never wakes onResourceEvent for kind:request left in deliveries', async () => {
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('/inbox') && !init?.method) {
        return new Response(
          JSON.stringify({
            asOf: '2026-08-06T08:00:00.000Z',
            deliveries: [
              {
                kind: 'request',
                responsibilityId: 'agr_leaked', resourceId: 'agr_leaked',
                chatId: null,
                agreementId: 'agr_leaked',
                taskId: null,
                actorId: 'user-1',
                assigneeId: 'agent-1',
                ts: '2026-08-06T07:59:00.000Z',
              },
            ],
            deliveriesCapped: false,
            chats: [],
            ackTo: '2026-08-06T07:59:00.000Z',
            tasksAwaitingMe: [],
            truncatedTasks: 0,
            openRequestsAwaitingMe: [],
            truncatedRequests: 0,
            proposalsAwaitingMe: [],
            truncatedProposals: 0,
            connectionRequestsAwaitingMe: [],
            truncatedConnectionRequests: 0,
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith('/inbox/ack')) {
        return new Response(
          JSON.stringify({ ackedUpTo: '2026-08-06T07:59:00.000Z' }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    let resourceEvents = 0;
    const res = await pollInboxOnce({
      creds: { operatorKey: 'k', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      seen: new SeenMessages(),
      onMessage: async () => {},
      onResourceEvent: async () => {
        resourceEvents++;
      },
    });
    assert.equal(resourceEvents, 0);
    assert.equal(res.resourceEvents, 0);
    assert.equal(res.acked, false);
  });

  it('acks a capped envelope so the cursor can slide (ZIG-1742)', async () => {
    const acks: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('/inbox') && !init?.method) {
        return new Response(
          JSON.stringify({
            asOf: '2026-09-08T00:00:00.000Z',
            deliveries: [
              {
                kind: 'agreement',
                responsibilityId: 'agr_head', resourceId: 'agr_head',
                chatId: null,
                agreementId: 'agr_head',
                taskId: null,
                actorId: 'buyer',
                assigneeId: 'agent-1',
                ts: '2026-09-08T00:00:00.000Z',
              },
            ],
            deliveriesCapped: true,
            chats: [],
            ackTo: 'ibxa1_capped-head',
            tasksAwaitingMe: [],
            truncatedTasks: 0,
            openRequestsAwaitingMe: [],
            truncatedRequests: 0,
            proposalsAwaitingMe: [],
            truncatedProposals: 0,
            connectionRequestsAwaitingMe: [],
            truncatedConnectionRequests: 0,
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith('/inbox/ack')) {
        acks.push(String(url));
        return new Response(
          JSON.stringify({ ackedUpTo: 'ibxa1_capped-head' }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const res = await pollInboxOnce({
      creds: { operatorKey: 'k', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      seen: new SeenMessages(),
      onMessage: async () => {},
      onResourceEvent: async () => {},
    });
    assert.equal(res.truncated, true);
    assert.equal(res.acked, true);
    assert.equal(acks.length, 1);
  });

  it('delivers probe_* chats before leftover rooms (ZIG-1226)', async () => {
    const order: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('/inbox') && !init?.method) {
        return new Response(
          JSON.stringify({
            asOf: '2026-09-08T00:00:00.000Z',
            deliveries: [
              {
                kind: 'message',
                responsibilityId: 'msg-old', resourceId: 'msg-old',
                chatId: 'chat-old',
                agreementId: null,
                taskId: null,
                actorId: 'user-1',
                assigneeId: 'agent-1',
                ts: '2026-09-08T00:00:00.000Z',
              },
              {
                kind: 'message',
                responsibilityId: 'msg-probe', resourceId: 'msg-probe',
                chatId: 'probe_agent-1_1',
                agreementId: null,
                taskId: null,
                actorId: 'user-1',
                assigneeId: 'agent-1',
                ts: '2026-09-08T00:01:00.000Z',
              },
            ],
            deliveriesCapped: true,
            chats: [
              { chatId: 'chat-old', count: 1, latestAt: '2026-09-08T00:00:00.000Z' },
              { chatId: 'probe_agent-1_1', count: 1, latestAt: '2026-09-08T00:01:00.000Z' },
            ],
            ackTo: 'ibxa1_head',
            tasksAwaitingMe: [],
            truncatedTasks: 0,
            openRequestsAwaitingMe: [],
            truncatedRequests: 0,
            proposalsAwaitingMe: [],
            truncatedProposals: 0,
            connectionRequestsAwaitingMe: [],
            truncatedConnectionRequests: 0,
          }),
          { status: 200 },
        );
      }
      if (String(url).includes('/context/read/messages')) {
        const via = new URL(String(url)).searchParams.get('via') ?? '';
        const chatId = via.slice('chat:'.length);
        return new Response(
          JSON.stringify({
            type: 'messages',
            via: { kind: 'chat', id: chatId },
            items: [
              {
                messageId: chatId.startsWith('probe_') ? 'msg-probe' : 'msg-old',
                text: chatId,
                chatId,
                sender: { agentId: 'user-1' },
                receiver: { id: 'agent-1', type: 'agent' },
                timestamp: '2026-09-08T00:00:00.000Z',
              },
            ],
            hasMore: false,
            nextCursor: null,
            latestSequence: '2026-09-08T00:00:00.000Z',
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith('/inbox/ack')) {
        return new Response(JSON.stringify({ ackedUpTo: 'ibxa1_head' }), {
          status: 200,
        });
      }
      return new Response('{}', { status: 200 });
    });

    const res = await pollInboxOnce({
      creds: { operatorKey: 'k', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      baseUrl: 'http://test',
      seen: new SeenMessages(),
      onMessage: async (text) => {
        order.push(text);
      },
      onResourceEvent: async () => {},
    });

    assert.deepEqual(order, ['probe_agent-1_1', 'chat-old']);
    assert.equal(res.messagesDelivered, 2);
    assert.equal(res.acked, true);
  });
});

describe('chatsInWakeOrder', () => {
  it('puts probe_* rooms first even when they are listed last', () => {
    assert.deepEqual(
      chatsInWakeOrder([
        { chatId: 'chat-old', count: 1, latestAt: '2026-09-08T00:00:00.000Z' },
        { chatId: 'probe_agent-1_1', count: 1, latestAt: '2026-09-08T00:01:00.000Z' },
      ]).map((c) => c.chatId),
      ['probe_agent-1_1', 'chat-old'],
    );
  });
});

describe('runInboxLoop — no side poller', () => {
  it('does not export a probe-poll knob or a second loop', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/platform/inboxLoop.ts', import.meta.url), 'utf8'),
    );
    assert.doesNotMatch(src, /answerPublishProbes/);
    assert.doesNotMatch(src, /probePollMs/);
    assert.doesNotMatch(src, /DEFAULT_PROBE_POLL_MS/);
  });
});

describe('heldPassAfter (ZIG-1742)', () => {
  it('counts a capped hold with zero handover failures', () => {
    assert.equal(
      heldPassAfter(0, { acked: false, failures: 0, truncated: true }),
      1,
    );
    assert.equal(
      heldPassAfter(2, { acked: false, failures: 0, truncated: true }),
      3,
    );
  });

  it('resets when the watermark advances', () => {
    assert.equal(
      heldPassAfter(2, { acked: true, failures: 0, truncated: true }),
      0,
    );
  });
});

/**
 * ZIG-1840 — the watermark is given back in steps, so the stand-in's 90s
 * takeover window does not run against a whole poll pass.
 */
describe('pollInboxOnce — mid-pass ack (ZIG-1840)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  const T1 = '2026-09-14T07:59:00.000Z';

  function harness(rowAckTo: string | null) {
    const order: string[] = [];
    const ackedTokens: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/inbox') && !init?.method) {
        return new Response(
          JSON.stringify({
            asOf: '2026-09-14T08:00:00.000Z',
            deliveries: [
              {
                kind: 'message',
                responsibilityId: 'msg-1', resourceId: 'msg-1',
                chatId: 'chat-1',
                agreementId: null,
                taskId: null,
                actorId: 'user-1',
                assigneeId: 'agent-1',
                ts: T1,
                ...(rowAckTo ? { ackTo: rowAckTo } : {}),
              },
            ],
            deliveriesCapped: false,
            chats: [{ chatId: 'chat-1', count: 1, latestAt: T1 }],
            ackTo: 'ibxa2_whole-window',
            tasksAwaitingMe: [{ taskId: 'task-1', updatedAt: T1 }],
            truncatedTasks: 0,
            truncatedRequests: 0,
            openRequestsAwaitingMe: [],
            proposalsAwaitingMe: [],
            truncatedProposals: 0,
            connectionRequestsAwaitingMe: [],
            truncatedConnectionRequests: 0,
          }),
          { status: 200 },
        );
      }
      if (u.includes('/context/read/messages')) {
        return new Response(
          JSON.stringify({
            type: 'messages',
            via: { kind: 'chat', id: 'chat-1' },
            items: [
              {
                messageId: 'msg-1',
                text: 'the answer you were chasing',
                chatId: 'chat-1',
                sender: { agentId: 'user-1' },
                timestamp: T1,
              },
            ],
            hasMore: false,
            nextCursor: null,
            latestSequence: T1,
          }),
          { status: 200 },
        );
      }
      if (u.endsWith('/inbox/ack')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { upTo?: string };
        order.push('ack');
        ackedTokens.push(body.upTo ?? '');
        return new Response(JSON.stringify({ ackedUpTo: body.upTo }), {
          status: 200,
        });
      }
      return new Response('{}', { status: 404 });
    });
    return { order, ackedTokens };
  }

  const run = (order: string[]) =>
    pollInboxOnce({
      creds: { operatorKey: 'op', agentId: 'agent-1' },
      ownAgentId: 'agent-1',
      baseUrl: 'http://test',
      seen: new SeenMessages(),
      onMessage: async () => {
        order.push('message');
      },
      onResourceEvent: async () => {},
      onTask: async () => {
        order.push('task');
      },
    });

  it('acks the finished chat before the rest of the pass runs', async () => {
    const { order, ackedTokens } = harness('ibxa2_through-T1');
    await run(order);
    // The point of the change: the mark is back before the task is worked,
    // instead of after everything in the pass.
    assert.deepEqual(order, ['message', 'ack', 'task']);
    assert.equal(ackedTokens[0], 'ibxa2_whole-window');
  });

  it('falls back to one end-of-pass ack when the server mints no row token', async () => {
    const { order, ackedTokens } = harness(null);
    await run(order);
    assert.deepEqual(order, ['message', 'ack', 'task']);
    assert.deepEqual(ackedTokens, ['ibxa2_whole-window']);
  });
});

describe('runInboxLoop.stop releases the inbox host', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  function emptyInbox() {
    return new Response(
      JSON.stringify({
        asOf: '2026-09-15T00:00:00.000Z',
        deliveries: [],
        chats: [],
        ackTo: 't0',
        proposalsAwaitingMe: [],
        connectionRequestsAwaitingMe: [],
      }),
      { status: 200 },
    );
  }

  it('finishes an active delivery and acknowledges before releasing the lease', async () => {
    const order: string[] = [];
    let finishWork!: () => void;
    let started!: () => void;
    const work = new Promise<void>((resolve) => { finishWork = resolve; });
    const working = new Promise<void>((resolve) => { started = resolve; });
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        order.push('release'); return Response.json({ released: true });
      }
      if (String(url).endsWith('/inbox/ack')) {
        order.push('ack'); return Response.json({ ackedUpTo: 't1' });
      }
      return Response.json({ asOf: '2026-10-01T00:00:00Z', ackTo: 't1', chats: [],
        proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [],
        deliveries: [{ kind: 'task', responsibilityId: 'task-1', resourceId: 'task-1', taskId: 'task-1',
          assigneeId: 'agent-1', ts: '2026-10-01T00:00:00Z' }] });
    });
    const handle = runInboxLoop({
      creds: { operatorKey: 'op', agentId: 'agent-1' }, ownAgentId: 'agent-1',
      baseUrl: 'http://test', seen: new SeenMessages(), onMessage: async () => {},
      onResourceEvent: async () => { order.push('work'); started(); await work; order.push('finished'); },
    });
    await working;
    const stopped = handle.stop();
    await Promise.resolve();
    assert.deepEqual(order, ['work']);
    finishWork();
    await stopped;
    assert.equal(order.at(-1), 'release');
    assert.ok(order.indexOf('ack') > order.indexOf('finished'));
    assert.equal(order.filter(x => x === 'release').length, 1);
    await handle.stop();
    assert.equal(order.filter(x => x === 'release').length, 1);
  });

  it('aborts an idle long-poll so shutdown does not wait for its timeout', async () => {
    let polling!: () => void;
    const started = new Promise<void>((resolve) => { polling = resolve; });
    let aborted = false;
    let released = false;
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        released = true; return Response.json({ released: true });
      }
      if (String(url).includes('wait=')) {
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
          polling();
        });
      }
      return emptyInbox();
    });
    const handle = runInboxLoop({
      creds: { operatorKey: 'op', agentId: 'agent-1' }, ownAgentId: 'agent-1',
      baseUrl: 'http://test', seen: new SeenMessages(), onMessage: async () => {},
      onResourceEvent: async () => {},
    });
    await started;
    await handle.stop();
    assert.equal(aborted, true);
    assert.equal(released, true);
  });

  it('stop releases the lease after its bound even while a delivery is still running', async () => {
    const order: string[] = [];
    let finishWork!: () => void;
    let started!: () => void;
    const work = new Promise<void>((resolve) => { finishWork = resolve; });
    const working = new Promise<void>((resolve) => { started = resolve; });
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        order.push('release'); return Response.json({ released: true });
      }
      if (String(url).endsWith('/inbox/ack')) {
        order.push('ack'); return Response.json({ ackedUpTo: 't1' });
      }
      return Response.json({ asOf: '2026-10-01T00:00:00Z', ackTo: 't1', chats: [],
        proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [],
        deliveries: [{ kind: 'task', responsibilityId: 'task-1', resourceId: 'task-1', taskId: 'task-1',
          assigneeId: 'agent-1', ts: '2026-10-01T00:00:00Z' }] });
    });
    const handle = runInboxLoop({
      creds: { operatorKey: 'op', agentId: 'agent-1' }, ownAgentId: 'agent-1',
      baseUrl: 'http://test', seen: new SeenMessages(), onMessage: async () => {},
      onResourceEvent: async () => { started(); await work; order.push('finished'); },
    });
    await working;
    const finished = await handle.stop(5);
    assert.equal(finished, false);
    assert.deepEqual(order, ['release'], 'the lease goes before the pass is done');
    finishWork();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ['release', 'finished', 'ack'], 'the late pass acknowledges, and releases nothing twice');
  });

  it('DELETEs /inbox/host with the creds instance before returning', async () => {
    const calls: string[] = [];
    const instances: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${String(url)}`);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['X-Ziggs-Instance']) instances.push(headers['X-Ziggs-Instance']);
      if (method === 'DELETE' && String(url).includes('/inbox/host')) {
        return new Response(JSON.stringify({ released: true }), { status: 200 });
      }
      return emptyInbox();
    });

    const handle = runInboxLoop(
      {
        creds: { operatorKey: 'op', agentId: 'agent-1', instanceId: 'local:test:1' },
        ownAgentId: 'agent-1',
        baseUrl: 'http://test',
        seen: new SeenMessages(10),
        label: 'test',
        onMessage: async () => {},
        onResourceEvent: async () => {},
      },
      { waitSeconds: 0 },
    );
    await handle.stop();

    assert.ok(
      calls.some((c) => c === 'DELETE http://test/inbox/host'),
      `expected DELETE /inbox/host, saw ${JSON.stringify(calls)}`,
    );
    assert.ok(instances.includes('local:test:1'));
  });

  it('still stops when release fails', async () => {
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        return new Response('{"error":"boom"}', { status: 500 });
      }
      return emptyInbox();
    });

    const handle = runInboxLoop(
      {
        creds: { operatorKey: 'op', agentId: 'agent-1' },
        ownAgentId: 'agent-1',
        baseUrl: 'http://test',
        seen: new SeenMessages(10),
        label: 'test',
        onMessage: async () => {},
        onResourceEvent: async () => {},
      },
      { waitSeconds: 0 },
    );
    await handle.stop();
    assert.equal(handle.running, false);
  });
});


describe('exact assigned-message delivery', () => {
  afterEach(() => mock.restoreAll());
  for (const missing of [false, true]) it(missing ? 'holds acknowledgment when an assigned id cannot be read' : 'pages past ambient mail and preserves per-message recipient and agreement', async () => {
    const ts = '2026-09-01T00:00:00.000Z';
    const deliveries = ['m1', 'm3'].map((resourceId, i) => ({kind:'message',responsibilityId:resourceId,resourceId,chatId:'shared',agreementId:`work-${i}`,taskId:null,actorId:'person',assigneeId:'agent',ts}));
    const acks: unknown[] = [];
    const received: Array<Record<string, unknown>> = [];
    const cursors: Array<string | null> = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/inbox/ack')) { acks.push(JSON.parse(String(init?.body))); return Response.json({}); }
      if (path.endsWith('/inbox')) return Response.json({asOf:ts,deliveries,deliveriesCapped:false,chats:[{chatId:'shared',count:2,latestAt:ts}],ackTo:'checkpoint',tasksAwaitingMe:[],truncatedTasks:0,proposalsAwaitingMe:[],truncatedProposals:0,connectionRequestsAwaitingMe:[],truncatedConnectionRequests:0});
      if (path.includes('/context/read/messages')) {
        const cursor = new URL(path).searchParams.get('cursor'); cursors.push(cursor);
        const ids = !cursor ? ['m1','m2'] : missing ? [] : ['m3'];
        return Response.json({items:ids.map(messageId=>({messageId,text:messageId,receiver:{id:'itay',type:'user'},receiverId:'itay',timestamp:ts})),hasMore:!cursor,nextCursor:!cursor?'same-time-next':null,latestSequence:ts});
      }
      return Response.json({}, {status:404});
    });
    const pass = await pollInboxOnce({creds:{operatorKey:'op',agentId:'agent'},ownAgentId:'agent',baseUrl:'http://test',seen:new SeenMessages(),onMessage:async(text,metadata)=>{received.push({text,...metadata});},onResourceEvent:async()=>{}},0,{forceAck:true});
    assert.deepEqual(cursors,[null,'same-time-next']);
    assert.deepEqual(received.map(r=>r.messageId),missing?['m1']:['m1','m3']);
    assert.deepEqual(received.map(r=>r.agreementId),missing?['work-0']:['work-0','work-1']);
    assert.ok(received.every(r=>r.receiverId==='itay' && r.assigneeId==='agent'));
    assert.equal(pass.acked,true);
    assert.equal(acks.length,1);
    assert.deepEqual((acks[0] as {handledDeliveryIds:string[]}).handledDeliveryIds, missing ? ['m1'] : ['m1','m3']);
  });
});
