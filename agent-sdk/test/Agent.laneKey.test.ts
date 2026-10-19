/**
 * ZIG-975: an inbox task wake must land on the inbox chatId lane — never open a
 * second lane keyed by bare agreementId.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Agent,
  laneSessionIdForTask,
  workScopeFromWake,
} from '../src/Agent.js';
import { WakeEffects } from '../src/runtime/wakeEffects.js';

type HostInternals = {
  sessions: Map<string, { sessionId: string }>;
  taskService: {
    getTask: (id: string) => Promise<Record<string, unknown>>;
    getActiveTasksForAgent: (id: string) => Promise<Array<{ taskId?: string; assigneeId?: string | null }>>;
  };
};

const makeHost = () =>
  new Agent({
    agentId: 'agent-me',
    operatorKey: 'op-key',
    anthropicKey: 'test-key',
    initial: 'idle',
    states: { idle: { kind: 'parked' as const, transitions: [] } },
    inboxCatchUp: false,
  });

const internals = (host: Agent) => host as unknown as HostInternals;

describe('laneSessionIdForTask (ZIG-975)', () => {
  it('prefers originChatId when present', () => {
    assert.equal(
      laneSessionIdForTask({ originChatId: 'chat-space', agreementId: 'agr_1' }),
      'chat-space',
    );
  });

  it('falls back to agrn-<agreementId>, never bare agreementId', () => {
    assert.equal(laneSessionIdForTask({ agreementId: 'agr_1' }), 'agrn-agr_1');
    assert.notEqual(laneSessionIdForTask({ agreementId: 'agr_1' }), 'agr_1');
  });

  it('uses default when neither is present', () => {
    assert.equal(laneSessionIdForTask({}), 'default');
  });
});

describe('Agent wakeTaskAssignment lane key (ZIG-975)', () => {
  it('wakeTaskAssignment opens the agrn- lane, not the bare agreementId lane', async () => {
    const host = makeHost();
    internals(host).taskService = {
      getTask: async () => ({
        taskId: 'task_1',
        state: 'active',
        agreementId: 'agr_abc',
        assigneeId: 'agent-me',
      }),
      getActiveTasksForAgent: async () => [],
    };

    await host.wakeTaskAssignment('task_1');

    const keys = [...internals(host).sessions.keys()];
    assert.deepEqual(keys, ['agent-me:agrn-agr_abc']);
    assert.equal(internals(host).sessions.get('agent-me:agrn-agr_abc')?.sessionId, 'agrn-agr_abc');
  });

  it('wakeTaskAssignment prefers originChatId over agrn- fallback', async () => {
    const host = makeHost();
    internals(host).taskService = {
      getTask: async () => ({
        taskId: 'task_2',
        state: 'active',
        agreementId: 'agr_abc',
        originChatId: 'chat-hire',
        assigneeId: 'agent-me',
      }),
      getActiveTasksForAgent: async () => [],
    };

    await host.wakeTaskAssignment('task_2');

    assert.deepEqual([...internals(host).sessions.keys()], ['agent-me:chat-hire']);
  });

});

describe('workScopeFromWake (ZIG-1394)', () => {
  it('reads agreementId and taskId off the event', () => {
    assert.deepEqual(
      workScopeFromWake({ agreementId: 'agr_1', taskId: 'tsk_1' }),
      { agreementId: 'agr_1', taskId: 'tsk_1' },
    );
  });

  it('reads nested resource ids from an inbox wake', () => {
    assert.deepEqual(
      workScopeFromWake({
        resource: { agreementId: 'agr_2', taskId: 'tsk_2' },
      }),
      { agreementId: 'agr_2', taskId: 'tsk_2' },
    );
  });

  it('parses agrn-<agreementId> from the session when the event has none', () => {
    assert.deepEqual(workScopeFromWake({}, 'agrn-agr_room'), {
      agreementId: 'agr_room',
    });
  });

  // ZIG-1998 — a listing is never work, so a wake that names one files the
  // agent's sends and tools under nothing.
  it('never scopes a wake to a listing', () => {
    assert.deepEqual(
      workScopeFromWake({
        type: 'message',
        agreementId: 'agr_listing',
        agreementContext: { agreementId: 'agr_listing', listing: true },
      }),
      {},
    );
  });
});

describe('WakeEffects room scope (ZIG-1998)', () => {
  it("a stranger's room linked to the listing is not the listing's work", () => {
    const marks = WakeEffects.forWake({ type: 'message', chatId: 'store-room' }, 'store-room');
    marks.observe(
      { kind: 'read-context', sessionId: 'store-room' } as never,
      {
        agreements: [
          { agreementId: 'agr_listing', parties: { payer: 'everyone' }, engagementKind: 'hire' },
          { agreementId: 'agr_hire', parties: { payer: 'user-luke' }, engagementKind: 'hire' },
        ],
      },
    );
    assert.deepEqual(marks.scope, { agreementId: 'agr_hire' });
  });
});
