import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilityDefinition, CapabilityEnv } from '@ziggs-ai/api-client';
import { toolFromCapability } from '../src/tools/capabilityAdapter.js';

/**
 * ZIG-1092 — the fence hangs off the lane reaching the HTTP layer, and the lane
 * enters the SDK here.
 *
 * ZIG-775 already threaded it to this exact point (`chatId: effect.sessionId`
 * in `executeToolWithSideEffects`) — it just was not used to narrow anything.
 * Reading it in the shared adapter is what makes the fix brain-agnostic: the
 * Claude brain and the FSM brain both arrive through this one function, so
 * neither needed a change.
 */
function probeCapability(sink: { env?: CapabilityEnv }): CapabilityDefinition {
  return {
    key: 'probe',
    names: { sdk: 'probe', mcp: 'ziggs_probe' },
    title: 'Probe',
    descriptions: { sdk: 'probe', mcp: 'probe' },
    annotation: 'read-only',
    params: {},
    handler: (_args, env) => {
      sink.env = env;
      return Promise.resolve({ ok: true });
    },
  };
}

describe('toolFromCapability lane threading', () => {
  it('takes the lane from the tool context chatId', async () => {
    const sink: { env?: CapabilityEnv } = {};
    const tool = toolFromCapability(probeCapability(sink));
    await tool.handler(
      {},
      { operatorKey: 'key', agentId: 'agent-1', chatId: 'chat_acme' },
    );
    assert.equal(sink.env?.creds.laneId, 'chat_acme');
  });

  it('falls back to sessionId, which is the lane for an agreement wake', async () => {
    // A task with no origin chat runs on `agrn-<agreementId>` (ZIG-1032).
    const sink: { env?: CapabilityEnv } = {};
    const tool = toolFromCapability(probeCapability(sink));
    await tool.handler(
      {},
      { operatorKey: 'key', agentId: 'agent-1', sessionId: 'agrn-agr_1' },
    );
    assert.equal(sink.env?.creds.laneId, 'agrn-agr_1');
  });

  it('leaves the lane unset when the context carries none', async () => {
    // Unset is safe: the backend fences to the agent's own org, which narrows
    // reach rather than opening it.
    const sink: { env?: CapabilityEnv } = {};
    const tool = toolFromCapability(probeCapability(sink));
    await tool.handler({}, { operatorKey: 'key', agentId: 'agent-1' });
    assert.ok(!('laneId' in (sink.env?.creds ?? {})));
  });
});
