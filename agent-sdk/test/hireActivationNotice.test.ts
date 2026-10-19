import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  agreementIdFromWake,
  formedByFromWake,
  isHireActivationNotice,
  shouldSkipAgentFormedHireActivation,
} from '../src/brain/hireActivationNotice.js';

describe('hire activation notice (host skip)', () => {
  const execute = {
    type: 'agreement_lifecycle',
    operation: 'proposal_approved_execute',
    agreementId: 'agr_1',
    formedBy: 'agent',
  };

  it('reads formedBy from the agreement row on the wake, never an agent id', () => {
    assert.equal(formedByFromWake(execute), 'agent');
    assert.equal(
      formedByFromWake({ type: 'agreement_lifecycle', agreement: { formedBy: 'principal' } }),
      'principal',
    );
    assert.equal(
      formedByFromWake({
        type: 'resource_changed',
        resource: { formedBy: 'agent', agreementId: 'agr_1' },
      }),
      'agent',
    );
    assert.equal(formedByFromWake({ type: 'agreement_lifecycle', senderId: 'invoice-engineering' }), undefined);
  });

  it('names the agreement from lifecycle, embed, or resource id', () => {
    assert.equal(agreementIdFromWake(execute), 'agr_1');
    assert.equal(
      agreementIdFromWake({
        type: 'resource_changed',
        resource: { kind: 'agreement', resourceId: 'agr_9', reason: 'approval:approved' },
      }),
      'agr_9',
    );
  });

  it('treats the activation ping, store-claim doorbell, and approval echo as notices', () => {
    assert.equal(isHireActivationNotice(execute), true);
    assert.equal(
      isHireActivationNotice({
        type: 'resource_changed',
        resource: { kind: 'agreement', reason: 'proposal_approved' },
      }),
      true,
    );
    assert.equal(
      isHireActivationNotice({
        type: 'resource_changed',
        resource: { kind: 'agreement', reason: 'approval:approved' },
      }),
      true,
    );
    assert.equal(
      isHireActivationNotice({ type: 'task_result', result: { taskId: 't1', state: 'active' } }),
      false,
    );
    assert.equal(isHireActivationNotice({ type: 'message', text: 'hi' }), false);
  });

  it('skips only an agent-formed activation when the manifest does not opt in', () => {
    assert.equal(
      shouldSkipAgentFormedHireActivation({ event: execute, formedBy: 'agent' }),
      true,
    );
    assert.equal(
      shouldSkipAgentFormedHireActivation({ event: execute, formedBy: 'principal' }),
      false,
    );
    assert.equal(
      shouldSkipAgentFormedHireActivation({ event: execute, formedBy: undefined }),
      false,
    );
    assert.equal(
      shouldSkipAgentFormedHireActivation({
        event: execute,
        formedBy: 'agent',
        actsOnHireActivation: true,
      }),
      false,
    );
  });

  it('owner decisions on report access always wake the requesting agent', () => {
    for (const verdict of ['fulfilled', 'rejected']) {
      assert.equal(shouldSkipAgentFormedHireActivation({
        event: { type: 'resource_changed', resource: { kind: 'agreement', reason: `context_request_${verdict}` } },
        formedBy: 'agent',
      }), false);
    }
  });

  it('a person-formed store claim is not skipped', () => {
    assert.equal(
      shouldSkipAgentFormedHireActivation({
        event: {
          type: 'resource_changed',
          resource: { kind: 'agreement', reason: 'proposal_approved' },
        },
        formedBy: 'principal',
      }),
      false,
    );
  });
});
