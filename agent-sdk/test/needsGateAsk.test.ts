import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import { requestConnectionTool } from '../src/platform/tools/tier2/connectionTools.js';

/**
 * The order in which an agent is refused decides whether the hire is recoverable.
 *
 * A store agent gets its first wake with the work already assigned — claim and
 * brief arrive together — so failing the task before the tick means the brain
 * never runs (it declines a wake whose task already reported a result) and the
 * buyer is left with "ask the connection owner to issue a grant" for a connection
 * only they can make. The agent has to get one turn to ask, and exactly one.
 */
describe('unmet-needs gate: ask, then refuse', () => {
  const TASK = { taskId: 'task_1', assigneeId: 'a1' };

  function host(opts: { canAsk: boolean }) {
    const failed: Array<{ taskId: string }> = [];
    let activeTasks = [TASK];
    /**
     * The gate is reached through the prototype rather than a constructed host:
     * building one drags in a brain, a model and a key, none of which the two
     * methods under test touch. What they DO touch is set explicitly below, so a
     * field renamed in the host fails here loudly instead of silently passing.
     */
    const h = Object.create(Agent.prototype) as Record<string, unknown>;
    h['options'] = {
      agentId: 'a1',
      name: 'a1',
      needs: [{ connection: 'mcp' }],
      tools: opts.canAsk ? [requestConnectionTool] : [],
      operatorKey: 'op',
    };
    h['askedForAccessLanes'] = new Set<string>();
    h['unmetTasksPendingAsk'] = new Map<string, string[]>();
    h['grantProviderCache'] = null;
    // No grants at all: every declared need is unmet.
    h['_listGrantProviders'] = async () => [];
    h['taskService'] = {
      getActiveTasksForAgent: async () => activeTasks,
      updateState: async (taskId: string) => {
        failed.push({ taskId });
        activeTasks = [];
      },
    };
    const gate = (event: unknown, lane: string) =>
      (h as unknown as { _refuseIfNeedsUnmet(e: unknown, l: string): Promise<boolean> })
        ._refuseIfNeedsUnmet(event, lane);
    const settle = (lane: string) =>
      (h as unknown as { settleUnmetAfterAsk(l: string): Promise<void> }).settleUnmetAfterAsk(lane);
    return { gate, settle, failed, reopen: () => { activeTasks = [TASK]; } };
  }

  it('an agent that can ask gets the wake, and the task is not failed yet', async () => {
    const { gate, failed } = host({ canAsk: true });
    assert.equal(await gate({}, 'lane-1'), false, 'the tick must run so it can ask');
    assert.deepEqual(failed, [], 'failing first is what silenced the agent');
  });

  it('what the asking turn leaves open is failed right after it', async () => {
    const { gate, settle, failed } = host({ canAsk: true });
    await gate({}, 'lane-1');
    await settle('lane-1');
    assert.deepEqual(failed.map((f) => f.taskId), ['task_1'], 'an active task nobody works is the stall the gate exists to prevent');
  });

  it('the second wake on the same lane is refused up front — no nagging', async () => {
    const { gate, settle, failed, reopen } = host({ canAsk: true });
    await gate({}, 'lane-1');
    await settle('lane-1');
    failed.length = 0;
    reopen();
    assert.equal(await gate({}, 'lane-1'), true, 'the card is already sitting there');
    assert.deepEqual(failed.map((f) => f.taskId), ['task_1']);
  });

  it('each lane gets its own turn: two hirers, two asks', async () => {
    const { gate } = host({ canAsk: true });
    assert.equal(await gate({}, 'lane-1'), false);
    assert.equal(await gate({}, 'lane-2'), false);
  });

  it('an agent with no way to ask is refused as before — the turn buys nothing', async () => {
    const { gate, failed } = host({ canAsk: false });
    assert.equal(await gate({}, 'lane-1'), true);
    assert.deepEqual(failed.map((f) => f.taskId), ['task_1']);
  });
});
