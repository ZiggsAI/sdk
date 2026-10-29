import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planPartialInboxAck } from '@ziggs-ai/api-client';
import {
  buildReadPlan,
  buildReadContextReadPlan,
  formatInboxToolResult,
  indexReachByScope,
  OUT_OF_REACH_NOTE,
  type ReadPlanCall,
} from '../src/inboxToolResult.js';

/**
 * A held context grant as GET /grants returns it (canonical GrantView): temporal
 * mode + read watermark ride in `caveats`, not as flat columns.
 */
function reachGrant(opts: {
  grantId: string;
  scope: { kind: 'chat' | 'agreement' | 'org'; id: string };
  temporal: 'from-now' | 'from-start';
  watermarkAt: string;
  expiresAt?: string | null;
  parentGrantId?: string | null;
}) {
  return {
    grantId: opts.grantId,
    issuerId: 'user-1',
    holderId: 'agent-1',
    parentGrantId: opts.parentGrantId ?? null,
    agreementId: null,
    scope: opts.scope,
    caveats: [
      { type: 'temporal', value: opts.temporal },
      { type: 'watermark_at', value: opts.watermarkAt },
    ],
    revoked: false,
    expiresAt: opts.expiresAt ?? null,
    createdAt: opts.watermarkAt,
    health: 'active' as const,
  };
}

/** A delivery reference as the inbox now hands it over. */
function delivery(
  over: Partial<{
    kind: string;
    resourceId: string;
    chatId: string | null;
    agreementId: string | null;
    taskId: string | null;
    ts: string;
  }> = {},
) {
  return {
    kind: 'message',
    responsibilityId: over.resourceId ?? 'msg-1', resourceId: 'msg-1',
    chatId: 'chat-1',
    agreementId: null,
    taskId: null,
    actorId: 'agent-x',
    assigneeId: 'agent-self',
    ts: '2026-06-17T01:00:00.000Z',
    ...over,
  };
}

describe('formatInboxToolResult (ZIG-482)', () => {
  const base = {
    asOf: '2026-06-17T00:00:00.000Z',
    deliveries: [] as any[],
    deliveriesCapped: false,
    chats: [] as any[],
    ackTo: null as string | null,
    tasksAwaitingMe: [] as any[],
    truncatedTasks: 0,
    proposalsAwaitingMe: [] as any[],
    truncatedProposals: 0,
    connectionRequestsAwaitingMe: [] as any[],
    truncatedConnectionRequests: 0,
  };

  it('puts humanAttention first when present', () => {
    const inbox = {
      ...base,
      connectionRequestsAwaitingMe: [],
      truncatedConnectionRequests: 0,
      proposalsAwaitingMe: [
        { agreementId: 'agr-1', title: 'Request', proposedAt: null },
      ],
      humanAttention: {
        required: true as const,
        reason: 'proposals_awaiting_me' as const,
        proposalCount: 1,
        truncatedProposals: 0,
        connectionRequestCount: 0,
        truncatedConnectionRequests: 0,
        promptUser: 'Tell the human now.',
      },
    };
    const out = formatInboxToolResult(inbox as any);
    assert.equal(Object.keys(out)[0], 'humanAttention');
    // The flag, the reason and the counts. The server's prompt line, which
    // quotes the proposal inside an imperative, does not ride on the result.
    const { promptUser, ...counts } = inbox.humanAttention;
    void promptUser;
    assert.deepEqual(out.humanAttention, counts);
    assert.deepEqual(out.proposalsAwaitingMe, inbox.proposalsAwaitingMe);
    assert.equal(out.pendingCount, 1);
    // ZIG-659: the inbox carries counts + a pointer, never the card itself.
    assert.equal('sessionChatCard' in out, false);
    assert.equal('decisionChatCard' in out, false);
    assert.match(String(out.sessionCardHint), /ziggs_inbox without waitSeconds/);
  });

  it('passes through inbox without humanAttention unchanged', () => {
    const out = formatInboxToolResult(base);
    assert.deepEqual(out, base);
  });

  it('surfaces activeTasksFetchError even when nothing else is actionable (ZIG-700)', () => {
    const out = formatInboxToolResult(
      base as any,
      null,
      'https://ziggsai.com',
      [],
      [],
      'GET /tasks 500 upstream exploded',
    );
    assert.equal(out.workCardOmitted, true);
    assert.match(String(out.activeTasksFetchError), /Could not load active tasks/);
    assert.match(String(out.activeTasksFetchError), /upstream exploded/);
  });

  it('surfaces active-task counts and points at the cold session read for the card (ZIG-659)', () => {
    const tasks = [
      {
        taskId: 'task-1',
        description: 'Build minimap',
        agreementId: 'agr-2',
        state: 'active',
      },
    ];
    const out = formatInboxToolResult(base, null, 'https://ziggsai.com', tasks as any);
    assert.equal(out.activeWorkCount, 1);
    assert.equal(out.actionCount, 1);
    // No card duplication in the inbox — just the pointer.
    assert.equal('sessionChatCard' in out, false);
    assert.equal('workChatCard' in out, false);
    assert.match(String(out.sessionCardHint), /ziggs_inbox without waitSeconds/);
  });

  it('ZIG-1120: derives activeWorkCount from inbox.tasksAwaitingMe when listTasks omitted', () => {
    const inbox = {
      ...base,
      tasksAwaitingMe: [
        {
          taskId: 'task-inbox-1',
          agreementId: 'agr-9',
          title: 'From envelope',
          state: 'active',
          updatedAt: null,
        },
      ],
    };
    const out = formatInboxToolResult(
      inbox as any,
      null,
      'https://ziggsai.com',
      undefined,
      undefined,
      undefined,
    );
    assert.equal(out.activeWorkCount, 1);
    assert.equal(out.actionCount, 1);
    assert.match(String(out.sessionCardHint), /ziggs_inbox without waitSeconds/);
  });

  it('omits readPlan when there is nothing to do', () => {
    const out = formatInboxToolResult(base);
    assert.equal('readPlan' in out, false);
  });

  it('attaches a typed readPlan when mail arrived', () => {
    const inbox = {
      ...base,
      deliveries: [delivery()],
      ackTo: '2026-06-17T01:00:00.000Z',
    };
    const out = formatInboxToolResult(inbox as any);
    const plan = out.readPlan as ReadPlanCall[];
    assert.ok(Array.isArray(plan));
    assert.ok(
      plan.some(
        (c) =>
          c.tool === 'ziggs_open' &&
          c.args.ref === 'chat-1',
      ),
    );
  });

  it('surfaces readPlanTruncated when the plan overflows the cap (ZIG-660/1305)', () => {
    // 30 chats × (a message + an artifact) = 60 read candidates.
    const deliveries = Array.from({ length: 30 }, (_, i) => [
      delivery({ chatId: `chat-${i}`, responsibilityId: `m-${i}`, resourceId: `m-${i}` }),
      delivery({ kind: 'artifact', chatId: `chat-${i}`, responsibilityId: `a-${i}`, resourceId: `a-${i}` }),
    ]).flat();
    const out = formatInboxToolResult({
      ...base,
      deliveries,
      ackTo: '2026-06-17T01:00:00.000Z',
    } as any);
    // Truncated plans omit the ack slot, so all 12 go to reads.
    assert.equal(out.readPlanTruncated, 60 - 12);
  });

  it('omits readPlanTruncated when nothing was dropped (ZIG-660)', () => {
    const out = formatInboxToolResult({
      ...base,
      deliveries: [delivery()],
      ackTo: '2026-06-17T01:00:00.000Z',
    } as any);
    assert.equal('readPlanTruncated' in out, false);
  });

  it('does not pin a grant id on open — AX-03 rechecks without one', () => {
    const inbox = { ...base, deliveries: [delivery()] };
    const reach = [
      reachGrant({
        grantId: 'grant-1',
        scope: { kind: 'chat', id: 'chat-1' },
        temporal: 'from-start',
        watermarkAt: '2026-06-01T00:00:00.000Z',
      }),
    ];
    const out = formatInboxToolResult(inbox as any, null, 'https://ziggsai.com', [], reach as any);
    const plan = out.readPlan as ReadPlanCall[];
    const read = plan.find((c) => c.tool === 'ziggs_open');
    assert.ok(read);
    assert.equal('contextGrantId' in read!.args, false);
    assert.equal(read!.args.ref, 'chat-1');
  });

  it('hire-room brief is a self work order on the inbox result', () => {
    const inbox = {
      ...base,
      deliveries: [
        {
          ...delivery({
            responsibilityId: 'msg-hire', resourceId: 'msg-hire',
            chatId: 'chat-hire',
            agreementId: 'agr-hire',
          }),
          assigneeId: 'agt_me',
          eventId: 'evt-hire',
          partyId: 'user_owner',
          partyKind: 'human',
          needsHuman: false,
        },
      ],
    };
    const out = formatInboxToolResult(
      inbox as any,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      { agentId: 'agt_me' },
    );
    const engagement = out.engagement as {
      kind: string;
      agreementId: string;
      chatId: string;
      next: { tool: string; args: { agreementId: string; assigneeId: string } };
    };
    assert.equal(engagement.kind, 'work_order');
    assert.equal(engagement.agreementId, 'agr-hire');
    assert.equal(engagement.chatId, 'chat-hire');
    assert.equal(engagement.next.tool, 'ziggs_task_create');
    assert.equal(engagement.next.args.agreementId, 'agr-hire');
    assert.equal(engagement.next.args.assigneeId, 'agt_me');
  });
});

