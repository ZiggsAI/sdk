import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CLAUDE_SDK_PROTOCOL } from '../src/brain/claudeSdkProtocol.js';
import { chatSendTool } from '../src/brain/claudeSdkTools.js';
import { taskSetResultTool, agreementFulfillTool } from '../src/platform/tools/tier1/protocolTools.js';

/**
 * ZIG-1879 / AX-08 — the hosted surface's protocol and its tool descriptions
 * are read in the same context window, so a disagreement between them is a
 * standing instruction to do one of two contradictory things.
 *
 * The one this ticket was opened on: `chat_send` said "Conversation only —
 * never use for finished-work reporting" while the protocol said to send the
 * human the deliverable in chat. Both were verified on main, 2026-09-16.
 */
describe('AX-08: the hosted protocol and its tool descriptions agree', () => {
  const description = (tool: {
    schema?: { function?: Record<string, unknown> };
  }): string => String(tool.schema?.function?.['description'] ?? '');

  it('chat_send does not forbid what the protocol requires', () => {
    const send = description(chatSendTool);
    assert.doesNotMatch(send, /never use for finished-work reporting/i);
    // Delivery to a person is chat; collection by an agent is the task result.
    assert.match(send, /PERSON receives finished work/);
    assert.match(send, /reads the task result/);
    assert.match(CLAUDE_SDK_PROTOCOL, /send them the deliverable in chat as well/);
  });

  it('chat never stands in for closing the task, on either surface', () => {
    assert.match(description(chatSendTool), /never replaces task_set_result/);
    assert.match(CLAUDE_SDK_PROTOCOL, /never stands in for closing the task/);
  });

  it('delivery goes to the working conversation, not to every linked room', () => {
    assert.match(
      CLAUDE_SDK_PROTOCOL,
      /do not repeat it into every room you can reach/,
    );
  });

  it('completing a task is never described as ending the engagement', () => {
    const setResult = description(taskSetResultTool);
    assert.match(setResult, /closes the task and not the engagement/);
    assert.match(setResult, /ending one is agreement_fulfill/);
    assert.match(CLAUDE_SDK_PROTOCOL, /It does not end the hire/);
    // And fulfilment keeps saying what it really costs.
    assert.match(description(agreementFulfillTool), /END an agreement you provide/);
    assert.match(description(agreementFulfillTool), /never a standing hire that just finished a task/);
  });

  it('a completed task is not reported as a read, or as a paid, one', () => {
    const setResult = description(taskSetResultTool);
    assert.match(setResult, /queued, not read/);
    assert.match(setResult, /not by itself a paid one/);
    assert.match(CLAUDE_SDK_PROTOCOL, /it does not prove anyone has read you/);
    assert.match(CLAUDE_SDK_PROTOCOL, /it does not prove you were paid/);
  });

  it('a lost completion is recovered by reading, never by completing twice', () => {
    assert.match(CLAUDE_SDK_PROTOCOL, /recovered by READING the task back/);
    assert.match(CLAUDE_SDK_PROTOCOL, /no-ops instead of doubling/);
  });
});
