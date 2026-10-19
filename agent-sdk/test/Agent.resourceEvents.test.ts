/**
 * host-side resource-event routing (delivery law, phase 4): handleResourceEvent
 * routes whatever the inbox loop hands it onto a lane. There is NO client-side
 * self-suppression or dedup guard anymore — wake targeting is backend policy
 * (the law never routes an agent its own writes), so the host trusts what it
 * receives and just opens the lane.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';

type HostInternals = {
  sessions: Map<string, unknown>;
};

const makeHost = () =>
  new Agent({
    agentId: 'agent-me',
    operatorKey: 'op-key',
    // Fleet defaults to a claude-* model now, so a bare FSM host needs the
    // Anthropic key. This suite is provider-agnostic (lane routing only).
    anthropicKey: 'test-key',
    initial: 'idle',
    states: { idle: { kind: 'parked' as const, transitions: [] } },
    inboxCatchUp: false,
  });

const internals = (host: Agent) => host as unknown as HostInternals;

describe('Agent.handleResourceEvent routing', () => {
  it('opens a lane for a resource event caused by another principal', async () => {
    const host = makeHost();
    await host.handleResourceEvent({
      kind: 'artifact', ts: 't', resourceId: 'art-1', chatId: 'chat-1',
      change: 'created', actorId: 'someone-else',
    });
    assert.equal(internals(host).sessions.size, 1);
  });

  it('opens a lane even for a self-caused event — targeting is backend policy, the host no longer filters', async () => {
    const host = makeHost();
    await host.handleResourceEvent({
      kind: 'artifact', ts: 't', resourceId: 'art-1', chatId: 'chat-1',
      change: 'created', actorId: 'agent-me',
    });
    // The backend never delivers this in practice (self-caused events don't
    // target their sender); if one arrives, the host does not second-guess it.
    assert.equal(internals(host).sessions.size, 1);
  });

  it('ZIG-1278: chat-less agreement claim opens agrn-<agreementId> lane (not dropped)', async () => {
    const host = makeHost();
    const enqueued: Array<{ event: Record<string, unknown>; laneKey: string }> = [];
    const queue = (host as unknown as { eventQueue: { enqueue: (...args: unknown[]) => Promise<void> } }).eventQueue;
    const orig = queue.enqueue.bind(queue);
    queue.enqueue = async (event: unknown, laneKey: unknown) => {
      enqueued.push({ event: event as Record<string, unknown>, laneKey: String(laneKey) });
      return orig(event, laneKey);
    };

    await host.handleResourceEvent({
      kind: 'agreement',
      ts: 't',
      resourceId: 'ag-claim-1',
      agreementId: 'ag-claim-1',
      change: 'created',
      reason: 'proposal_approved',
      actorId: 'buyer-user-1',
    });

    assert.equal(internals(host).sessions.size, 1);
    assert.ok(internals(host).sessions.has('agent-me:agrn-ag-claim-1'));
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].laneKey, 'agent-me:agrn-ag-claim-1');
    assert.equal(enqueued[0].event.type, 'resource_changed');
    assert.equal(enqueued[0].event.senderId, 'buyer-user-1');
    assert.equal(enqueued[0].event.agreementId, 'ag-claim-1');
  });

  it('ZIG-1278: chat-less agreement with only resourceId still lanes as agrn-*', async () => {
    const host = makeHost();
    await host.handleResourceEvent({
      kind: 'agreement',
      ts: 't',
      resourceId: 'ag-only-res',
      change: 'created',
      reason: 'proposal_approved',
      actorId: 'buyer-2',
    });
    assert.ok(internals(host).sessions.has('agent-me:agrn-ag-only-res'));
  });
});

describe('access decision continuation', () => {
  it('does not answer the duplicate chat notification for an access decision', async () => {
    const host = makeHost();
    for (const operation of ['proposal_approved', 'proposal_rejected']) {
      await host.handleMessage('Access decision', { entryType: 'notification', service: { operation, agreement: { grantRequest: { primitive: 'context', kind: 'access-request' } } } });
    }
    assert.equal(internals(host).sessions.size, 0);
  });
  it('does not pin the inbox when the approval agreement is no longer readable', async () => {
    const host = makeHost();
    const emitted: Record<string, unknown>[] = [];
    const internal = host as unknown as {
      agreementService: { get: (id: string) => Promise<unknown> };
      eventQueue: { enqueue: (event: Record<string, unknown>, lane: string) => Promise<void> };
    };
    internal.agreementService.get = async () => { throw new Error('Forbidden'); };
    internal.eventQueue.enqueue = async event => { emitted.push(event); };
    for (const reason of ['approval:approved', 'status:cancelled', 'context_request_rejected']) {
      await host.handleResourceEvent({ kind: 'agreement', resourceId: 'unreadable', chatId: 'original-chat', reason });
    }
    assert.equal(emitted.length, 3);
    assert.ok(emitted.every(event => event.agreementId === 'unreadable'));
  });
  it('resumes the recorded hire while preserving the permission decision reference', async () => {
    const host = makeHost();
    const emitted: Record<string, unknown>[] = [];
    const internal = host as unknown as {
      agreementService: { get: (id: string) => Promise<unknown> };
      eventQueue: { enqueue: (event: Record<string, unknown>, lane: string) => Promise<void> };
    };
    internal.agreementService.get = async id => {
      assert.equal(id, 'permission-request');
      return { grantRequest: { primitive: 'context', kind: 'access-request', resumeAgreementId: 'standing-hire' } };
    };
    internal.eventQueue.enqueue = async event => { emitted.push(event); };
    for (const reason of ['approval:rejected', 'status:cancelled', 'context_request_rejected', 'context_request_fulfilled']) {
      await host.handleResourceEvent({ kind: 'agreement', resourceId: 'permission-request', agreementId: 'permission-request', chatId: 'original-chat', reason });
    }
    assert.equal(emitted.length, 2, 'only the authoritative access decision wakes the model');
    for (const event of emitted) {
      assert.equal(event.agreementId, 'standing-hire');
      assert.equal((event.resource as Record<string, unknown>).resourceId, 'permission-request');
      assert.equal(event.chatId, 'original-chat');
    }
  });
});