describe('buildReadPlan (ZIG-634)', () => {
  const base = {
    asOf: '2026-06-17T00:00:00.000Z',
    deliveries: [] as any[],
    deliveriesCapped: false,
    chats: [] as any[],
    ackTo: null as string | null,
    tasksAwaitingMe: [] as any[],
    truncatedTasks: 0,
    proposalsAwaitingMe: [] as any[],
    truncatedProposals: 0,
    connectionRequestsAwaitingMe: [] as any[],
    truncatedConnectionRequests: 0,
  };

  it('pre-fills the read call for a chat with mail, then an ack call', () => {
    const inbox = {
      ...base,
      deliveries: [
        delivery({ responsibilityId: 'm-1', resourceId: 'm-1' }),
        delivery({ kind: 'artifact', responsibilityId: 'a-1', resourceId: 'a-1' }),
      ],
      ackTo: '2026-06-17T01:00:00.000Z',
    };
    const { plan } = buildReadPlan(inbox as any);
    assert.deepEqual(
      plan.find((c) => c.args.ref === 'chat-1')?.args,
      { ref: 'chat-1' },
    );
    assert.deepEqual(
      plan.find((c) => c.args.ref === 'a-1')?.args,
      { ref: 'a-1' },
    );
    const ack = plan.filter((c) => c.tool === 'ziggs_inbox_ack').at(-1);
    assert.ok(ack);
    assert.equal(ack!.args.ack, '2026-06-17T01:00:00.000Z');
    assert.deepEqual(ack!.args.handledDeliveryIds, ['m-1', 'a-1']);
  });

  it('names each chat the mail actually landed in — never a scope id', () => {
    const inbox = {
      ...base,
      deliveries: [
        delivery({ chatId: 'chat-a', responsibilityId: 'm-a', resourceId: 'm-a' }),
        delivery({ chatId: 'chat-b', responsibilityId: 'm-b', resourceId: 'm-b' }),
      ],
    };
    const { plan } = buildReadPlan(inbox as any);
    const chatIds = plan
      .filter((c) => c.tool === 'ziggs_open')
      .map((c) => c.args.ref);
    assert.ok(chatIds.includes('chat-a'));
    assert.ok(chatIds.includes('chat-b'));
    assert.ok(!chatIds.some((v) => String(v).startsWith('org:')));
  });

  it('reads a chat-less artifact through its agreement', () => {
    const inbox = {
      ...base,
      deliveries: [
        delivery({
          kind: 'artifact',
          chatId: null,
          agreementId: 'agr-9',
          responsibilityId: 'a-9', resourceId: 'a-9',
        }),
      ],
    };
    const { plan } = buildReadPlan(inbox as any);
    assert.ok(plan.some((c) => c.tool === 'ziggs_open' && c.args.ref === 'a-9'));
  });

  // A deliverable recorded against a task alone — the shape the delegate protocol
  // asks for — lands in no chat and no agreement. While the plan only looked at
  // chatId/agreementId this produced a plan containing the ack and nothing else,
  // so an agent following it acked the deliverable unread.
  it('reads a task-only artifact through its task', () => {
    const inbox = {
      ...base,
      deliveries: [
        delivery({
          kind: 'artifact',
          chatId: null,
          agreementId: null,
          taskId: 'task-7',
          responsibilityId: 'a-7', resourceId: 'a-7',
        }),
      ],
    };
    const { plan } = buildReadPlan(inbox as any);
    assert.ok(plan.some((c) => c.tool === 'ziggs_open' && c.args.ref === 'a-7'));
  });

  // ZIG-1075 — the anchor arms are total, so the shape that has no container is
  // planned rather than dropped. No emitter produces this delivery today (a
  // share writes a grant and no delivery row at all — ZIG-1100), which is
  // exactly why it is pinned here: the read entry ZIG-1037 added is ready, so
  // whoever emits it does not also have to remember this file.
  it('reads a free-standing artifact through the artifact itself', () => {
    const inbox = {
      ...base,
      deliveries: [
        delivery({
          kind: 'artifact',
          chatId: null,
          agreementId: null,
          taskId: null,
          responsibilityId: 'art_free', resourceId: 'art_free',
        }),
      ],
    };
    const { plan } = buildReadPlan(inbox as any);
    assert.ok(
      plan.some((c) => c.tool === 'ziggs_open' && c.args.ref === 'art_free'),
      'a delivery with no container is still read',
    );
  });

  // A task-state or agreement delivery plans no read on purpose: both arrive as
  // standing state elsewhere on the envelope and are planned from there. The
  // switch is exhaustive so this is a decision, not an omission.
  it('plans no duplicate read for task-state and agreement deliveries', () => {
    const inbox = {
      ...base,
      deliveries: [
        delivery({ kind: 'task-state', chatId: null, taskId: 'task-9', responsibilityId: 'task-9', resourceId: 'task-9' }),
        delivery({
          kind: 'agreement',
          chatId: null,
          agreementId: 'agr-9',
          responsibilityId: 'agr-9', resourceId: 'agr-9',
        }),
      ],
    };
    const { plan } = buildReadPlan(inbox as any);
    assert.deepEqual(
      plan.filter((c) => c.tool === 'ziggs_open'),
      [],
    );
  });

  it('prefers the chat over the task when a delivery names both', () => {
    const inbox = {
      ...base,
      deliveries: [
        delivery({
          kind: 'artifact',
          chatId: 'chat-3',
          taskId: 'task-3',
          responsibilityId: 'a-3', resourceId: 'a-3',
        }),
      ],
    };
    const { plan } = buildReadPlan(inbox as any);
    const opens = plan.filter((c) => c.tool === 'ziggs_open');
    assert.deepEqual(
      opens.map((c) => c.args),
      [{ ref: 'a-3' }],
    );
  });

  it('reads approval authority before offering an approval action', () => {
    const inbox = {
      ...base,
      proposalsAwaitingMe: [
        {
          agreementId: 'agr-1',
          title: 'Request',
          proposedAt: null,
          pendingApprovalPartyIds: ['agent-me'],
        },
      ],
      connectionRequestsAwaitingMe: [
        {
          requestId: 'req-1',
          requesterRef: 'psn_agent-x-face',
          message: null,
          requestedAt: null,
          pendingApprovalPartyIds: ['agent-me'],
        },
      ],
    };
    const { plan } = buildReadPlan(inbox as any, undefined, { agentId: 'agent-me' });
    assert.ok(
      plan.some(
        (c) => c.tool === 'ziggs_agreement_get' && c.args.agreementId === 'agr-1',
      ),
    );
    assert.ok(
      plan.some(
        (c) => c.tool === 'ziggs_agreement_get' && c.args.agreementId === 'req-1',
      ),
    );
  });

  /**
   * ZIG-1087 — the plan is a list of calls to run verbatim, so it must not
   * contain one that is refused every time. A decision bound to the principal's
   * slot goes to the card instead.
   */
  it('does not pre-fill a respond call for the human\'s own decision', () => {
    const inbox = {
      ...base,
      proposalsAwaitingMe: [
        {
          agreementId: 'agr-human',
          title: 'Hire',
          proposedAt: null,
          pendingApprovalPartyIds: ['user-owner'],
          proposedTo: 'user-owner',
        },
      ],
    };
    const { plan } = buildReadPlan(inbox as any, undefined, {
      agentId: 'agent-me',
      ownerUserId: 'user-owner',
    });
    assert.equal(
      plan.some((c) => c.tool === 'ziggs_agreement_respond'),
      false,
    );
    // ZIG-1384 #1 — the card now ships in this same response, so the plan no
    // longer routes to a second tool for it. What is left to do is read the
    // terms, so the human is told what they are being asked to approve.
    const handoff = plan.find((c) => c.tool === 'ziggs_agreement_get');
    assert.ok(handoff);
    assert.match(String(handoff!.why), /approvalAction/);
    assert.match(String(handoff!.why), /existing authority/);
  });

  it('caps the plan and omits ack when truncated so it cannot bury unread mail (ZIG-1305)', () => {
    const deliveries = Array.from({ length: 30 }, (_, i) => [
      delivery({ chatId: `chat-${i}`, responsibilityId: `m-${i}`, resourceId: `m-${i}` }),
      delivery({ kind: 'artifact', chatId: `chat-${i}`, responsibilityId: `a-${i}`, resourceId: `a-${i}` }),
    ]).flat();
    const { plan, truncated } = buildReadPlan({
      ...base,
      deliveries,
      ackTo: '2026-06-17T01:00:00.000Z',
    } as any);
    assert.ok(plan.length <= 12);
    // ZIG-1305 — a truncated plan must not pre-fill an ack that covers more
    // than its own steps (the old ZIG-660 "always keep ack" behavior buried
    // the unread chats).
    const ack = plan.filter((c) => c.tool === 'ziggs_inbox_ack').at(-1);
    assert.equal(ack, undefined, 'ack step must not appear when truncated');
    // 60 read candidates; full 12-slot budget goes to reads when ack is omitted.
    assert.equal(truncated, 48);
  });

  // ZIG-1897 — the plan ended at reading the person who spoke, so replying was
  // a step the agent had to assemble for itself. That is the step it skips
  // after it has already written the answer out in prose.
  it('ZIG-1897: plans the reply to a message addressed to me, in the room it arrived in', () => {
    const { plan } = buildReadPlan(
      {
        ...base,
        deliveries: [delivery({ responsibilityId: 'm-1', resourceId: 'm-1', assigneeId: 'agt_me' } as any)],
        ackTo: '2026-06-17T01:00:00.000Z',
      } as any,
      undefined,
      { agentId: 'agt_me' },
    );
    assert.equal(plan.find((c) => c.tool === 'ziggs_chat_send'), undefined);
  });

  it('ZIG-1897: plans no reply for mail that is not mine to answer', () => {
    const { plan } = buildReadPlan(
      {
        ...base,
        deliveries: [delivery({ responsibilityId: 'm-1', resourceId: 'm-1', assigneeId: 'agt_other' } as any)],
        ackTo: '2026-06-17T01:00:00.000Z',
      } as any,
      undefined,
      { agentId: 'agt_me' },
    );
    assert.equal(plan.find((c) => c.tool === 'ziggs_chat_send'), undefined);
  });

  it('ZIG-1897: a reply step never takes a slot from unread mail', () => {
    const deliveries = Array.from({ length: 30 }, (_, i) => [
      delivery({ chatId: `chat-${i}`, responsibilityId: `m-${i}`, resourceId: `m-${i}` }),
      delivery({ kind: 'artifact', chatId: `chat-${i}`, responsibilityId: `a-${i}`, resourceId: `a-${i}` }),
    ]).flat();
    const { plan, truncated } = buildReadPlan({
      ...base,
      deliveries,
      ackTo: '2026-06-17T01:00:00.000Z',
    } as any);
    assert.ok(plan.length <= 12);
    assert.equal(plan.find((c) => c.tool === 'ziggs_chat_send'), undefined);
    // And the dropped-candidate count still counts mail, not conveniences.
    assert.equal(truncated, 48);
  });

  it('pre-fills ack on a capped envelope when the plan covers the listed head (ZIG-1742)', () => {
    const { plan } = buildReadPlan({
      ...base,
      deliveries: [delivery({ responsibilityId: 'm-1', resourceId: 'm-1' })],
      deliveriesCapped: true,
      ackTo: '2026-06-17T01:00:00.000Z',
    } as any);
    const ack = plan.filter((c) => c.tool === 'ziggs_inbox_ack').at(-1);
    assert.ok(ack, 'capped head is ackable; the newer tail follows next pass');
    assert.deepEqual((ack as { args?: { handledDeliveryIds?: string[] } }).args?.handledDeliveryIds, [
      'm-1',
    ]);
  });

  it('dedups repeated reads of the same chat (ZIG-660)', () => {
    // Several messages in one chat are one read, not one read each.
    const inbox = {
      ...base,
      deliveries: [
        delivery({ responsibilityId: 'm-1', resourceId: 'm-1' }),
        delivery({ responsibilityId: 'm-2', resourceId: 'm-2' }),
        delivery({ responsibilityId: 'm-3', resourceId: 'm-3' }),
      ],
    };
    const { plan } = buildReadPlan(inbox as any);
    const chat1Reads = plan.filter(
      (c) => c.tool === 'ziggs_open' && c.args.ref === 'chat-1',
    );
    assert.equal(chat1Reads.length, 1);
  });

  it('does not pin a grant id on open (ZIG-1874)', () => {
    const inbox = { ...base, deliveries: [delivery()] };
    const byScope = new Map([
      [
        'chat:chat-1',
        {
          grantId: 'grant-1',
          temporal: 'from-start' as const,
          watermarkAt: '2026-06-01T00:00:00.000Z',
          expiresAt: null,
          parentGrantId: null,
        },
      ],
    ]);
    const { plan } = buildReadPlan(inbox as any, byScope);
    const read = plan.find((c) => c.tool === 'ziggs_open');
    assert.ok(read);
    assert.equal('contextGrantId' in read!.args, false);
  });
});

