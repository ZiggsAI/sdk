import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sessionOrientation } from '../src/sessionOrientation.js';

describe('sessionOrientation (ZIG-1876 / AX-05)', () => {
  it('names the represented person — ownerId is not enough', () => {
    const out = sessionOrientation({
      agentId: 'assistant-1',
      ownerUserId: 'usr_human',
      surface: 'mcp',
    });
    assert.deepEqual(out.representedPerson, { id: 'usr_human', kind: 'user' });
    assert.equal(out.identity.agentId, 'assistant-1');
    assert.equal(out.identity.distinctFromBackgroundWorker, true);
  });

  it('E18: MCP reports manual continuation — it cannot arm a wake', () => {
    const out = sessionOrientation({
      agentId: 'a',
      ownerUserId: null,
      surface: 'mcp',
    });
    assert.equal(out.continuation.kind, 'manual');
    assert.equal(out.continuation.canScheduleWake, false);
    assert.match(out.continuation.summary, /no wake_at/);
    assert.equal(out.inboxHandling.ackDriver, 'agent');
  });

  it('E18: hosted SDK reports scheduled continuation and host-driven ack', () => {
    const out = sessionOrientation({
      agentId: 'a',
      ownerUserId: 'usr_1',
      surface: 'sdk',
    });
    assert.equal(out.continuation.kind, 'scheduled');
    assert.equal(out.continuation.canScheduleWake, true);
    assert.equal(out.inboxHandling.ackDriver, 'host');
  });

  it('E25: peek is the orientation that does not acquire', () => {
    const out = sessionOrientation({
      agentId: 'a',
      ownerUserId: 'usr_1',
      surface: 'mcp',
    });
    assert.equal(out.inboxHandling.readAcquiresHost, true);
    assert.equal(out.inboxHandling.peekDoesNotAcquire, true);
    assert.deepEqual(out.inboxHandling.peek, {
      tool: 'ziggs_inbox_peek',
      http: { method: 'GET', path: '/inbox/peek' },
    });
  });
});
