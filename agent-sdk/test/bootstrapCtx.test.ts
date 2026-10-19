/**
 * ZIG-777: bootstrapCtx is the single place a per-lane Ctx is constructed —
 * shared by the FSM (AgentMachine) and the Claude Agent SDK brain (ClaudeBrain).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapCtx } from '../src/runtime/bootstrapCtx.js';
import { LANE_BOOK_KEY } from '../src/runtime/taskBookkeeping.js';
import type { Ctx, Identity } from '../src/types.js';

const identity: Identity = { agentId: 'a1', sessionId: 's1', laneKey: 'a1:s1' };

describe('bootstrapCtx (ZIG-777)', () => {
  it('builds a fresh ctx with the canonical empty state', () => {
    const ctx = bootstrapCtx(identity);
    assert.deepEqual(ctx.identity, identity);
    assert.deepEqual(ctx.tasks, {});
    assert.equal(ctx.activeAgreementId, null);
    assert.equal(ctx.activeTaskId, null);
    assert.equal(ctx.pendingProposalAgreementId, null);
    assert.deepEqual(ctx.toolResults, []);
    assert.deepEqual(ctx.lastOutcome, { kind: 'enter' });
    // ZIG-1128: the lane-level mirrors are not on Ctx at all any more. They were
    // required-and-always-empty, which read to a caller as "there is nothing
    // delegated" rather than "ask the books" — and one live FSM guard did exactly
    // that. Absent, not empty, so a reader has to use the all*() helpers.
    assert.deepEqual(Object.keys(ctx).sort(), [
      'activeAgreementId',
      'activeTaskId',
      'identity',
      'lastOutcome',
      'pendingProposalAgreementId',
      'tasks',
      'toolResults',
    ]);
  });

  it('restores an existing ctx: re-stamps identity, preserves protocol state', () => {
    const existing: Ctx = {
      identity: { agentId: 'old', sessionId: 'old', laneKey: 'old' },
      tasks: {
        't-1': {
          agreementId: 'ag-1',
          pendingSubtasks: { x: { agentId: 'e', spawnedAt: 1 } },
          collectedResults: [{ taskId: 't', agentId: null, status: 'completed', result: null }],
          delegatedAgreementIds: ['d-1'],
        },
      },
      activeAgreementId: 'ag-1',
      activeTaskId: 't-1',
      pendingProposalAgreementId: 'p-1',
      toolResults: [],
      lastOutcome: { kind: 'enter' },
      claudeSessionId: 'sess',
    };
    const ctx = bootstrapCtx(identity, existing);
    assert.deepEqual(ctx.identity, identity); // re-stamped, not the old identity
    assert.equal(ctx.activeAgreementId, 'ag-1');
    assert.equal(ctx.claudeSessionId, 'sess');
    assert.deepEqual(ctx.tasks, existing.tasks);
  });

  // ZIG-1128: a row persisted before the mirrors were dropped still carries
  // them. `migrateLegacyTaskFields` has already folded their contents into
  // `tasks`, so carrying the husks forward would resurrect the always-empty
  // reads the removal exists to prevent.
  it('drops the lane-level mirrors a pre-ZIG-1057 persisted ctx still carries', () => {
    const persisted = {
      identity: { agentId: 'old', sessionId: 'old', laneKey: 'old' },
      tasks: { 't-1': { agreementId: 'ag-1', pendingSubtasks: {}, collectedResults: [], delegatedAgreementIds: ['d-1'] } },
      activeAgreementId: 'ag-1',
      activeTaskId: 't-1',
      pendingProposalAgreementId: null,
      pendingSubtasks: {},
      collectedResults: [],
      delegatedAgreementIds: [],
      toolResults: [],
      lastOutcome: { kind: 'enter' },
    } as unknown as Ctx;
    const ctx = bootstrapCtx(identity, persisted);
    assert.equal('pendingSubtasks' in ctx, false);
    assert.equal('collectedResults' in ctx, false);
    assert.equal('delegatedAgreementIds' in ctx, false);
    // The real books survive.
    assert.deepEqual(ctx.tasks['t-1']?.delegatedAgreementIds, ['d-1']);
  });

  it('migrates pre-ZIG-977 lane-level pendingSubtasks into tasks map', () => {
    const legacy = {
      identity: { agentId: 'old', sessionId: 'old', laneKey: 'old' },
      activeAgreementId: 'ag-1',
      activeTaskId: 't-1',
      pendingProposalAgreementId: null,
      delegatedAgreementIds: ['d-1'],
      pendingSubtasks: { x: { agentId: 'e', spawnedAt: 1 } },
      collectedResults: [{ taskId: 't', agentId: null, status: 'completed', result: null }],
      toolResults: [],
      lastOutcome: { kind: 'enter' },
    } as unknown as Ctx;
    const ctx = bootstrapCtx(identity, legacy);
    assert.deepEqual(ctx.tasks['t-1'], {
      agreementId: 'ag-1',
      pendingSubtasks: { x: { agentId: 'e', spawnedAt: 1 } },
      collectedResults: [{ taskId: 't', agentId: null, status: 'completed', result: null }],
      delegatedAgreementIds: ['d-1'],
    });
  });

  it('defaults tasks to {} when an old persisted ctx lacks them and has no legacy fields', () => {
    const legacy = {
      identity: { agentId: 'old', sessionId: 'old', laneKey: 'old' },
      activeAgreementId: null,
      activeTaskId: null,
      pendingProposalAgreementId: null,
      delegatedAgreementIds: [],
      toolResults: [],
      lastOutcome: { kind: 'enter' },
    } as unknown as Ctx;
    const ctx = bootstrapCtx(identity, legacy);
    assert.deepEqual(ctx.tasks, {});
    assert.equal(ctx.tasks[LANE_BOOK_KEY], undefined);
  });
});