describe('buildReadContextReadPlan (ZIG-634)', () => {
  it('adds a forward-delta call from the page latestSequence', () => {
    const plan = buildReadContextReadPlan(
      { hasMore: false, nextCursor: null, latestSequence: 'seq-9' },
      'messages',
      'chat:chat-1',
    );
    assert.equal(plan.length, 1);
    assert.deepEqual(plan[0].args, {
      type: 'messages',
      via: 'chat:chat-1',
      direction: 'forward',
      after: 'seq-9',
    });
  });

  it('adds a cursor call when the page has more rows', () => {
    const plan = buildReadContextReadPlan(
      { hasMore: true, nextCursor: 'cur-2', latestSequence: 'seq-9' },
      'artifacts',
      'agreement:agr-1',
    );
    assert.ok(
      plan.some((c) => c.args.cursor === 'cur-2' && c.args.via === 'agreement:agr-1'),
    );
    assert.ok(plan.some((c) => c.args.after === 'seq-9'));
  });

  it('echoes back only the grant id the caller presented', () => {
    const withGrant = buildReadContextReadPlan(
      { latestSequence: 'seq-1' },
      'messages',
      'chat:chat-1',
      'grant-abc',
    );
    assert.equal(withGrant[0].args.contextGrantId, 'grant-abc');

    const withoutGrant = buildReadContextReadPlan(
      { latestSequence: 'seq-1' },
      'messages',
      'chat:chat-1',
    );
    assert.equal('contextGrantId' in withoutGrant[0].args, false);
  });

  it('returns nothing when the page has no continuation', () => {
    const plan = buildReadContextReadPlan(
      { hasMore: false, nextCursor: null, latestSequence: null },
      'tasks',
      'task:task-1',
    );
    assert.equal(plan.length, 0);
  });
});

