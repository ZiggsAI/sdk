import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVERYDAY_MCP_TOOLS,
  EVERYDAY_NO_SDK_TWIN,
  EVERYDAY_SDK_TOOLS,
  annotationForSdkTool,
} from '../src/capabilities/index.js';

describe('everyday tool set (ZIG-1418)', () => {
  it('is the MCP native list, in the order a cold session already loads', () => {
    assert.deepEqual([...EVERYDAY_MCP_TOOLS], [
      'ziggs_inbox',
      'ziggs_inbox_peek',
      'ziggs_inbox_ack',
      'ziggs_open',
      'ziggs_context_read',
      'ziggs_message_send',
      'ziggs_task_set_result',
      'ziggs_agreement_revoke',
      'ziggs_context_revoke_grant',
    ]);
  });

  it('derives the hosted names by stripping ziggs_ from the twins', () => {
    assert.deepEqual([...EVERYDAY_SDK_TOOLS], [
      'open',
      'context_read',
      'message_send',
      'task_set_result',
      'agreement_revoke',
    ]);
    for (const name of EVERYDAY_NO_SDK_TWIN) {
      assert.ok(EVERYDAY_MCP_TOOLS.includes(name));
      assert.equal(EVERYDAY_SDK_TOOLS.includes(name.replace(/^ziggs_/, '')), false);
    }
  });

  it('hints follow the directories: a write is destructive unless purely additive', () => {
    assert.equal(annotationForSdkTool('context_read'), 'read-only');
    // Removed room-opening tools must not be advertised.
    assert.equal(annotationForSdkTool('chat_open'), undefined);
    // Sends, commitments, overwrites, cancellations and revocations.
    for (const name of ['agreement_buy', 'agreement_claim', 'artifact_attach', 'artifact_reextract', 'access_request', 'link_propose', 'introduction_redeem', 'introduction_revoke', 'task_cancel', 'connection_proxy'])
      assert.equal(annotationForSdkTool(name), 'destructive', name);
  });
});
