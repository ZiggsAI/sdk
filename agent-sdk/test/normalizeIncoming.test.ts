import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIncomingEvent } from '../src/ingress/normalizeIncoming.js';

// normalizeIncomingEvent now does SHAPE/classification only — targeting is
// backend policy (delivery law, phase 4), so there is no client-side
// "is this for me" gate and no shouldProcess/reason fields anymore.
describe('normalizeIncomingEvent', () => {
  it('normalizes a plain message', () => {
    const r = normalizeIncomingEvent({
      text: 'hello',
      metadata: { sender: { id: 'u1' }, receiver: { id: 'agent-1' } },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.chatId, null);
    assert.equal(r.event.type, 'message');
    assert.equal(r.event.text, 'hello');
  });

  it('threads the delivery hire onto a chat-room message (ZIG-1728)', () => {
    const r = normalizeIncomingEvent({
      text: 'hello',
      metadata: {
        chatId: 'chat-dana',
        agreementId: 'agr_dana',
        sender: { id: 'u1' },
        receiver: { id: 'agent-1' },
      },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.chatId, 'chat-dana');
    assert.equal(r.event.agreementId, 'agr_dana');
  });

  it('threads the wire messageId through so wake keys can anchor on it', () => {
    const r = normalizeIncomingEvent({
      text: 'hello',
      metadata: { messageId: 'row-123', sender: { id: 'u1' }, receiver: { id: 'agent-1' } },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.event.messageId, 'row-123');

    // Absent or non-string messageId stays absent — wake keys then fall back or go keyless.
    const none = normalizeIncomingEvent({
      text: 'hello',
      metadata: { sender: { id: 'u1' }, receiver: { id: 'agent-1' } },
      ownAgentId: 'agent-1',
    });
    assert.equal(none.event.messageId, undefined);
  });

  it('prefers inbox-rewritten receiverId over the chat row receiver (stand-in cover)', () => {
    const r = normalizeIncomingEvent({
      text: 'can you confirm',
      metadata: {
        sender: { id: 'bob' },
        receiver: { id: 'alice' },
        receiverId: 'stand-in-9a8b7c6d5e4f3021',
      },
      ownAgentId: 'stand-in-9a8b7c6d5e4f3021',
    });
    assert.equal(r.event.type, 'message');
    assert.equal(r.event.receiverId, 'stand-in-9a8b7c6d5e4f3021');
  });

  it('classifies a message addressed to another id as a plain message (no client-side targeting gate)', () => {
    // Pre-law this would have been filtered out client-side; now the backend
    // only ever delivers what is fenced to this agent, so the host classifies
    // whatever it receives without re-deciding relevance.
    const r = normalizeIncomingEvent({
      text: 'secret',
      metadata: { sender: { id: 'u1' }, receiver: { id: 'agent-2' } },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.event.type, 'message');
    assert.equal(r.event.text, 'secret');
  });

  it('classifies a broadcast receiver "everyone" as a plain message', () => {
    const r = normalizeIncomingEvent({
      text: 'all',
      metadata: { receiver: { id: 'everyone' } },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.event.type, 'message');
  });

  it('ZIG-1035: active task spawn notices are notification (not task_result speech/work)', () => {
    const task = {
      taskId: 't1',
      state: 'active',
      executorId: 'agent-1',
    };
    const r = normalizeIncomingEvent({
      text: 'Task created: t1',
      metadata: {
        entryType: 'notification',
        task,
      },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.event.type, 'notification');
    assert.equal(r.event.entryType, 'notification');
    assert.equal((r.event.result as Record<string, unknown>).taskId, 't1');
  });

  it('ZIG-1035: terminal task notices stay task_result for orchestrators', () => {
    const task = {
      taskId: 't1',
      state: 'completed',
      executorId: 'other',
    };
    const r = normalizeIncomingEvent({
      text: 'Task completed',
      metadata: { entryType: 'notification', task },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.event.type, 'task_result');
    assert.equal((r.event.result as Record<string, unknown>).taskId, 't1');
  });

  it('classifies task_result for non-notification task wires (direct injection)', () => {
    const task = {
      taskId: 't1',
      state: 'active',
      executorId: 'agent-1',
    };
    const r = normalizeIncomingEvent({
      text: '',
      metadata: { contentType: 'task', task },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.event.type, 'task_result');
  });

  it('classifies agreement_lifecycle when wire carries explicit operation + agreementId', () => {
    const r = normalizeIncomingEvent({
      text: 'Proposal approved: agr-1',
      metadata: {
        chatId: 'c3',
        entryType: 'notification',
        contentType: 'proposal',
        operation: 'proposal_approved',
        agreementId: 'agr-1',
        receiver: { id: 'agent-1' },
      },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.event.type, 'agreement_lifecycle');
    assert.equal(r.event.operation, 'proposal_approved');
    assert.equal(r.event.agreementId, 'agr-1');
  });

  it('maps proposal_approved_execute to agreement_lifecycle', () => {
    const r = normalizeIncomingEvent({
      text: 'Agreement agr-1 is now active — tasks may be spawned.',
      metadata: {
        entryType: 'notification',
        contentType: 'agreement_update',
        operation: 'proposal_approved_execute',
        agreementId: 'agr-1',
        receiver: { id: 'agent-1' },
      },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.event.type, 'agreement_lifecycle');
    assert.equal(r.event.operation, 'proposal_approved_execute');
  });

  it('threads formedBy from the embedded agreement row onto the lifecycle event', () => {
    const r = normalizeIncomingEvent({
      text: 'Agreement agr-1 is now active — tasks may be spawned.',
      metadata: {
        entryType: 'notification',
        contentType: 'agreement_update',
        operation: 'proposal_approved_execute',
        receiver: { id: 'agent-1' },
        service: {
          agreementId: 'agr-1',
          agreement: { agreementId: 'agr-1', status: 'active', formedBy: 'agent' },
        },
      },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.event.type, 'agreement_lifecycle');
    assert.equal(r.event.formedBy, 'agent');
    assert.equal(r.event.agreementId, 'agr-1');
  });

  it('ZIG-936: classifies task_result from the inbox-pull wire shape (service.task)', () => {
    const r = normalizeIncomingEvent({
      text: '',
      metadata: {
        entryType: 'notification',
        contentType: 'task',
        // the real inbox-pull wire nests the task under `service`, not top-level
        service: { task: { taskId: 't9', state: 'completed', result: { ok: true } } },
      },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.event.type, 'task_result');
    assert.equal((r.event.result as Record<string, unknown>).taskId, 't9');
  });

  it('ZIG-936: classifies agreement_lifecycle from the inbox-pull wire shape (service.operation + service.agreementId)', () => {
    const r = normalizeIncomingEvent({
      text: 'Proposal approved: agr-9',
      metadata: {
        chatId: 'c9',
        entryType: 'notification',
        contentType: 'proposal',
        // operation + agreementId arrive under `service` on the pull path
        service: { operation: 'proposal_approved', agreementId: 'agr-9' },
        receiver: { id: 'agent-1' },
      },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.event.type, 'agreement_lifecycle');
    assert.equal(r.event.operation, 'proposal_approved');
    assert.equal(r.event.agreementId, 'agr-9');
  });

  it('ZIG-1035: proposal_created is a notification, not counterparty message', () => {
    const r = normalizeIncomingEvent({
      text: 'New proposal',
      metadata: {
        entryType: 'notification',
        contentType: 'proposal',
        operation: 'proposal_created',
        agreementId: 'agr-1',
        receiver: { id: 'agent-1' },
      },
      ownAgentId: 'agent-1',
    });
    assert.equal(r.event.type, 'notification');
    assert.notEqual(r.event.type, 'agreement_lifecycle');
    assert.equal(r.event.operation, 'proposal_created');
  });

  it('ZIG-1052: proposal_created with already-active agreement is hire work signal', () => {
    // Prod self-hire: activateIfFullyConsented runs before fan-out, so the
    // chat card still says proposal_created while the embedded row is active.
    const r = normalizeIncomingEvent({
      text: 'New proposal: ZIG-1052 DND',
      metadata: {
        chatId: 'chat-hire',
        entryType: 'notification',
        contentType: 'proposal',
        service: {
          operation: 'proposal_created',
          agreementId: 'agr-hire-1',
          agreement: {
            agreementId: 'agr-hire-1',
            status: 'active',
            proposal: { status: 'approved' },
          },
        },
        receiver: { id: 'claude-sdk-inbox' },
      },
      ownAgentId: 'claude-sdk-inbox',
    });
    assert.equal(r.event.type, 'agreement_lifecycle');
    assert.equal(r.event.operation, 'proposal_approved_execute');
    assert.equal(r.event.agreementId, 'agr-hire-1');
  });

  // ZIG-1078 — a proposal_created addressed to a PENDING approver is a consent
  // request the agent must act on, not a notice to park. The hand-off provider
  // (ZIG-1059) was alerted and then never looked until a human nudged.
  it('classifies proposal_created as agreement_lifecycle when the receiver holds a pending approval', () => {
    const r = normalizeIncomingEvent({
      text: 'New proposal: hand-off',
      metadata: {
        chatId: 'c-hire',
        entryType: 'notification',
        contentType: 'proposal',
        receiver: { id: 'agent-hired' },
        service: {
          operation: 'proposal_created',
          agreement: {
            agreementId: 'agr-handoff-1',
            status: 'open',
            proposal: { status: 'pending' },
            approvals: [
              { partyId: 'user-publisher', role: 'payer', status: 'self-consent' },
              { partyId: 'agent-hired', role: 'provider', status: 'pending' },
            ],
          },
        },
      },
      ownAgentId: 'agent-hired',
    });
    assert.equal(r.event.type, 'agreement_lifecycle');
    assert.equal(r.event.operation, 'proposal_created');
    assert.equal(r.event.agreementId, 'agr-handoff-1');
  });

  it('keeps proposal_created a parked notification when the receiver holds NO pending approval', () => {
    const r = normalizeIncomingEvent({
      text: 'New proposal: someone else’s consent',
      metadata: {
        chatId: 'c-hire',
        entryType: 'notification',
        contentType: 'proposal',
        receiver: { id: 'agent-bystander' },
        service: {
          operation: 'proposal_created',
          agreement: {
            agreementId: 'agr-other',
            status: 'open',
            proposal: { status: 'pending' },
            approvals: [
              { partyId: 'someone-else', role: 'provider', status: 'pending' },
            ],
          },
        },
      },
      ownAgentId: 'agent-bystander',
    });
    assert.equal(r.event.type, 'notification');
  });

  it('reads chatId from message metadata (not embedded on task payloads)', () => {
    const r1 = normalizeIncomingEvent({
      text: 'x',
      metadata: { chatId: 'c1', receiver: { id: 'a' } },
    });
    assert.equal(r1.chatId, 'c1');

    const r2 = normalizeIncomingEvent({
      text: '',
      metadata: {
        chatId: 'c2',
        entryType: 'notification',
        task: { taskId: 't' },
      },
    });
    assert.equal(r2.chatId, 'c2');
  });
});