describe('grant pinning from reach (ZIG-635)', () => {
  const base = {
    asOf: '2026-06-17T00:00:00.000Z',
    deliveries: [] as any[],
    deliveriesCapped: false,
    chats: [] as any[],
    ackTo: null as string | null,
    tasksAwaitingMe: [] as any[],
    truncatedTasks: 0,
    proposalsAwaitingMe: [] as any[],
    truncatedProposals: 0,
    connectionRequestsAwaitingMe: [] as any[],
    truncatedConnectionRequests: 0,
  };

  // Grants are pinned onto the read plan's calls now, not stamped onto scope
  // rows — there are no scope rows. The tagged case is covered by the readPlan
  // contextGrantId tests above; this holds the untagged fallback.
  it('leaves a read unpinned when no live grant covers its chat', () => {
    const out = formatInboxToolResult(
      { ...base, deliveries: [delivery()] } as any,
      null,
      'https://ziggsai.com',
      [],
      [] as any,
    );
    const read = (out.readPlan as ReadPlanCall[]).find(
      (c) => c.tool === 'ziggs_open',
    );
    assert.ok(read);
    assert.equal('contextGrantId' in read!.args, false);
  });

  it('prefers the broader grant (from-start, then earliest watermark)', () => {
    const reach = [
      reachGrant({
        grantId: 'narrow',
        scope: { kind: 'agreement', id: 'agr-1' },
        temporal: 'from-now',
        watermarkAt: '2026-06-15T00:00:00.000Z',
      }),
      reachGrant({
        grantId: 'broad',
        scope: { kind: 'agreement', id: 'agr-1' },
        temporal: 'from-start',
        watermarkAt: '2026-06-01T00:00:00.000Z',
      }),
    ];
    const byScope = indexReachByScope(reach as any);
    assert.equal(byScope.get('agreement:agr-1')?.grantId, 'broad');
  });
});

