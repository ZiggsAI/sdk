/**
 * ZIG-975: an inbox task wake must land on the inbox addressId lane — never open a
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
import { withAssistantRequest } from '@ziggs-ai/api-client';

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
  it('does not infer a delivery destination from originChatId', () => {
    assert.equal(
      laneSessionIdForTask({ originChatId: 'chat-space', agreementId: 'agr_1' }),
      'agrn-agr_1',
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
  it('keeps local processing keys out of delivery and preserves an explicit restored destination', async () => {
    const host = makeHost();
    internals(host).taskService = {
      getTask: async () => ({ taskId: 'task_1', state: 'active', agreementId: 'agr_1', originChatId: 'old-origin' }),
      getActiveTasksForAgent: async () => [],
    };
    const received: Array<Record<string, unknown>> = [];
    (host as unknown as { eventQueue: { enqueue: (event: Record<string, unknown>) => Promise<void> } }).eventQueue.enqueue = async event => { received.push(event); };
    await host.wakeTaskAssignment('task_1');
    assert.equal(received[0].addressId, undefined);
    await withAssistantRequest({ executionContext: {
      contextId: 'xec_restored', actorId: 'agent-me', principalId: 'owner', position: 'provider',
      agreementId: 'agr_1', taskId: 'task_1', addressId: 'agrn-real-shared', audienceIds: ['owner'], audienceRevision: 'v1',
    } }, () => host.wakeTaskAssignment('task_1'));
    assert.equal(received[1].addressId, 'agrn-real-shared');
    assert.ok([...internals(host).sessions.keys()].some(key => key.includes('xec_restored')));
  });
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

  it('wakeTaskAssignment uses work scope despite a historical origin link', async () => {
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

    assert.deepEqual([...internals(host).sessions.keys()], ['agent-me:agrn-agr_abc']);
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

  it('does not infer work from a processing-lane name', () => {
    assert.deepEqual(workScopeFromWake({}, 'agrn-agr_room'), {});
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
    const marks = WakeEffects.forWake({ type: 'message', addressId: 'store-room' }, 'store-room');
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
