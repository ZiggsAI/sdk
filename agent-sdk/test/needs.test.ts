/**
 * ZIG-1391 — an agent's prompt and its tools could describe different worlds.
 *
 * linear-janitor is the case: its instructions said to read Linear through a
 * connection grant, its manifest carried artifact tools only. It booted, took the
 * job, and failed on a real hire. These cover the two halves of the fix — the
 * tool list is DERIVED from the declaration, so the mismatch cannot be written;
 * and a declared need with no grant behind it refuses the task by name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defineAgent } from '../src/defineAgent.js';
import { toolName } from '../src/tools/defineTool.js';
import {
  describeNeed,
  normalizeNeeds,
  toolsForNeeds,
  unmetNeeds,
  unmetNeedsMessage,
} from '../src/tools/needs.js';
import { ARTIFACT_TOOLS } from '../src/platform/tools/tier2/artifactTools.js';
import { Agent } from '../src/Agent.js';

const parked = {
  initial: 'ready',
  states: { ready: { kind: 'parked' as const, transitions: [] } },
};

const names = (tools: unknown[]) =>
  tools.map((t) => toolName(t as never)).filter(Boolean) as string[];

describe('a declared need produces its tools (ZIG-1391)', () => {
  it('an MCP connection need yields the gateway tools and the grant lister', () => {
    const got = names(toolsForNeeds([{ connection: 'mcp' }]));
    assert.deepEqual(
      [...got].sort(),
      ['connection_list_grants', 'mcp_tool_call', 'mcp_tools_list'],
    );
  });

  it('a named connector need yields the proxy, not the MCP gateway', () => {
    // connection_proxy resolves a NAMED connector; it refuses an MCP connection
    // with "Unknown provider: mcp", which was the janitor's second wall.
    const got = names(toolsForNeeds([{ connection: 'github' }]));
    assert.deepEqual([...got].sort(), ['connection_list_grants', 'connection_proxy']);
  });

  it('seeing the grant rides every need — the first failure was an agent that held one and could not notice', () => {
    for (const connection of ['mcp', 'github', 'jira']) {
      assert.ok(names(toolsForNeeds([{ connection }])).includes('connection_list_grants'));
    }
  });

  it('overlapping needs merge instead of registering a tool twice', () => {
    const got = names(toolsForNeeds([{ connection: 'github' }, { connection: 'jira' }]));
    assert.equal(new Set(got).size, got.length);
  });

  it('an agent that declares the need cannot be written without the tools', () => {
    // This IS the janitor's manifest: artifact tools hand-listed, Linear access
    // declared. Before this ticket the second line was a second hand-written list.
    const config = defineAgent({
      agentId: 'janitor-like',
      description: 'keeps a board tidy',
      needs: [{ connection: 'mcp' }],
      tools: [...ARTIFACT_TOOLS],
      ...parked,
    });
    const got = names(config.tools);
    assert.ok(got.includes('mcp_tool_call'), 'derived tool missing');
    assert.ok(got.includes('connection_list_grants'), 'derived tool missing');
    assert.ok(got.includes('artifact_record'), 'authored tool dropped');
  });

  it('declaring nothing changes nothing — the tool list is exactly what was authored', () => {
    const config = defineAgent({
      agentId: 'plain',
      description: 'no outside access',
      tools: [...ARTIFACT_TOOLS],
      ...parked,
    });
    assert.deepEqual(names(config.tools), names([...ARTIFACT_TOOLS]));
  });

  it('hand-listing a derived tool is a no-op, not a duplicate registration', () => {
    const config = defineAgent({
      agentId: 'belt-and-braces',
      description: 'declares and also lists',
      needs: [{ connection: 'github' }],
      tools: [...ARTIFACT_TOOLS],
      ...parked,
    });
    const got = names(config.tools);
    assert.equal(new Set(got).size, got.length);
  });

  it('the normalized declaration reaches the config, so the host can enforce it', () => {
    const config = defineAgent({
      agentId: 'declares',
      description: 'x',
      needs: [{ connection: ' mcp ' }, { connection: '' }, null as never],
      ...parked,
    });
    assert.deepEqual(config.needs, [{ connection: 'mcp' }]);
  });
});

describe('normalizeNeeds tolerates a manifest written by hand', () => {
  it('drops entries that name nothing', () => {
    assert.deepEqual(normalizeNeeds([{ connection: '' }, {}, 7, null]), []);
  });
  it('returns empty for a missing or non-array field', () => {
    assert.deepEqual(normalizeNeeds(undefined), []);
    assert.deepEqual(normalizeNeeds('mcp'), []);
  });
});

describe('an unmet need is named, not guessed at', () => {
  it('a held grant of the same provider satisfies the need', () => {
    assert.deepEqual(unmetNeeds([{ connection: 'mcp' }], ['mcp']), []);
  });

  it('the owner-account suffix on a grant label does not hide the provider', () => {
    // Grant labels read "github — acme/infra" when the reader owns the account.
    assert.deepEqual(unmetNeeds([{ connection: 'github' }], ['github — acme/infra']), []);
  });

  it('matching ignores case', () => {
    assert.deepEqual(unmetNeeds([{ connection: 'GitHub' }], ['github']), []);
  });

  it('a different provider does not satisfy the need', () => {
    assert.deepEqual(unmetNeeds([{ connection: 'mcp' }], ['github']), [{ connection: 'mcp' }]);
  });

  it('no grants at all leaves every need unmet', () => {
    assert.deepEqual(unmetNeeds([{ connection: 'mcp' }], []), [{ connection: 'mcp' }]);
    assert.deepEqual(unmetNeeds([{ connection: 'mcp' }], [null, undefined]), [
      { connection: 'mcp' },
    ]);
  });

  it('the refusal names the access and who can issue it', () => {
    const message = unmetNeedsMessage([{ connection: 'mcp' }]);
    assert.match(message, /connection to an MCP server/);
    assert.match(message, /connection owner/);
  });

  it('describes a named connector by its provider', () => {
    assert.equal(describeNeed({ connection: 'github' }), 'a github connection');
  });
});

/**
 * The runtime half. Task start is the gate, not hire: the normal order is hire
 * first, grant second, so refusing at hire would refuse every honest hire.
 */