describe('the plan and the mail it cannot open', () => {
  const ME = 'agent-1';
  const envelope = (deliveries: unknown[]) => ({
    asOf: '2026-06-17T00:00:00.000Z',
    deliveries,
    deliveriesCapped: false,
    chats: [],
    ackTo: 'ack-token',
    tasksAwaitingMe: [],
    truncatedTasks: 0,
    proposalsAwaitingMe: [],
    truncatedProposals: 0,
    connectionRequestsAwaitingMe: [],
    truncatedConnectionRequests: 0,
  });
  const mine = (over: Record<string, unknown> = {}) => ({
    ...delivery(over as never),
    assigneeId: ME,
    ...over,
  });
  const theirs = (over: Record<string, unknown> = {}) => ({
    ...delivery(over as never),
    assigneeId: 'agent-other',
    ...over,
  });
  const ackStep = (plan: ReadPlanCall[]) =>
    plan.find((c) => c.tool === 'ziggs_inbox_ack');

  it('ZIG-1820: plans no read for a row the server says it cannot open', () => {
    const inbox = envelope([
      mine({ responsibilityId: 'msg-open', resourceId: 'msg-open', chatId: 'chat-open' }),
      mine({
        responsibilityId: 'msg-shut', resourceId: 'msg-shut',
        chatId: 'chat-shut',
        outOfReach: {
          scopeKind: 'chat',
          scopeId: 'chat-shut',
          remedy: 'You hold nothing that opens this chat.',
        },
      }),
    ]);

    const { plan, unreadable } = buildReadPlan(inbox as never, undefined, {
      agentId: ME,
    });
    const reads = plan.filter((c) => c.tool === 'ziggs_open');
    assert.deepEqual(
      reads.map((c) => c.args.ref),
      ['chat-open'],
    );
    // Said out loud, so the agent can carry it to its person instead of
    // running a call that refuses every time.
    assert.deepEqual(unreadable, [
      {
        resourceId: 'msg-shut',
        scopeKind: 'chat',
        scopeId: 'chat-shut',
        remedy: 'You hold nothing that opens this chat.',
        requestAccess: { tool: 'ziggs_access_request', args: { scopeKind: 'chat', scopeId: 'chat-shut', permission: 'read', temporal: 'from-start' }, requiredInput: ['reason', 'recipientId'], effect: 'request_only' },
        requestReplyAccess: { tool: 'ziggs_access_request', args: { scopeKind: 'chat', scopeId: 'chat-shut', permission: 'reply', temporal: 'from-start' }, requiredInput: ['reason', 'recipientId'], effect: 'request_only' },
      },
    ]);
    const out = formatInboxToolResult(inbox as never, null, undefined, [], [], undefined, {
      agentId: ME,
    });
    // ZIG-2170 — the rows are not listed again; the result says where to look.
    assert.equal('outOfReach' in out, false);
    assert.equal(out.outOfReachNote, OUT_OF_REACH_NOTE);
  });

  it('offers reply recovery only for the original chat, never as an automatic plan step', () => {
    const inbox = envelope(['chat', 'artifact', 'agreement', 'task', 'unknown'].map((scopeKind) => mine({
      responsibilityId: `notice-${scopeKind}`, resourceId: `notice-${scopeKind}`,
      outOfReach: { scopeKind, scopeId: `original-${scopeKind}`, remedy: 'Request access.' },
    })));
    const { plan, unreadable } = buildReadPlan(inbox as never, undefined, { agentId: ME });
    assert.equal(plan.some((call) => call.tool === 'ziggs_access_request' || call.tool === 'ziggs_chat_send'), false);
    for (const note of unreadable) {
      if (note.scopeKind === 'chat') {
        assert.equal(note.requestAccess?.args.permission, 'read');
        assert.equal(note.requestReplyAccess?.args.scopeId, 'original-chat');
        assert.equal(note.requestReplyAccess?.effect, 'request_only');
      } else {
        assert.equal(note.requestReplyAccess, undefined);
      }
    }
  });

  it('ZIG-1820: an unopenable row is not claimed as handled in the ack', () => {
    const inbox = envelope([
      mine({ responsibilityId: 'msg-open', resourceId: 'msg-open', chatId: 'chat-open' }),
      mine({
        responsibilityId: 'msg-shut', resourceId: 'msg-shut',
        chatId: 'chat-shut',
        // The server reports it unassigned; the stamp went with the reach.
        assigneeId: null,
        outOfReach: {
          scopeKind: 'chat',
          scopeId: 'chat-shut',
          remedy: 'Ask the other side to share it.',
        },
      }),
    ]);
    const { plan } = buildReadPlan(inbox as never, undefined, { agentId: ME });
    assert.deepEqual(ackStep(plan)!.args.handledDeliveryIds, ['msg-open']);
  });

  it('ZIG-1819: ambient mail crowding out its own reads still leaves the ack', () => {
    // Twenty rooms of someone else's mail — a person's mailbox, read by their
    // assistant. Before this the overflow dropped the ack, nothing advanced the
    // watermark, and the next read produced the identical overflowing plan.
    const ambient = Array.from({ length: 20 }, (_, i) =>
      theirs({ responsibilityId: `msg-amb-${i}`, resourceId: `msg-amb-${i}`, chatId: `chat-amb-${i}` }),
    );
    const inbox = envelope([
      ...ambient,
      mine({ responsibilityId: 'msg-mine', resourceId: 'msg-mine', chatId: 'chat-mine' }),
    ]);

    const { plan, truncated } = buildReadPlan(inbox as never, undefined, {
      agentId: ME,
    });
    assert.ok(truncated > 0, 'the ambient reads do not all fit');
    // My own read comes first, and the ack survives the truncation.
    assert.equal(plan[0]!.args.ref, 'chat-mine');
    assert.deepEqual(ackStep(plan)!.args.handledDeliveryIds, ['msg-mine']);
  });

  it('ZIG-1819: a plan that drops one of MY reads still omits the ack', () => {
    // The guard this protects is the server's: it refuses an ack that buries a
    // row assigned to me. So my own reads overflowing is the one case that
    // must still cost the ack.
    const inbox = envelope(
      Array.from({ length: 20 }, (_, i) =>
        mine({ responsibilityId: `msg-${i}`, resourceId: `msg-${i}`, chatId: `chat-${i}` }),
      ),
    );
    const { plan, truncated } = buildReadPlan(inbox as never, undefined, {
      agentId: ME,
    });
    assert.ok(truncated > 0);
    assert.equal(ackStep(plan), undefined);
  });
});

/**
 * ZIG-1841 — a checkpoint ack after the first assigned step, so the stand-in's
 * 90s takeover does not run against the caller's whole turn.
 */
