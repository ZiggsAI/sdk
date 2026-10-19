import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent, createAgent, type AgentOptions } from '../src/Agent.js';
import { createMcpAgent } from '../src/mcp/createMcpAgent.js';
import { claudeBrain } from '../src/brain/index.js';

const config = (extra: Partial<AgentOptions> = {}): AgentOptions => ({
  agentId: 'poll-agent', operatorKey: 'test-key', anthropicKey: 'test-key',
  initial: 'idle', states: { idle: { kind: 'parked', transitions: [] } },
  inboxCatchUp: false, telemetryIngest: false, ...extra,
});
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await delay(5);
  assert.ok(condition(), 'condition did not settle');
};

for (const path of ['constructor', 'factory', 'mcp'] as const) {
  it(`${path}: connect starts declared polls once, disconnect stops them, reconnect resumes`, async () => {
    let polls = 0;
    const wakes: Array<{ text: string; metadata: unknown }> = [];
    const options = config({
      polls: [{ kind: 'mail', chatId: 'triage' }],
      pollKinds: [{ id: 'mail', intervalMs: 5, async poll(_binding, ctx) {
        assert.equal(ctx.agentId, 'poll-agent');
        assert.equal(ctx.operatorKey, 'test-key');
        polls++;
        return { actionable: true, hint: 'new mail' };
      } }],
    });
    const mcp = path === 'mcp' ? await createMcpAgent({
      ...options, transport: { type: 'ziggs-per-user' }, toolSchema: [{ name: "read_mail", inputSchema: { type: "object" } }],
    }) : undefined;
    const agent = mcp?.agent ?? (path === 'constructor' ? new Agent(options) : createAgent(options));
    agent.handleMessage = async (text, metadata) => { wakes.push({ text, metadata }); };
    try {
      await delay(15);
      assert.equal(polls, 0, 'construction must not start timers');
      await agent.connectAsync();
      await agent.connectAsync();
      await until(() => wakes.length > 0);
      assert.deepEqual(wakes[0], { text: 'new mail', metadata: { chatId: 'triage', pollKind: 'mail' } });
      agent.disconnect();
      const stopped = polls;
      await delay(25);
      assert.equal(polls, stopped);
      await agent.connectAsync();
      await until(() => polls > stopped);
    } finally {
      agent.disconnect();
      await mcp?.closeMcp();
    }
  });
}

it('an unknown kind or missing lane does not refuse the agent (ZIG-1771)', () => {
  // One agent's invalid poll used to throw in the constructor, which
  // ConnectionPool then treated as a fleet-wide abort. The binding is
  // skipped; the host still constructs.
  assert.doesNotThrow(() => createAgent(config({ polls: [{ kind: 'missing', chatId: 'c' }] })));
  assert.doesNotThrow(() => createAgent(config({
    polls: [{ kind: 'mail' }],
    pollKinds: [{ id: 'mail', poll: async () => ({ actionable: false }) }],
  })));
});

it('a source response arriving after disconnect cannot wake an agent', async () => {
  let entered = false;
  let release!: (result: { actionable: boolean }) => void;
  let wakes = 0;
  const agent = createAgent(config({
    polls: [{ kind: 'slow', chatId: 'c' }],
    pollKinds: [{ id: 'slow', poll() {
      entered = true;
      return new Promise(resolve => { release = resolve; });
    } }],
  }));
  agent.handleMessage = async () => { wakes++; };
  try {
    await agent.connectAsync();
    await until(() => entered);
    agent.disconnect();
    release({ actionable: true });
    await delay(15);
    assert.equal(wakes, 0);
  } finally { agent.disconnect(); }
});

it('reconnecting while a source read is pending does not overlap that binding', async () => {
  let reads = 0;
  let release!: (result: { actionable: boolean }) => void;
  let wakes = 0;
  const agent = createAgent(config({
    polls: [{ kind: 'slow', chatId: 'c' }],
    pollKinds: [{ id: 'slow', intervalMs: 5, poll() {
      reads++;
      if (reads === 1) return new Promise(resolve => { release = resolve; });
      return Promise.resolve({ actionable: true });
    } }],
  }));
  agent.handleMessage = async () => { wakes++; };
  try {
    await agent.connectAsync();
    await until(() => reads === 1);
    agent.disconnect();
    await agent.connectAsync();
    await delay(15);
    assert.equal(reads, 1);
    release({ actionable: true });
    await until(() => wakes > 0);
    agent.disconnect();
    assert.equal(wakes, reads - 1, 'discard the old connection’s source result');
  } finally { agent.disconnect(); }
});

it('public Claude brain selection receives the Claude wake timeout', () => {
  const agent = createAgent(config({ brain: claudeBrain({ anthropicKey: 'test-key' }) }));
  assert.equal((agent as unknown as { tickTimeoutMs: number }).tickTimeoutMs,
    Number(process.env.CLAUDE_SDK_TICK_TIMEOUT_MS ?? 300_000));
  assert.equal(agent.brain.kind, 'claude');
});

it('a rejected MCP agent releases its already-connected tool transport', async () => {
  const { mock } = await import('node:test');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const connect = mock.method(Client.prototype, 'connect', async () => {});
  const list = mock.method(Client.prototype, 'listTools', async () => ({
    tools: [{ name: 'read_mail', inputSchema: { type: 'object' } }],
  }));
  const close = mock.method(Client.prototype, 'close', async () => {});
  try {
    await assert.rejects(createMcpAgent({
      ...config(), transport: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
      // A type error, not an invalid binding: unknown kinds no longer refuse
      // the agent (ZIG-1771). The factory must still release the transport
      // it already opened when construction fails for any other reason.
      polls: { kind: 'missing', chatId: 'c' } as unknown as AgentOptions['polls'],
    }), /polls must be an array/);
    assert.equal(close.mock.callCount(), 1);
  } finally {
    connect.mock.restore(); list.mock.restore(); close.mock.restore();
  }
});
