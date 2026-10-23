import assert from 'node:assert/strict';
import { describe, it, mock, afterEach } from 'node:test';
import { activeHiresForAgent } from '../src/capabilities/activeHire.js';
import { agentSearchCapability } from '../src/capabilities/discovery.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';
import type { Agreement } from '../src/types.js';

const env: CapabilityEnv = {
  surface: 'mcp',
  creds: { operatorKey: 'op', agentId: 'assistant' },
};

function hire(over: Record<string, unknown> = {}): Agreement {
  return {
    agreementId: 'agr-1',
    status: 'active',
    engagementKind: 'hire',
    payerLane: 'org-buyer',
    parties: {
      provider: { principal: 'org-seller', actor: 'agent-notes' },
      payer: { principal: 'user-buyer', actor: null },
    },
    ...over,
  } as Agreement;
}

describe('active hires on a search row (ZIG-2240)', () => {
  it('names each active hire and its workspace, and nothing else', () => {
    const rows = [
      hire(),
      hire({ agreementId: 'agr-2', payerLane: 'org-other' }),
      hire({ agreementId: 'agr-pending', status: 'pending' }),
      hire({
        agreementId: 'agr-listing',
        engagementKind: 'service',
        parties: {
          provider: { principal: 'org-seller', actor: 'agent-notes' },
          payer: { principal: 'everyone', actor: null },
        },
      }),
      hire({ agreementId: 'agr-link', engagementKind: 'link' }),
      hire({
        agreementId: 'agr-someone-else',
        parties: {
          provider: { principal: 'org-seller', actor: 'agent-other' },
          payer: { principal: 'user-buyer', actor: null },
        },
      }),
    ];
    assert.deepEqual(activeHiresForAgent('agent-notes', rows), [
      { agreementId: 'agr-1', workspace: 'org-buyer' },
      { agreementId: 'agr-2', workspace: 'org-other' },
    ]);
    assert.deepEqual(activeHiresForAgent('agent-other', rows), [
      { agreementId: 'agr-someone-else', workspace: 'org-buyer' },
    ]);
    assert.deepEqual(activeHiresForAgent('agent-none', rows), []);
  });

  afterEach(() => mock.restoreAll());

  it('the search tool says already hired only on the agent that is hired', async () => {
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/agents/search')) {
        return Response.json({
          results: [
            { agentId: 'agent-notes', name: 'Meeting Notes' },
            { agentId: 'agent-fresh', name: 'Fresh' },
          ],
        });
      }
      return Response.json({
        agreements: [hire({ agreementId: 'agr-live', payerLane: 'org-kiwook' })],
      });
    });
    const out = (await agentSearchCapability.handler({ query: 'meeting notes' }, env)) as {
      agents: Array<Record<string, unknown>>;
      hireCheck?: string;
    };
    assert.equal(out.hireCheck, undefined);
    const notes = out.agents.find((a) => a['agentId'] === 'agent-notes');
    const fresh = out.agents.find((a) => a['agentId'] === 'agent-fresh');
    assert.equal(notes?.['alreadyHired'], 'already hired');
    assert.deepEqual(notes?.['hires'], [
      { agreementId: 'agr-live', workspace: 'org-kiwook' },
    ]);
    assert.equal(fresh?.['alreadyHired'], undefined);
    assert.equal(fresh?.['hires'], undefined);
  });
});