describe('buildReadPlan — checkpoint ack (ZIG-1841)', () => {
  const T1 = '2026-06-17T01:00:00.000Z';
  const T2 = '2026-06-17T02:00:00.000Z';
  const self = { agentId: 'agent-1' };

  const envelope = (over: Record<string, unknown> = {}) => ({
    asOf: T2,
    deliveries: [
      {
        ...delivery({ responsibilityId: 'msg-a', resourceId: 'msg-a', chatId: 'chat-a', ts: T1 }),
        assigneeId: 'agent-1',
        ackTo: 'tok-T1',
      },
      {
        ...delivery({ responsibilityId: 'msg-b', resourceId: 'msg-b', chatId: 'chat-b', ts: T2 }),
        assigneeId: 'agent-1',
        ackTo: 'tok-T2',
      },
    ],
    deliveriesCapped: false,
    chats: [],
    ackTo: 'tok-T2',
    tasksAwaitingMe: [],
    truncatedTasks: 0,
    truncatedRequests: 0,
    proposalsAwaitingMe: [],
    truncatedProposals: 0,
    connectionRequestsAwaitingMe: [],
    truncatedConnectionRequests: 0,
    ...over,
  });

  const acks = (plan: ReadPlanCall[]) =>
    plan.filter((c) => c.tool === 'ziggs_inbox_ack');

  it('lands the checkpoint at position 1, right after the oldest read', () => {
    const { plan } = buildReadPlan(envelope() as any, undefined, self);
    assert.equal(plan[0]!.tool, 'ziggs_open');
    assert.equal(plan[0]!.args.ref, 'chat-a');
    assert.equal(plan[1]!.tool, 'ziggs_inbox_ack');
    assert.equal(plan[1]!.args.ack, 'tok-T2');
    assert.deepEqual(plan[1]!.args.handledDeliveryIds, ['msg-a']);
    // and the final ack still closes the window
    const last = plan[plan.length - 1]!;
    assert.equal(last.tool, 'ziggs_inbox_ack');
    assert.equal(last.args.ack, 'tok-T2');
  });

  it('costs exactly one extra step, never one per read', () => {
    assert.equal(acks(buildReadPlan(envelope() as any, undefined, self).plan).length, 2);
  });

  it('adds nothing when the checkpoint would be the final mark anyway', () => {
    // One chat: acking after it is the whole window, so a checkpoint is a
    // wasted call and a second chance to ack unread work.
    const one = envelope({
      deliveries: [
        {
          ...delivery({ responsibilityId: 'msg-a', resourceId: 'msg-a', chatId: 'chat-a', ts: T1 }),
          assigneeId: 'agent-1',
          ackTo: 'tok-T1',
        },
      ],
      ackTo: 'tok-T1',
    });
    assert.equal(acks(buildReadPlan(one as any, undefined, self).plan).length, 1);
  });

  it('can acknowledge independently without per-row tokens', () => {
    const old = envelope({
      deliveries: envelope().deliveries.map(({ ackTo, ...d }: any) => d),
    });
    assert.equal(acks(buildReadPlan(old as any, undefined, self).plan).length, 2);
  });
});

/**
 * A decision on a request this side made arrives as an agreement row whose
 * reason names it. Planned generically that row said nothing, and an agent
 * learned it had been approved or refused only if it happened to list its
 * agreements. Now the row is planned as a read of the agreement whose `why` is
 * what was decided, and the result leads with `decidedForMe`.
 */
