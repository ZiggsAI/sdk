import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  agreementAppUrl,
  buildPendingDecisionItems,
  filterTasksForDelegate,
  formatPendingDecisionsPayload,
} from '../src/pendingDecisions.js';

describe('filterTasksForDelegate (ZIG-658)', () => {
  const selfIds = new Set(['agent-me', 'user-owner']);
  const base = { description: 'x', state: 'active' as const };

  it('keeps tasks explicitly assigned to the delegate or its principal', () => {
    const tasks = [
      { ...base, taskId: 't1', assigneeId: 'agent-me' },
      { ...base, taskId: 't2', assigneeId: 'user-owner' },
      { ...base, taskId: 't3', assigneeId: 'agent-someone-else' },
    ];
    const kept = filterTasksForDelegate(tasks as never[], selfIds);
    assert.deepEqual(kept.map((t) => t.taskId), ['t1', 't2']);
  });

  it('an explicit assignee to someone else wins over party membership', () => {
    const tasks = [
      {
        ...base,
        taskId: 't1',
        assigneeId: 'agent-other',
        agreement: { agreementId: 'a', description: '', status: 'active', counterparty: null, parties: { provider: { actor: 'agent-me' } } },
      },
    ];
    assert.equal(filterTasksForDelegate(tasks as never[], selfIds).length, 0);
  });

  it('keeps unassigned tasks where the delegate is on the executing side', () => {
    const tasks = [
      { ...base, taskId: 't1', executorId: 'agent-me' },
      {
        ...base,
        taskId: 't2',
        agreement: { agreementId: 'a', description: '', status: 'active', counterparty: null, parties: { provider: { actor: 'agent-me' } } },
      },
      {
        ...base,
        taskId: 't3',
        agreement: { agreementId: 'b', description: '', status: 'active', counterparty: null, parties: { proposedTo: { principal: 'user-owner' } } },
      },
    ];
    assert.equal(filterTasksForDelegate(tasks as never[], selfIds).length, 3);
  });

  it("drops other users' tasks and tasks it cannot attribute", () => {
    const tasks = [
      {
        ...base,
        taskId: 't1',
        agreement: { agreementId: 'a', description: '', status: 'active', counterparty: null, parties: { provider: { actor: 'agent-third-party' } } },
      },
      { ...base, taskId: 't2' }, // no assignee, no agreement info
    ];
    assert.equal(filterTasksForDelegate(tasks as never[], selfIds).length, 0);
  });
});