describe('Agent refuses work it declared it cannot do', () => {
  type Internals = {
    _refuseIfNeedsUnmet(event: unknown, laneKey: string): Promise<boolean>;
    taskService: { updateState(id: string, state: string, result?: unknown): Promise<unknown> };
  };

  const makeHost = (needs?: Array<{ connection: string }>) =>
    new Agent({
      agentId: 'agent-me',
      operatorKey: 'op-key',
      anthropicKey: 'test-key',
      ...(needs ? { needs } : {}),
      initial: 'ready',
      states: { ready: { kind: 'parked' as const, transitions: [] } },
      inboxCatchUp: false,
    });

  /** Stands in for the agent's live connection grants and its assigned work. */
  const withGrants = (
    host: Agent,
    providers: string[] | Error,
    failed: unknown[] = [],
    assigned: Array<{ taskId: string; assigneeId?: string | null }> = [{ taskId: 't1' }],
  ) => {
    const internals = host as unknown as Internals & {
      _listGrantProviders(): Promise<Array<string | null | undefined>>;
    };
    internals._listGrantProviders = async () => {
      if (providers instanceof Error) throw providers;
      return providers;
    };
    internals.taskService = {
      getActiveTasksForAgent: async () => assigned,
      updateState: async (id: string, state: string, result?: unknown) => {
        failed.push({ id, state, result });
        return {};
      },
    } as never;
    return internals;
  };

  const anyWake = { type: 'task_result', result: { taskId: 't1', state: 'active' } };

  it('an agent that declared nothing is never gated', async () => {
    const internals = withGrants(makeHost(), []);
    assert.equal(await internals._refuseIfNeedsUnmet(anyWake, 'lane'), false);
  });

  it('fails the assigned task when the declared grant is missing', async () => {
    const failed: unknown[] = [];
    const internals = withGrants(makeHost([{ connection: 'mcp' }]), [], failed);
    assert.equal(await internals._refuseIfNeedsUnmet(anyWake, 'lane'), true);
    assert.equal(failed.length, 1);
    const row = failed[0] as { id: string; state: string; result: { summary: string } };
    assert.equal(row.id, 't1');
    assert.equal(row.state, 'failed');
    assert.match(row.result.summary, /MCP server/);
  });

  /**
   * The claim-kickoff wake arrives BEFORE the task frame. A task-frame-only gate
   * let the model take that turn first: 8 calls and 114k tokens on a local
   * linear-janitor run, to reach the same answer this check reaches for free.
   */
  it('fires on a kickoff wake too, not only on the task frame', async () => {
    const failed: unknown[] = [];
    const internals = withGrants(makeHost([{ connection: 'mcp' }]), [], failed);
    assert.equal(
      await internals._refuseIfNeedsUnmet({ type: 'agreement', agreementId: 'agr_1' }, 'lane'),
      true,
    );
    assert.equal(failed.length, 1);
  });

  it('lets the work through once the grant exists', async () => {
    const failed: unknown[] = [];
    const internals = withGrants(makeHost([{ connection: 'mcp' }]), ['mcp'], failed);
    assert.equal(await internals._refuseIfNeedsUnmet(anyWake, 'lane'), false);
    assert.deepEqual(failed, []);
  });

  it('stays quiet when nothing is assigned — an agent can still say it is blocked', async () => {
    const failed: unknown[] = [];
    const internals = withGrants(makeHost([{ connection: 'mcp' }]), [], failed, []);
    assert.equal(await internals._refuseIfNeedsUnmet({ type: 'message' }, 'lane'), false);
    assert.deepEqual(failed, []);
  });

  it("never fails someone else's task", async () => {
    const failed: unknown[] = [];
    const internals = withGrants(makeHost([{ connection: 'mcp' }]), [], failed, [
      { taskId: 't-other', assigneeId: 'another-agent' },
    ]);
    assert.equal(await internals._refuseIfNeedsUnmet(anyWake, 'lane'), false);
    assert.deepEqual(failed, []);
  });

  it('fails open: a grants-read outage lets the agent try rather than failing its task', async () => {
    const failed: unknown[] = [];
    const internals = withGrants(
      makeHost([{ connection: 'mcp' }]),
      new Error('grants 503'),
      failed,
    );
    assert.equal(await internals._refuseIfNeedsUnmet(anyWake, 'lane'), false);
    assert.deepEqual(failed, [], "an outage on our side must not fail the buyer's task");
  });
});