describe('decisions on requests I made', () => {
  const ME = 'agent-1';
  const T = '2026-06-17T01:00:00.000Z';
  const envelope = (deliveries: unknown[]) => ({
    asOf: T,
    deliveries,
    deliveriesCapped: false,
    chats: [],
    ackTo: 'ack-token',
    tasksAwaitingMe: [],
    truncatedTasks: 0,
    proposalsAwaitingMe: [],
    truncatedProposals: 0,
    connectionRequestsAwaitingMe: [],
    truncatedConnectionRequests: 0,
  });
  const agreementRow = (over: Record<string, unknown>) => ({
    kind: 'agreement',
    responsibilityId: 'agr-req', resourceId: 'agr-req',
    agreementId: 'agr-req',
    chatId: null,
    taskId: null,
    assigneeId: ME,
    actorId: 'user-owner',
    ts: T,
    ...over,
  });

  it('an approved access request is planned as a read whose why says it was approved', () => {
    const inbox = envelope([agreementRow({ reason: 'context_request_fulfilled' })]);
    const { plan } = buildReadPlan(inbox as never, undefined, { agentId: ME });
    const read = plan.find((c) => c.tool === 'ziggs_open');
    assert.ok(read, 'the decision row is planned as a read');
    assert.deepEqual(read!.args, { ref: 'agr-req' });
    assert.equal(
      read!.why,
      `Your access request on agreement agr-req was approved by user-owner at ${T}. ` +
        'Open the agreement with ziggs_open to find the artifact, then open the artifact with ziggs_context_read or ziggs_open; ' +
        'the grant is bounded, check its expiry on the agreement.',
    );
    // The row is mine, so the ack covers it.
    const ack = plan.filter((c) => c.tool === 'ziggs_inbox_ack').at(-1);
    assert.deepEqual(ack!.args.handledDeliveryIds, ['agr-req']);
  });

  it('keeps inaccessible decisions out of every runnable path', () => {
    const outOfReach = {
      scopeKind: 'agreement', scopeId: 'agr-req', remedy: 'Ask the owner for access',
    };
    const inbox = envelope([agreementRow({
      reason: 'context_request_fulfilled', assigneeId: null,
      artifactId: 'art-budget', outOfReach,
    })]);
    const out = formatInboxToolResult(inbox as never, null, undefined,
      undefined, undefined, undefined, { agentId: ME });
    assert.equal('decidedForMe' in out, false);
    assert.equal('outOfReach' in out, false);
    assert.equal(out.outOfReachNote, OUT_OF_REACH_NOTE);
    assert.equal((out.readPlan as ReadPlanCall[]).some(c => c.tool === 'ziggs_open'), false);
  });

  it('a refused access request says so and where to report it', () => {
    const inbox = envelope([agreementRow({ reason: 'context_request_rejected' })]);
    const { plan } = buildReadPlan(inbox as never, undefined, { agentId: ME });
    const read = plan.find((c) => c.tool === 'ziggs_open');
    assert.ok(read);
    assert.equal(
      read!.why,
      `Your access request on agreement agr-req was refused by user-owner at ${T}. ` +
        'Report the unresolved dependency where you asked, and ask what to change.',
    );
    assert.doesNotMatch(read!.why, /open the agreement agr-req/);
  });

  it('an agreement row with no decision reason still plans no read', () => {
    const inbox = envelope([
      agreementRow({ reason: undefined }),
      agreementRow({ responsibilityId: 'agr-claim', resourceId: 'agr-claim', agreementId: 'agr-claim', reason: 'proposal_approved' }),
    ]);
    const { plan } = buildReadPlan(inbox as never, undefined, { agentId: ME });
    assert.deepEqual(plan.filter((c) => c.tool === 'ziggs_open'), []);
    const out = formatInboxToolResult(inbox as never, null, undefined, undefined, undefined, undefined, {
      agentId: ME,
    });
    assert.equal('decidedForMe' in out, false);
  });

  it('leads the result with decidedForMe, refusals first, each with its typed next call', () => {
    const T2 = '2026-06-17T02:00:00.000Z';
    const inbox = envelope([
      agreementRow({ reason: 'context_request_fulfilled' }),
      agreementRow({
        responsibilityId: 'agr-no', resourceId: 'agr-no',
        agreementId: 'agr-no',
        reason: 'approval:rejected',
        actorId: 'user-other',
        ts: T2,
      }),
    ]);
    const out = formatInboxToolResult(inbox as never, null, undefined, undefined, undefined, undefined, {
      agentId: ME,
    });
    assert.equal(Object.keys(out)[0], 'decidedForMe');
    const decided = out.decidedForMe as Array<Record<string, unknown>>;
    assert.equal(decided.length, 2);
    // The refusal comes first: that is the one with work still owed.
    assert.equal(decided[0].agreementId, 'agr-no');
    assert.equal(decided[0].outcome, 'rejected');
    assert.equal(decided[0].by, 'user-other');
    assert.equal(decided[0].at, T2);
    assert.match(String(decided[0].sentence), /^Your request on agreement agr-no was refused by user-other at /);
    assert.deepEqual(decided[0].next, [
      { tool: 'ziggs_open', args: { ref: 'agr-no' }, why: decided[0].sentence },
    ]);
    assert.equal(decided[1].agreementId, 'agr-req');
    assert.equal(decided[1].outcome, 'fulfilled');
    assert.equal(decided[1].by, 'user-owner');
    // Today's row does not name the artifact, so neither does the entry.
    assert.equal('artifactId' in decided[1], false);
    assert.deepEqual(decided[1].next, [
      { tool: 'ziggs_open', args: { ref: 'agr-req' }, why: decided[1].sentence },
    ]);
    // The plan step for the same row carries the same sentence.
    const plan = out.readPlan as ReadPlanCall[];
    assert.equal(
      plan.find((c) => c.tool === 'ziggs_open' && c.args.ref === 'agr-req')?.why,
      decided[1].sentence,
    );
  });

  it('names the artifact and plans its read when a row carries the id', () => {
    const inbox = envelope([
      agreementRow({ reason: 'context_request_fulfilled', artifactId: 'art-9' }),
    ]);
    const out = formatInboxToolResult(inbox as never, null, undefined, undefined, undefined, undefined, {
      agentId: ME,
    });
    const [entry] = out.decidedForMe as Array<Record<string, unknown>>;
    assert.equal(entry.artifactId, 'art-9');
    assert.match(String(entry.sentence), /Open the artifact art-9 with ziggs_context_read or ziggs_open/);
    const next = entry.next as ReadPlanCall[];
    assert.deepEqual(
      next.map((c) => c.args),
      [{ ref: 'agr-req' }, { ref: 'art-9' }],
    );
  });

  it('humanAttention still outranks decidedForMe', () => {
    const inbox = {
      ...envelope([agreementRow({ reason: 'approval:rejected' })]),
      humanAttention: {
        required: true as const,
        reason: 'proposals_awaiting_me' as const,
        proposalCount: 1,
        truncatedProposals: 0,
        connectionRequestCount: 0,
        truncatedConnectionRequests: 0,
        promptUser: 'Tell the human now.',
      },
    };
    const out = formatInboxToolResult(inbox as never, null, undefined, undefined, undefined, undefined, {
      agentId: ME,
    });
    assert.deepEqual(Object.keys(out).slice(0, 2), ['humanAttention', 'decidedForMe']);
  });

  it('a decision on an ambient row is still reported, and not acked as mine', () => {
    const inbox = envelope([
      agreementRow({ reason: 'context_request_rejected', assigneeId: null }),
    ]);
    const out = formatInboxToolResult(inbox as never, null, undefined, undefined, undefined, undefined, {
      agentId: ME,
    });
    assert.equal((out.decidedForMe as unknown[]).length, 1);
    const plan = out.readPlan as ReadPlanCall[];
    assert.deepEqual(plan.find((c) => c.tool === 'ziggs_inbox_ack')!.args.handledDeliveryIds, []);
  });
});

/**
 * The pre-filled ack says exactly what the server checks. It refuses an ack
 * that passes over an ASSIGNED row not listed; rows assigned to nobody or to
 * someone else never gate. The old sentence asked for "every step above",
 * which included ambient reads, so an agent that had not opened someone else's
 * mail held its own mark back.
 */