describe('pendingDecisions (ZIG-625)', () => {
  // ZIG-1087: who may answer is now part of the shape, so the fixture has to
  // say whose slot is pending. Here it is the delegate's own.
  const inbox = {
    asOf: '2026-06-17T00:00:00.000Z',
    scopes: [],
    truncatedScopes: 0,
    countCap: 100,
    proposalsAwaitingMe: [
      {
        agreementId: 'agr-1',
        title: 'Translate docs',
        proposedAt: '2026-06-17T01:00:00.000Z',
        pendingApprovalPartyIds: ['agent-me'],
        proposedTo: 'agent-me',
      },
    ],
    truncatedProposals: 0,
    connectionRequestsAwaitingMe: [
      {
        requestId: 'req-9',
        requesterRef: 'psn_delegate-face',
        requesterDisplayName: "lab-cleo's delegate",
        requesterOrgName: 'Lab Globex',
        message: 'Need to collaborate',
        requestedAt: null,
        pendingApprovalPartyIds: ['agent-me'],
        proposedTo: 'agent-me',
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
      promptUser: 'Human attention required.',
    },
  };

  it('builds app URLs on ziggsai.com', () => {
    assert.equal(
      agreementAppUrl('https://ziggsai.com', 'agr-1'),
      'https://ziggsai.com/app/agreements/agr-1',
    );
  });

  it('formats structured payload with the session card', () => {
    const out = formatPendingDecisionsPayload(inbox as any, 'https://ziggsai.com');
    assert.equal(out.pendingCount, 2);
    assert.equal(out.hasPending, true);
    assert.equal((out.decisions as any[]).length, 2);
    assert.match(String(out.sessionChatCard), /agr-1/);
    assert.match(String(out.sessionChatCard), /req-9/);
    assert.match(String(out.sessionChatCard), /Heads-up/);
    assert.match(String(out.sessionChatCard), /approvalAction/);
    assert.doesNotMatch(String(out.sessionChatCard), /You say in chat/);
    // ZIG-1039: link consent title uses display name + org, not opaque id.
    assert.match(String(out.sessionChatCard), /lab-cleo's delegate \(Lab Globex\)/);
    assert.doesNotMatch(
      String(out.sessionChatCard),
      /Agent link · psn_delegate-face/,
    );
    assert.equal((out.summary as any).proposals, 1);
    assert.equal((out.summary as any).linkRequests, 1);
    assert.equal(out.agreementsListAppUrl, 'https://ziggsai.com/app/agreements');
  });

  it('ships one card (sessionChatCard) — not the old decision/work duplicates (ZIG-659)', () => {
    const out = formatPendingDecisionsPayload(inbox as any, 'https://ziggsai.com');
    assert.equal(typeof out.sessionChatCard, 'string');
    assert.equal('decisionChatCard' in out, false);
    assert.equal('workChatCard' in out, false);
  });

  it('omits the card and points at the cold session read when withSessionCard=false (ZIG-659)', () => {
    const out = formatPendingDecisionsPayload(inbox as any, 'https://ziggsai.com', {
      withSessionCard: false,
    });
    assert.equal(out.hasActionable, true);
    assert.equal('sessionChatCard' in out, false);
    assert.match(String(out.sessionCardHint), /ziggs_inbox without waitSeconds/);
  });

  it('surfaces activeTasksFetchError instead of a silent hasActiveWork:false (ZIG-700)', () => {
    const out = formatPendingDecisionsPayload(inbox as any, 'https://ziggsai.com', {
      activeTasks: [],
      activeTasksError: 'GET /tasks 500 upstream exploded',
    });
    assert.equal(out.hasActiveWork, false);
    assert.equal(out.workCardOmitted, true);
    assert.match(String(out.activeTasksFetchError), /Could not load active tasks/);
    assert.match(String(out.activeTasksFetchError), /upstream exploded/);
  });

  it('omits the fetch-error flag when tasks loaded fine (ZIG-700)', () => {
    const out = formatPendingDecisionsPayload(inbox as any, 'https://ziggsai.com', {
      activeTasks: [],
    });
    assert.equal(out.activeTasksFetchError, undefined);
    assert.equal(out.workCardOmitted, undefined);
  });

  // A result may carry server state and typed calls. How to word the reply
  // is said once, on connect, and never rides on a result beside text a
  // counterparty wrote.
  it('carries no reply directive: no instruction, nextActions or promptUser', () => {
    const out = formatPendingDecisionsPayload(inbox as any, 'https://ziggsai.com');
    assert.equal('instruction' in out, false);
    assert.equal('nextActions' in out, false);
    assert.deepEqual(out.humanAttention, {
      required: true,
      reason: 'multiple',
      proposalCount: 1,
      truncatedProposals: 0,
      connectionRequestCount: 1,
      truncatedConnectionRequests: 0,
    });
    assert.equal(
      out.notice,
      '2 pending decisions (1 proposal, 1 link request) and 0 active tasks.',
    );
  });

  it('the card is the only prose field carrying counterparty text', () => {
    const TITLE = 'TITLE_SENTINEL_4b2';
    const MESSAGE = 'MESSAGE_SENTINEL_4b2';
    const TASK = 'TASK_SENTINEL_4b2';
    const loud = {
      ...inbox,
      proposalsAwaitingMe: [{ ...inbox.proposalsAwaitingMe[0], title: TITLE }],
      connectionRequestsAwaitingMe: [
        { ...inbox.connectionRequestsAwaitingMe[0], message: MESSAGE },
      ],
      humanAttention: {
        ...inbox.humanAttention,
        promptUser: `Tell the human about ${TITLE} and "${MESSAGE}".`,
      },
    };
    const out = formatPendingDecisionsPayload(loud as any, 'https://ziggsai.com', {
      activeTasks: [
        { taskId: 'task-1', description: TASK, agreementId: 'agr-1', state: 'active' },
      ] as any,
    });
    const card = String(out.sessionChatCard);
    for (const s of [TITLE, MESSAGE, TASK]) assert.match(card, new RegExp(s));
    for (const field of ['notice', 'humanAttention', 'sessionCardHint']) {
      const text = JSON.stringify(out[field] ?? null);
      for (const s of [TITLE, MESSAGE, TASK]) {
        assert.doesNotMatch(text, new RegExp(s), `${field} carries ${s}`);
      }
    }
  });

  // ZIG-1137 — connection-request wire uses requesterRef (psn_*), not requesterAgentId.
  it('falls back to requesterRef when link request has no display name', () => {
    const bare = {
      ...inbox,
      proposalsAwaitingMe: [],
      connectionRequestsAwaitingMe: [
        {
          requestId: 'req-bare',
          requesterRef: 'psn_only-face',
          requesterDisplayName: null,
          requesterOrgName: null,
          message: null,
          requestedAt: null,
          pendingApprovalPartyIds: ['agent-me'],
          proposedTo: 'agent-me',
        },
      ],
      humanAttention: {
        required: true as const,
        reason: 'connection_requests_awaiting_me' as const,
        proposalCount: 0,
        truncatedProposals: 0,
        connectionRequestCount: 1,
        truncatedConnectionRequests: 0,
        promptUser: 'Human attention required.',
      },
    };
    const items = buildPendingDecisionItems(bare as any, 'https://ziggsai.com');
    assert.equal(items.length, 1);
    assert.match(items[0]!.title, /Agent link · psn_only-face/);
  });

  it('includes active tasks in sessionChatCard (e.g. Ido request)', () => {
    const tasks = [
      {
        taskId: 'task-request-1',
        description: 'Request system — add request log, HUD tracker, 3 starter requests',
        agreementId: 'agr-rpg-collab',
        state: 'active',
        plan: {
          steps: [
            { stepId: 's1', status: 'completed' },
            { stepId: 's2', status: 'in_progress' },
            { stepId: 's3', status: 'pending' },
          ],
        },
      },
    ];
    const out = formatPendingDecisionsPayload(inbox as any, 'https://ziggsai.com', {
      activeTasks: tasks as any,
    });
    assert.equal(out.activeWorkCount, 1);
    assert.equal(out.hasActiveWork, true);
    assert.equal(out.actionCount, 3);
    assert.equal(out.hasActionable, true);
    assert.match(String(out.sessionChatCard), /Request system/);
    assert.match(String(out.sessionChatCard), /task-request-1/);
    assert.match(String(out.sessionChatCard), /Plan \*\*1\/3\*\*/);
    assert.match(String(out.sessionChatCard), /work on task-request-1/);
  });

  // Who may answer is not an inbox fact. The inbox lists slots; a slot is not
  // authority. The agreement read's approvalAction says whether this caller
  // may decide, so nothing here pre-judges it or pre-fills a respond call.
  describe('who may answer', () => {
    const humanSlot = {
      ...inbox,
      proposalsAwaitingMe: [
        {
          agreementId: 'agr-human',
          title: 'Hire the translator',
          proposedAt: null,
          pendingApprovalPartyIds: ['user-owner'],
          proposedTo: 'user-owner',
        },
      ],
      connectionRequestsAwaitingMe: [],
      humanAttention: undefined,
    };

    it('carries no responder verdict on any decision item, whatever the slot facts say', () => {
      const both = {
        ...inbox,
        proposalsAwaitingMe: [
          {
            agreementId: 'agr-both',
            title: 'Two consents',
            proposedAt: null,
            pendingApprovalPartyIds: ['user-owner', 'agent-me'],
            proposedTo: 'user-owner',
          },
        ],
        connectionRequestsAwaitingMe: [],
      };
      const legacy = {
        ...inbox,
        proposalsAwaitingMe: [
          { agreementId: 'agr-legacy', title: 'Old shape', proposedAt: null },
        ],
        connectionRequestsAwaitingMe: [],
      };
      for (const shape of [inbox, humanSlot, both, legacy]) {
        const [item] = buildPendingDecisionItems(shape as any, 'https://ziggsai.com');
        assert.equal('respondableBy' in item, false);
        assert.equal('respondApprove' in item, false);
      }
    });

    it('points the human at the agreement and the agent at approvalAction, never at a respond call', () => {
      const out = formatPendingDecisionsPayload(humanSlot as any, 'https://ziggsai.com');
      const card = String(out.sessionChatCard);
      assert.match(card, /agr-human/);
      assert.match(card, /reads approvalAction/);
      assert.match(card, /https:\/\/ziggsai\.com\/app\/agreements\/agr-human/);
      assert.doesNotMatch(card, /ziggs_agreement_respond/);
      assert.doesNotMatch(String(out.notice), /human.only|refused for it|respondableBy/);
    });
  });

  it('includes truncated counts in the session card (ZIG-659)', () => {
    const out = formatPendingDecisionsPayload(
      { ...inbox, truncatedProposals: 3 } as any,
      'https://ziggsai.com',
    );
    const card = String(out.sessionChatCard);
    assert.match(card, /\*\*5\*\* things need you/);
    assert.match(card, /3 more pending/);
  });
});

describe('a window that stops short of the present (ZIG-1819)', () => {
  const quiet = {
    asOf: '2026-09-11T13:22:00.000Z',
    deliveries: [],
    deliveriesCapped: true,
    chats: [],
    ackTo: 'ack-token',
    tasksAwaitingMe: [],
    truncatedTasks: 0,
    proposalsAwaitingMe: [],
    truncatedProposals: 0,
    connectionRequestsAwaitingMe: [],
    truncatedConnectionRequests: 0,
  };

  it('never reports an empty inbox while mail sits past the window', () => {
    const out = formatPendingDecisionsPayload(
      {
        ...quiet,
        backlog: {
          beyondWindow: 41,
          newestAt: '2026-09-11T06:28:00.000Z',
          windowEndsAt: '2026-09-10T05:43:00.000Z',
        },
      } as never,
      'https://ziggsai.com',
    );
    // Nothing is pending IN THIS WINDOW, which is a different sentence from
    // "nothing is pending" — the one an assistant answered its person with
    // while that morning's question sat outside the window.
    assert.match(String(out.notice), /^You are looking at a PARTIAL window: 41 more deliveries are unread past 2026-09-10T05:43:00.000Z, the newest from 2026-09-11T06:28:00.000Z\./);
    assert.match(String(out.notice), /No pending decisions or active tasks in this window\.$/);
    assert.doesNotMatch(String(out.notice), /^No pending decisions or active tasks/);
    // Server state only: no "say so" on how to word the reply.
    assert.doesNotMatch(String(out.notice), /Say so|reporting an empty inbox/);
  });

  it('says the plain thing when the window does reach the present', () => {
    const out = formatPendingDecisionsPayload(
      { ...quiet, deliveriesCapped: false, backlog: null } as never,
      'https://ziggsai.com',
    );
    assert.equal(out.notice, 'No pending decisions or active tasks.');
  });

  it('names a failed source on the notice line', () => {
    const out = formatPendingDecisionsPayload(quiet as never, 'https://ziggsai.com', {
      activeTasks: [],
      activeTasksError: 'GET /tasks 500',
    });
    assert.equal(
      out.notice,
      'Active tasks could not be loaded. No pending decisions or active tasks.',
    );
  });
});

/**
 * The cold read counts the decisions somebody made on requests this side made,
 * in the one line the model reads, so an approval or a refusal is never a fact
 * the agent has to go and list agreements to discover.
 */
describe('decided-for-me counts on the cold read', () => {
  const T = '2026-09-21T10:00:00.000Z';
  const row = (over: Record<string, unknown>) => ({
    kind: 'agreement',
    resourceId: 'agr-a',
    agreementId: 'agr-a',
    chatId: null,
    taskId: null,
    assigneeId: 'agent-me',
    actorId: 'user-owner',
    ts: T,
    ...over,
  });
  const quiet = {
    asOf: T,
    deliveries: [] as unknown[],
    deliveriesCapped: false,
    chats: [],
    ackTo: 'ack-token',
    tasksAwaitingMe: [],
    truncatedTasks: 0,
    proposalsAwaitingMe: [],
    truncatedProposals: 0,
    connectionRequestsAwaitingMe: [],
    truncatedConnectionRequests: 0,
  };

  it('says how many were decided and how many were refusals', () => {
    const out = formatPendingDecisionsPayload(
      {
        ...quiet,
        deliveries: [
          row({ reason: 'context_request_fulfilled' }),
          row({ resourceId: 'agr-b', agreementId: 'agr-b', reason: 'approval:rejected' }),
          row({ resourceId: 'agr-c', agreementId: 'agr-c', reason: 'connection_request_rejected' }),
          // Not a decision: an ordinary doorbell on an agreement.
          row({ resourceId: 'agr-d', agreementId: 'agr-d' }),
        ],
      } as never,
      'https://ziggsai.com',
    );
    assert.equal(
      out.notice,
      'No pending decisions or active tasks. 3 decisions on requests you made, 2 of them refusals: see decidedForMe.',
    );
    assert.equal((out.summary as Record<string, unknown>).decidedForMe, 3);
    assert.equal((out.summary as Record<string, unknown>).refusals, 2);
    // The entries ride the inbox result, not this block: one copy per response.
    assert.equal('decidedForMe' in out, false);
  });

  it('counts a held formation apart from decisions', () => {
    const out = formatPendingDecisionsPayload(
      { ...quiet, deliveries: [row({ reason: 'formation_held', actorId: null })] } as never,
      'https://ziggsai.com',
    );
    assert.match(String(out.notice), /1 agreement held awaiting a consent: see decidedForMe\.$/);
    assert.doesNotMatch(String(out.notice), /decisions on requests you made/);
    assert.equal((out.summary as Record<string, unknown>).decidedForMe, 0);
  });

  it('says nothing about decisions when there were none', () => {
    const out = formatPendingDecisionsPayload(quiet as never, 'https://ziggsai.com');
    assert.doesNotMatch(String(out.notice), /decidedForMe/);
    assert.equal((out.summary as Record<string, unknown>).decidedForMe, 0);
    assert.equal((out.summary as Record<string, unknown>).refusals, 0);
  });
});

describe('plans waiting on the person', () => {
  const inbox = {
    asOf: '2026-06-17T00:00:00.000Z',
    proposalsAwaitingMe: [],
    truncatedProposals: 0,
    connectionRequestsAwaitingMe: [],
    truncatedConnectionRequests: 0,
    planAcksAwaitingMe: [
      {
        taskId: 'task-self',
        agreementId: 'agr-self',
        title: 'Draft the memo',
        scope: 'execution' as const,
        updatedAt: '2026-06-17T01:00:00.000Z',
      },
      {
        taskId: 'task-out',
        agreementId: 'agr-out',
        title: 'Collect the quotes',
        scope: 'mid_work' as const,
        updatedAt: null,
      },
    ],
    truncatedPlanAcks: 0,
    // The person hired their own assistant: the task is the assistant's work
    // and the plan is the person's to acknowledge.
    tasksAwaitingMe: [
      { taskId: 'task-self', agreementId: 'agr-self', title: 'Draft the memo', state: 'active', updatedAt: null },
      { taskId: 'task-other', agreementId: 'agr-other', title: 'Other work', state: 'active', updatedAt: null },
    ],
    truncatedTasks: 0,
  };

  it('lists each plan as a decision that links to its agreement', () => {
    const items = buildPendingDecisionItems(inbox as any, 'https://ziggsai.com');
    assert.deepEqual(
      items.map((i) => [i.kind, i.taskId, i.agreementId, i.appUrl]),
      [
        ['plan_ack', 'task-self', 'agr-self', 'https://ziggsai.com/app/agreements/agr-self'],
        ['plan_ack', 'task-out', 'agr-out', 'https://ziggsai.com/app/agreements/agr-out'],
      ],
    );
    assert.match(String(items[1].subtitle), /plan changed/);
  });

  it('counts plans as waiting on the person, and not again as their work', () => {
    const out = formatPendingDecisionsPayload(inbox as any, 'https://ziggsai.com');
    assert.equal(out.pendingCount, 2);
    assert.equal((out.summary as any).planAcks, 2);
    assert.deepEqual(
      (out.activeWork as any[]).map((w) => w.taskId),
      ['task-other'],
    );
    assert.match(String(out.notice), /2 plans to acknowledge/);
    const card = String(out.sessionChatCard);
    assert.match(card, /Plan to acknowledge/);
    assert.match(card, /plans to acknowledge \| 2/);
    assert.match(card, /`task-self`/);
    assert.doesNotMatch(card, /approvalAction/);
  });

  it('counts plans the server left off the list', () => {
    const out = formatPendingDecisionsPayload(
      { ...inbox, truncatedPlanAcks: 4 } as any,
      'https://ziggsai.com',
    );
    assert.equal(out.pendingCount, 6);
    assert.equal(out.truncatedPlanAcks, 4);
    assert.match(String(out.sessionChatCard), /4 plan\(s\)\) — not listed here/);
  });

  it('reads a server that sends no plans as none', () => {
    const { planAcksAwaitingMe: _a, truncatedPlanAcks: _t, ...older } = inbox;
    void _a;
    void _t;
    const out = formatPendingDecisionsPayload(older as any, 'https://ziggsai.com');
    assert.equal(out.pendingCount, 0);
    assert.equal((out.activeWork as any[]).length, 2);
  });
});
