import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decisionWords, speakableActor } from '../src/decisionWords.js';

/**
 * The words for a decision on a request the agent made. Both rails (the MCP
 * inbox and the hosted brain) call this, so the sentence is pinned here once.
 */
describe('decisionWords', () => {
  const row = {
    agreementId: 'agr_req',
    actorId: 'user_owner',
    ts: '2026-09-21T10:00:00.000Z',
  };

  it('maps a refused access request to a refusal that says where to report it', () => {
    const out = decisionWords({ ...row, reason: 'context_request_rejected' });
    assert.ok(out);
    assert.equal(out!.outcome, 'rejected');
    assert.equal(
      out!.sentence,
      'Your access request on agreement agr_req was refused by user_owner at 2026-09-21T10:00:00.000Z. ' +
        'Report the unresolved dependency where you asked, and ask what to change.',
    );
  });

  it('maps every refusal reason to the same outcome', () => {
    for (const reason of [
      'approval:rejected',
      'context_request_rejected',
      'connection_request_rejected',
    ]) {
      const out = decisionWords({ ...row, reason });
      assert.equal(out?.outcome, 'rejected', reason);
      assert.match(out!.sentence, /was refused by user_owner/);
      assert.match(out!.sentence, /ask what to change/);
    }
  });

  it('maps an approved access request to the artifact, bounded, on the MCP surface', () => {
    const out = decisionWords({
      ...row,
      reason: 'context_request_fulfilled',
      scope: { kind: 'artifact', id: 'art_1' },
    });
    assert.equal(out?.outcome, 'fulfilled');
    assert.equal(
      out!.sentence,
      'Your access request on agreement agr_req was approved by user_owner at 2026-09-21T10:00:00.000Z. ' +
        'Open the artifact art_1 with ziggs_context_read or ziggs_open; ' +
        'the grant is bounded, check its expiry on the agreement.',
    );
  });

  it('sends the reader to the agreement when the artifact id is not known', () => {
    const out = decisionWords({ ...row, reason: 'context_request_fulfilled' });
    assert.equal(out?.outcome, 'fulfilled');
    assert.match(out!.sentence, /Open the agreement with ziggs_open to find the artifact/);
    assert.match(out!.sentence, /check its expiry on the agreement/);
    assert.doesNotMatch(out!.sentence, /art_/);
  });

  it('uses the hosted SDK tool names when asked', () => {
    const out = decisionWords({
      ...row,
      reason: 'context_request_fulfilled',
      scope: { kind: 'artifact', id: 'art_1' },
      surface: 'sdk',
    });
    assert.match(out!.sentence, /with context_read or open;/);
    assert.doesNotMatch(out!.sentence, /ziggs_/);
  });

  it('an approval slot answered is an approval to act on, not a hire', () => {
    const out = decisionWords({ ...row, reason: 'approval:approved' });
    assert.equal(out?.outcome, 'approved');
    assert.match(out!.sentence, /^An approval on agreement agr_req was given by user_owner at 2026-09-21T10:00:00.000Z\./);
    assert.match(out!.sentence, /carry out the next step you promised where you asked/);
    assert.match(out!.sentence, /not a new hire/);
  });

  it('a fulfilled connection request and a held formation have their own outcomes', () => {
    assert.equal(
      decisionWords({ ...row, reason: 'connection_request_fulfilled' })?.outcome,
      'fulfilled',
    );
    const held = decisionWords({ ...row, reason: 'formation_held' });
    assert.equal(held?.outcome, 'held');
    assert.match(held!.sentence, /^Agreement agr_req is held at 2026-09-21T10:00:00.000Z:/);
    assert.match(held!.sentence, /nothing is granted/);
  });

  it('leaves out the actor and instant when the row does not carry them', () => {
    const out = decisionWords({ reason: 'context_request_fulfilled', agreementId: 'agr_x' });
    assert.match(out!.sentence, /^Your access request on agreement agr_x was approved\. /);
    assert.doesNotMatch(out!.sentence, / by /);
    assert.doesNotMatch(out!.sentence, / at /);
  });

  it("never says a person's raw account id, even when an older server sends it", () => {
    for (const reason of [
      'context_request_fulfilled',
      'context_request_rejected',
      'connection_request_fulfilled',
      'approval:approved',
    ]) {
      const out = decisionWords({ ...row, reason, actorId: 'emma:::emma@corp.com' });
      assert.ok(out, reason);
      assert.doesNotMatch(out!.sentence, /emma|@|:::/, reason);
      assert.doesNotMatch(out!.sentence, / by /, reason);
    }
    // The face the server sends instead is said as it is.
    assert.match(
      decisionWords({ ...row, reason: 'context_request_fulfilled', actorId: 'psn_emma' })!.sentence,
      /was approved by psn_emma at /,
    );
    assert.equal(speakableActor('emma:::emma@corp.com'), null);
    assert.equal(speakableActor('emma@corp.com'), null);
    assert.equal(speakableActor('agent_store'), 'agent_store');
    assert.equal(speakableActor(null), null);
  });

  it('returns null for anything that is not a decision', () => {
    for (const reason of [
      undefined,
      null,
      '',
      'proposal_approved',
      'approval:',
      'context_request_created',
    ]) {
      assert.equal(decisionWords({ ...row, reason }), null, String(reason));
    }
  });

  it('names a scope only when it is an artifact', () => {
    const chat = decisionWords({
      ...row,
      reason: 'context_request_fulfilled',
      scope: { kind: 'chat', id: 'chat_9' },
    });
    assert.doesNotMatch(chat!.sentence, /chat_9/);
    assert.match(chat!.sentence, /to find the artifact/);
  });
});