describe('the ack asserts only assigned rows', () => {
  const ME = 'agent-1';
  const T1 = '2026-06-17T01:00:00.000Z';
  const T2 = '2026-06-17T02:00:00.000Z';
  const T3 = '2026-06-17T03:00:00.000Z';
  const envelope = (deliveries: unknown[], ackTo = 'tok-end') => ({
    asOf: T3,
    deliveries,
    deliveriesCapped: false,
    chats: [],
    ackTo,
    tasksAwaitingMe: [],
    truncatedTasks: 0,
    proposalsAwaitingMe: [],
    truncatedProposals: 0,
    connectionRequestsAwaitingMe: [],
    truncatedConnectionRequests: 0,
  });
  const row = (over: Record<string, unknown>) => ({
    ...delivery(over as never),
    ...over,
  });
  const ackStep = (plan: ReadPlanCall[]) =>
    plan.filter((c) => c.tool === 'ziggs_inbox_ack').at(-1)!;

  it('the final why lists the assigned ids and no ambient id', () => {
    const inbox = envelope([
      row({ responsibilityId: 'msg-mine-1', resourceId: 'msg-mine-1', chatId: 'chat-a', assigneeId: ME, ts: T1 }),
      row({ responsibilityId: 'msg-amb-1', resourceId: 'msg-amb-1', chatId: 'chat-b', assigneeId: 'agent-other', ts: T1 }),
      row({ responsibilityId: 'msg-mine-2', resourceId: 'msg-mine-2', chatId: 'chat-c', assigneeId: ME, ts: T2 }),
      row({ responsibilityId: 'msg-amb-2', resourceId: 'msg-amb-2', chatId: 'chat-d', assigneeId: null, ts: T2 }),
    ]);
    const { plan } = buildReadPlan(inbox as never, undefined, { agentId: ME });
    const ack = ackStep(plan);
    assert.deepEqual(ack.args.handledDeliveryIds, ['msg-mine-1', 'msg-mine-2']);
    assert.match(ack.why, /acking asserts you handled these ASSIGNED rows: \[msg-mine-1, msg-mine-2\]\./);
    assert.doesNotMatch(ack.why, /msg-amb/);
    assert.match(ack.why, /Reads of rows assigned to others never count; skip them freely\./);
    assert.doesNotMatch(ack.why, /every step above/);
  });

  it('says how to stop early, with a row\'s own ackTo', () => {
    const inbox = envelope([row({ responsibilityId: 'm-1', resourceId: 'm-1', assigneeId: ME, ts: T1 })]);
    const { plan } = buildReadPlan(inbox as never, undefined, { agentId: ME });
    assert.match(
      ackStep(plan).why,
      /Handled only some\? Pass the same ackTo/,
    );
  });

  it('three assigned rows: the first two ack from the second row\'s own token', () => {
    const inbox = envelope(
      [
        row({ responsibilityId: 'm-1', resourceId: 'm-1', chatId: 'chat-1', assigneeId: ME, ts: T1, ackTo: 'tok-1' }),
        row({ responsibilityId: 'm-2', resourceId: 'm-2', chatId: 'chat-2', assigneeId: ME, ts: T2, ackTo: 'tok-2' }),
        row({ responsibilityId: 'm-3', resourceId: 'm-3', chatId: 'chat-3', assigneeId: ME, ts: T3, ackTo: 'tok-3' }),
      ],
      'tok-3',
    );
    const partial = planPartialInboxAck(inbox as never, new Set(['m-1', 'm-2']), {
      ownAgentId: ME,
    });
    assert.deepEqual(partial, { ackTo: 'tok-3', handledDeliveryIds: ['m-1', 'm-2'] });
    // Out of order is refused by construction: the second row alone reaches
    // nothing, because the first is still unhandled at an earlier instant.
    assert.deepEqual(planPartialInboxAck(inbox as never, new Set(['m-2']), { ownAgentId: ME }), { ackTo: 'tok-3', handledDeliveryIds: ['m-2'] });
    // The plan itself is unchanged in shape: one checkpoint after the first
    // assigned step, from that row's token, then the final ack.
    const { plan } = buildReadPlan(inbox as never, undefined, { agentId: ME });
    const acks = plan.filter((c) => c.tool === 'ziggs_inbox_ack');
    assert.equal(acks.length, 2);
    assert.deepEqual(acks[0]!.args, { ack: 'tok-3', handledDeliveryIds: ['m-1'] });
    assert.deepEqual(acks[1]!.args, { ack: 'tok-3', handledDeliveryIds: ['m-1', 'm-2', 'm-3'] });
  });

  it('a window with nothing assigned says so instead of listing nothing', () => {
    const inbox = envelope([
      row({ responsibilityId: 'msg-amb', resourceId: 'msg-amb', chatId: 'chat-b', assigneeId: 'agent-other', ts: T1 }),
    ]);
    const { plan } = buildReadPlan(inbox as never, undefined, { agentId: ME });
    const ack = ackStep(plan);
    assert.deepEqual(ack.args.handledDeliveryIds, []);
    assert.match(ack.why, /no row in this window is assigned to you/);
  });
});

/**
 * A result may carry server state and typed next calls. It may not tell the
 * model how to word its reply, and it may not put a counterparty's words
 * inside an imperative. The card is data built from structured rows; the
 * prose fields name ids only.
 */
describe('no reply directive and no counterparty text outside the card', () => {
  const ME = 'agt_me';
  const TITLE = 'TITLE_SENTINEL_7c1';
  const MESSAGE = 'MESSAGE_SENTINEL_7c1';
  const TASK = 'TASK_SENTINEL_7c1';
  const inbox = {
    asOf: '2026-06-17T00:00:00.000Z',
    deliveries: [
      {
        ...delivery({ responsibilityId: 'msg-hire', resourceId: 'msg-hire', chatId: 'chat-hire', agreementId: 'agr-hire' }),
        assigneeId: ME,
        eventId: 'evt-hire',
        partyId: 'user_owner',
        partyKind: 'human',
        needsHuman: false,
      },
    ],
    deliveriesCapped: false,
    chats: [],
    ackTo: 'tok',
    tasksAwaitingMe: [
      { taskId: 'task-1', agreementId: 'agr-hire', title: TASK, state: 'active', updatedAt: null },
    ],
    truncatedTasks: 0,
    proposalsAwaitingMe: [
      {
        agreementId: 'agr-p',
        title: TITLE,
        proposedAt: null,
        pendingApprovalPartyIds: ['user_owner'],
        proposedTo: 'user_owner',
      },
    ],
    truncatedProposals: 0,
    connectionRequestsAwaitingMe: [
      {
        requestId: 'req-l',
        requesterRef: 'psn_face',
        requesterDisplayName: 'Someone',
        requesterOrgName: 'Elsewhere',
        message: MESSAGE,
        requestedAt: null,
        pendingApprovalPartyIds: ['user_owner'],
        proposedTo: 'user_owner',
      },
    ],
    truncatedConnectionRequests: 0,
    humanAttention: {
      required: true as const,
      reason: 'multiple' as const,
      proposalCount: 1,
      truncatedProposals: 0,
      connectionRequestCount: 1,
      truncatedConnectionRequests: 0,
      promptUser: `Tell the human about ${TITLE} and "${MESSAGE}" now.`,
    },
  };

  it('the inbox result carries no instruction, nextActions or promptUser', () => {
    const out = formatInboxToolResult(inbox as never, null, undefined, undefined, undefined, undefined, {
      agentId: ME,
      ownerUserId: 'user_owner',
    });
    assert.equal('instruction' in out, false);
    assert.equal('nextActions' in out, false);
    assert.equal('promptUser' in (out.humanAttention as Record<string, unknown>), false);
  });

  it('readPlan why lines, engagement and the attention block name ids, never a title or message', () => {
    const out = formatInboxToolResult(inbox as never, null, undefined, undefined, undefined, undefined, {
      agentId: ME,
      ownerUserId: 'user_owner',
    });
    const plan = out.readPlan as ReadPlanCall[];
    assert.ok(plan.length > 0);
    assert.ok(out.engagement, 'the hire-room brief yields an engagement block');
    for (const field of ['readPlan', 'engagement', 'humanAttention', 'sessionCardHint']) {
      const text = JSON.stringify(out[field] ?? null);
      assert.doesNotMatch(text, new RegExp(TITLE), `${field} carries the proposal title`);
      assert.doesNotMatch(text, new RegExp(MESSAGE), `${field} carries the link message`);
      assert.doesNotMatch(text, new RegExp(TASK), `${field} carries the task title`);
    }
    // The human-slot why still says the card carries the terms, without
    // telling the model to paste anything.
    const handoff = plan.find((c) => c.tool === 'ziggs_agreement_get');
    assert.ok(handoff);
    assert.match(handoff!.why, /approvalAction/);
    assert.doesNotMatch(handoff!.why, /paste/i);
    assert.doesNotMatch(handoff!.why, /delegate/i);
  });
});
