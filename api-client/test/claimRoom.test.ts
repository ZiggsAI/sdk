import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { agreementClaimCapability } from '../src/capabilities/agreements.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';

/**
 * ZIG-2033 — a hire of a listing names the room it is for, and the answer says
 * where the agent stands on getting into it: waiting, in, or not in yet with
 * the call that resumes it.
 */

const ENV: CapabilityEnv = {
  creds: { operatorKey: 'op', agentId: 'agent-a' },
  surface: 'mcp',
};

function respondWith(body: Record<string, unknown>) {
  const calls: Array<{ body: unknown }> = [];
  mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

const hire = (status: string) => ({
  agreementId: 'agr_hire',
  status,
  engagementKind: 'hire',
  approvals: status === 'open' ? [{ partyId: 'itay', role: 'payer', status: 'pending' }] : [],
});

const claim = (args: Record<string, unknown>) =>
  agreementClaimCapability.handler({ agreementId: 'agr_listing', ...args }, ENV) as Promise<{
    status: string;
    message: string;
    room?: { chatId: string; status: string };
  }>;

describe('agreement_claim with a room (ZIG-2033)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('sends the room and says the agent is in once it is', async () => {
    const calls = respondWith({
      ok: true,
      kind: 'hand-off',
      agreement: hire('active'),
      room: { chatId: 'room-1', status: 'ready' },
    });
    const res = await claim({ chatId: 'room-1' });
    assert.deepEqual(calls[0]?.body, { chatId: 'room-1' });
    assert.equal(res.room?.status, 'ready');
    assert.match(res.message, /The agent is in room room-1 now\./);
  });

  it('says a held hire joins the room on its yes, with no further step', async () => {
    respondWith({
      ok: true,
      kind: 'hand-off',
      agreement: hire('open'),
      room: { chatId: 'room-1', status: 'awaiting_approval' },
    });
    const res = await claim({ chatId: 'room-1' });
    assert.equal(res.status, 'pending_approval');
    assert.match(res.message, /Once approved, the agent joins room room-1/);
  });

  it('names the recovery for a failed admission and says not to claim again', async () => {
    respondWith({
      ok: true,
      kind: 'hand-off',
      agreement: hire('active'),
      room: {
        chatId: 'room-1',
        status: 'admission_failed',
        recovery: { method: 'POST', path: '/chats/room-1/hires/agr_hire/admission' },
      },
    });
    const res = await claim({ chatId: 'room-1' });
    assert.match(res.message, /hire conversation is not ready/);
    assert.match(res.message, /Do not claim again\./);
    assert.match(res.message, /Resume with POST \/chats\/room-1\/hires\/agr_hire\/admission\./);
  });

  it('sends no room when none is named', async () => {
    const calls = respondWith({ ok: true, kind: 'hand-off', agreement: hire('active') });
    const res = await claim({});
    assert.deepEqual(calls[0]?.body, {});
    assert.equal(res.room, undefined);
  });
});
