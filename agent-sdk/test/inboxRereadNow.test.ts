import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { runInboxLoop } from '../src/platform/inboxLoop.js';
import { SeenMessages } from '../src/platform/SeenMessages.js';
import { ownTaskCreated } from '../src/platform/ZiggsEffectHandler.js';

const empty = { asOf: '2026-11-10T00:00:00Z', ackTo: 't1', chats: [], deliveries: [],
  proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [] };

describe('a task an agent gives itself is read at once', () => {
  afterEach(() => mock.restoreAll());

  it('rereadNow cancels a held read and reads again without waiting', async () => {
    const reads: string[] = [];
    let holding!: () => void;
    const held = new Promise<void>((resolve) => { holding = resolve; });
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Response.json({ released: true });
      const at = new URL(String(url));
      if (!at.pathname.endsWith('/inbox')) return Response.json({ ackedUpTo: 't1' });
      const wait = at.searchParams.get('wait');
      reads.push(wait ?? 'now');
      if (!wait) return Response.json(empty);
      // A held read answers only to new mail: it holds until cancelled.
      holding();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
    });
    const loop = runInboxLoop({ creds: { operatorKey: 'op', agentId: 'agent-1' }, ownAgentId: 'agent-1',
      baseUrl: 'http://test', seen: new SeenMessages(), onMessage: async () => {},
      onResourceEvent: async () => {} }, { waitSeconds: 110 });
    await held;
    assert.deepEqual(reads, ['now', '110'], 'the first read is immediate, then it holds');
    loop.rereadNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reads[2], 'now', 'the held read was cancelled and the inbox read again at once');
    await loop.stop(100);
  });

  it('names the task only when task_create opened it for this agent', () => {
    assert.equal(ownTaskCreated('task_create', { taskId: 'T1', assigneeId: 'agent-1' }, 'agent-1'), 'T1');
    assert.equal(ownTaskCreated('task_create', { task: { taskId: 'T2', executorIsYou: true } }, 'agent-1'), 'T2');
    assert.equal(ownTaskCreated('task_create', { taskId: 'T3', assigneeId: 'someone-else' }, 'agent-1'), null);
    assert.equal(ownTaskCreated('task_create', { ok: false, taskId: 'T4', assigneeId: 'agent-1' }, 'agent-1'), null);
    assert.equal(ownTaskCreated('task_set_result', { taskId: 'T5', assigneeId: 'agent-1' }, 'agent-1'), null);
  });
});
