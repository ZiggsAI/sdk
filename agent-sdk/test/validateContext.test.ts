import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateContext, ContextWarning } from '../src/cognition/validateContext.js';

describe('validateContext', () => {
  it('returns no warnings for valid context', () => {
    const ctx = {
      agreements: [{ agreementId: 'ag-1', parties: { creator: { principal: 'u1' }, provider: { actor: 'a1' } } }],
      agents: [{ agentId: 'a1', isYou: true }],
      users: [{ userId: 'u1' }],
      history: [{ entryType: 'message', sender: { id: 'u1' } }],
    };
    const warnings = validateContext(ctx);
    assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
  });

  it('returns warning for null context', () => {
    const warnings = validateContext(null);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes('missing'));
  });

  it('catches missing agreementId', () => {
    const ctx = { agreements: [{ parties: { creator: { principal: 'u1' }, provider: { actor: 'a1' } } }], agents: [{ agentId: 'a1', isYou: true }], users: [], history: [] };
    assert.ok(validateContext(ctx).some(w => w.path.includes('agreementId')));
  });

  it('catches missing parties', () => {
    const ctx = { agreements: [{ agreementId: 'ag-1' }], agents: [{ agentId: 'a1', isYou: true }], users: [], history: [] };
    assert.ok(validateContext(ctx).some(w => w.path.includes('parties') && w.message === 'missing'));
  });

  it('catches missing creator/provider in parties', () => {
    const ctx = { agreements: [{ agreementId: 'ag-1', parties: {} }], agents: [{ agentId: 'a1', isYou: true }], users: [], history: [] };
    const w = validateContext(ctx);
    assert.ok(w.some(x => x.path.includes('creator')));
    assert.ok(w.some(x => x.path.includes('provider')));
  });

  it('catches missing proposal.status', () => {
    const ctx = { agreements: [{ agreementId: 'ag-1', parties: { creator: { principal: 'u1' }, provider: { actor: 'a1' } }, proposal: {} }], agents: [{ agentId: 'a1', isYou: true }], users: [], history: [] };
    assert.ok(validateContext(ctx).some(w => w.path.includes('proposal.status')));
  });

  it('catches missing task fields inside agreement', () => {
    const ctx = { agreements: [{ agreementId: 'ag-1', parties: { creator: { principal: 'u1' }, provider: { actor: 'a1' } }, task: {} }], agents: [{ agentId: 'a1', isYou: true }], users: [], history: [] };
    const w = validateContext(ctx);
    assert.ok(w.some(x => x.path.includes('task.taskId')));
    assert.ok(w.some(x => x.path.includes('task.state')));
  });

  it('catches missing agentId', () => {
    const ctx = { agreements: [], agents: [{ isYou: true }], users: [], history: [] };
    assert.ok(validateContext(ctx).some(w => w.path.includes('agentId')));
  });

  it('warns when no agent has isYou=true', () => {
    const ctx = { agreements: [], agents: [{ agentId: 'a1' }], users: [], history: [] };
    assert.ok(validateContext(ctx).some(w => w.message.includes('isYou')));
  });

  it('warns when multiple agents have isYou=true', () => {
    const ctx = { agreements: [], agents: [{ agentId: 'a1', isYou: true }, { agentId: 'a2', isYou: true }], users: [], history: [] };
    assert.ok(validateContext(ctx).some(w => w.message.includes('2 agents')));
  });

  it('catches missing entryType in history', () => {
    const ctx = { agreements: [], agents: [{ agentId: 'a1', isYou: true }], users: [], history: [{ text: 'hello' }] };
    assert.ok(validateContext(ctx).some(w => w.path.includes('entryType')));
  });

  it('catches missing sender in message entry', () => {
    const ctx = { agreements: [], agents: [{ agentId: 'a1', isYou: true }], users: [], history: [{ entryType: 'message', text: 'hi' }] };
    assert.ok(validateContext(ctx).some(w => w.path.includes('sender')));
  });

  it('catches missing service.task in task_history entry', () => {
    const ctx = { agreements: [], agents: [{ agentId: 'a1', isYou: true }], users: [], history: [{ entryType: 'task_history', service: {} }] };
    assert.ok(validateContext(ctx).some(w => w.path.includes('service.task')));
  });

  it('catches missing userId', () => {
    const ctx = { agreements: [], agents: [{ agentId: 'a1', isYou: true }], users: [{ userName: 'Bob' }], history: [] };
    assert.ok(validateContext(ctx).some(w => w.path.includes('userId')));
  });

  it('calls logger.warn for each warning', () => {
    const logged: string[] = [];
    const logger = { warn: (msg: string) => logged.push(msg) };
    const ctx = { agreements: [{ agreementId: 'ag-1' }], agents: [{ agentId: 'a1', isYou: true }], users: [], history: [] };
    const warnings = validateContext(ctx, { logger });
    assert.ok(warnings.length > 0);
    assert.equal(logged.length, warnings.length);
  });

  it('toString formats nicely', () => {
    const w = new ContextWarning('agreements[0].parties', 'missing');
    assert.equal(w.toString(), '[context] agreements[0].parties: missing');
  });
});
