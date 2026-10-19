import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgreementFormatter } from '../src/formatters/AgreementFormatter.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgreement(overrides = {}) {
  return {
    agreementId: 'agr_001',
    status:      'active',
    parties: {
      creator:    { principal: null, actor: 'agent-001' },
      provider:   { principal: null, actor: 'agent-002' },
      payer:      { principal: 'user-001', actor: null },
      proposedTo: { principal: null, actor: null },
    },
    proposal: { status: null, respondedBy: null },
    money:    { price: null, paymentStatus: 'none' },
    terms:    { lifecycle: 'open' },
    creatorIsYou:    false,
    providerIsYou:   false,
    payerIsYou:      false,
    proposedToIsYou: false,
    task: null,
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    taskId:      'task_001',
    description: 'Do the work',
    state:       'active',
    parentTaskId: null,
    result:      null,
    plan:        { steps: [] },
    subtasks:    [],
    ...overrides,
  };
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('AgreementFormatter constructor', () => {
  it('defaults shortIds to false and indentSize to 2', () => {
    const f = new AgreementFormatter();
    assert.equal((f as any).shortIds,    false);
    assert.equal((f as any).indentSize,  2);
  });

  it('accepts shortIds: true', () => {
    const f = new AgreementFormatter({ shortIds: true });
    assert.equal((f as any).shortIds, true);
  });

  it('accepts custom indentSize', () => {
    const f = new AgreementFormatter({ indentSize: 4 });
    assert.equal((f as any).indentSize, 4);
  });
});

// ── format() — empty / null ───────────────────────────────────────────────────

describe('AgreementFormatter.format — empty input', () => {
  const f = new AgreementFormatter();

  it('returns "No active agreements." for null', () => {
    assert.equal(f.format(null), 'No active agreements.');
  });

  it('returns "No active agreements." for empty array', () => {
    assert.equal(f.format([]), 'No active agreements.');
  });
});

// ── format() — section routing ────────────────────────────────────────────────

describe('AgreementFormatter.format — section routing', () => {
  const f = new AgreementFormatter();

  it('puts proposal pending + proposedToIsYou in "Pending Proposals" section', () => {
    const ag = makeAgreement({
      proposal:        { status: 'pending', respondedBy: null },
      proposedToIsYou: true,
    });
    const result = f.format([ag]);
    assert.ok(result.includes('Pending Proposals'), `got:\n${result}`);
  });

  it('puts agreement without a task in "Standing Agreements" section', () => {
    const ag = makeAgreement({ task: null });
    const result = f.format([ag]);
    assert.ok(result.includes('Standing Agreements'), `got:\n${result}`);
  });

  it('puts agreement with a task (and not pending-to-you) in "Active Agreements" section', () => {
    const ag = makeAgreement({ task: makeTask() });
    const result = f.format([ag]);
    assert.ok(result.includes('Active Agreements'), `got:\n${result}`);
  });

  it('renders all three sections when all types are present', () => {
    const pending  = makeAgreement({ proposal: { status: 'pending' }, proposedToIsYou: true });
    const standing = makeAgreement({ agreementId: 'agr_002', task: null });
    const active   = makeAgreement({ agreementId: 'agr_003', task: makeTask() });
    const result = f.format([pending, standing, active]);
    assert.ok(result.includes('Pending Proposals'));
    assert.ok(result.includes('Active Agreements'));
    assert.ok(result.includes('Standing Agreements'));
  });
});

// ── formatAgreement — parties ─────────────────────────────────────────────────

describe('AgreementFormatter.formatAgreement — parties', () => {
  const f = new AgreementFormatter();

  it('shows [STATUS] and agreementId', () => {
    const result = f.format([makeAgreement()]);
    assert.ok(result.includes('[ACTIVE]'), `got:\n${result}`);
    assert.ok(result.includes('agr_001'));
  });

  it('labels "You (id)" when creatorIsYou is true', () => {
    const ag = makeAgreement({ creatorIsYou: true });
    const result = f.format([ag]);
    assert.ok(result.includes('You (agent-001)'), `got:\n${result}`);
  });

  it('labels "You (id)" when providerIsYou is true', () => {
    const ag = makeAgreement({ providerIsYou: true });
    const result = f.format([ag]);
    assert.ok(result.includes('You (agent-002)'), `got:\n${result}`);
  });

  it('shows "Proposed to" line only when proposedTo is set', () => {
    const withProposed    = makeAgreement({ parties: { ...makeAgreement().parties, proposedTo: { principal: 'user-99', actor: null } } });
    const withoutProposed = makeAgreement();
    assert.ok( f.format([withProposed]).includes('Proposed to'));
    assert.ok(!f.format([withoutProposed]).includes('Proposed to'));
  });

  it('shows proposal sub-state when proposal.status is set', () => {
    const ag = makeAgreement({ proposal: { status: 'approved', respondedBy: 'user-001' } });
    const result = f.format([ag]);
    assert.ok(result.includes('Proposal: approved'), `got:\n${result}`);
    assert.ok(result.includes('by user-001'));
  });

  it('shows money line when price > 0', () => {
    const ag = makeAgreement({ money: { price: 500, paymentStatus: 'held' } });
    const result = f.format([ag]);
    assert.ok(result.includes('500 hundredths of a point'), `got:\n${result}`);
    assert.ok(result.includes('held'));
  });

  it('omits money line when price is null or 0', () => {
    const ag = makeAgreement({ money: { price: null, paymentStatus: 'none' } });
    assert.ok(!f.format([ag]).includes('Money'));
  });

  it('shows terms when lifecycle is not open', () => {
    const ag = makeAgreement({ terms: { lifecycle: 'time-bound', expiresAt: '2025-12-31', description: 'SLA' } });
    const result = f.format([ag]);
    assert.ok(result.includes('time-bound'), `got:\n${result}`);
    assert.ok(result.includes('SLA'));
  });

  it('shows "(none yet)" for execution when task is null', () => {
    const result = f.format([makeAgreement({ task: null })]);
    assert.ok(result.includes('(none yet)'), `got:\n${result}`);
  });
});

// ── _renderTaskExecution ──────────────────────────────────────────────────────

describe('AgreementFormatter._renderTaskExecution', () => {
  const f = new AgreementFormatter();

  it('shows [STATE] description and taskId', () => {
    const ag = makeAgreement({ task: makeTask({ state: 'active' }) });
    const result = f.format([ag]);
    assert.ok(result.includes('[ACTIVE]'));
    assert.ok(result.includes('Do the work'));
    assert.ok(result.includes('task_001'));
  });

  it('shows parentTaskId when present', () => {
    const ag = makeAgreement({ task: makeTask({ parentTaskId: 'task_parent' }) });
    const result = f.format([ag]);
    assert.ok(result.includes('task_parent'), `got:\n${result}`);
  });

  it('shows result preview for completed task', () => {
    const ag = makeAgreement({ task: makeTask({ state: 'completed', result: 'All done' }) });
    const result = f.format([ag]);
    assert.ok(result.includes('All done'), `got:\n${result}`);
  });

  it('truncates long result to 100 chars with ellipsis', () => {
    const longResult = 'x'.repeat(120);
    const ag = makeAgreement({ task: makeTask({ state: 'completed', result: longResult }) });
    const result = f.format([ag]);
    assert.ok(result.includes('...'), `expected truncation, got:\n${result}`);
    const resultLine = result.split('\n').find(l => l.includes('Result:'));
    assert.ok(resultLine!.length < longResult.length + 30);
  });

  it('omits result for active task even if result is set', () => {
    const ag = makeAgreement({ task: makeTask({ state: 'active', result: 'should not show' }) });
    const result = f.format([ag]);
    assert.ok(!result.includes('should not show'), `got:\n${result}`);
  });

  it('renders plan steps with status icons', () => {
    const steps = [
      { stepId: 's1', description: 'Research', order: 0, status: 'completed', result: 'done' },
      { stepId: 's2', description: 'Write',    order: 1, status: 'in_progress', result: null },
    ];
    const ag = makeAgreement({ task: makeTask({ plan: { steps } }) });
    const result = f.format([ag]);
    assert.ok(result.includes('Research'), `got:\n${result}`);
    assert.ok(result.includes('Write'));
    assert.ok(result.includes('✓')); // completed icon
    assert.ok(result.includes('●')); // in_progress icon
    assert.ok(result.includes('2/2') || result.includes('1/2'));
  });

  it('renders subtask count and state', () => {
    const subtasks = [
      { taskId: 'sub_1', description: 'Subtask A', state: 'active', providerIsYou: false },
    ];
    const ag = makeAgreement({ task: makeTask({ subtasks }) });
    const result = f.format([ag]);
    assert.ok(result.includes('Subtask'), `got:\n${result}`);
    assert.ok(result.includes('[ACTIVE]'));
  });
});

// ── _labelParty ───────────────────────────────────────────────────────────────

describe('AgreementFormatter._labelParty', () => {
  const f = new AgreementFormatter();

  it('returns "N/A" when the side is empty', () => {
    assert.equal(f._labelParty(null, false), 'N/A');
    assert.equal(f._labelParty({ principal: null, actor: null }, false), 'N/A');
  });

  it('returns "You (id)" when isYou is true', () => {
    assert.equal(f._labelParty({ actor: 'agent-001' }, true), 'You (agent-001)');
  });

  it('returns the occupied column when isYou is false', () => {
    assert.equal(f._labelParty({ actor: 'agent-001' }, false), 'agent-001');
    assert.equal(f._labelParty({ principal: 'user-001' }, false), 'user-001');
  });

  it('names both the principal and the agent acting for it', () => {
    assert.equal(
      f._labelParty({ principal: 'org_acme', actor: 'agent-001' }, false),
      'org_acme via agent-001',
    );
  });
});

// ── shortId ───────────────────────────────────────────────────────────────────

describe('AgreementFormatter.shortId', () => {
  it('returns full id when shortIds is false', () => {
    const f = new AgreementFormatter({ shortIds: false });
    const id = 'agr_1234567890_abcdefghij';
    assert.equal(f.shortId(id), id);
  });

  it('truncates long id when shortIds is true', () => {
    const f = new AgreementFormatter({ shortIds: true });
    const id = 'agr_1234567890_abcdefghij';
    const result = f.shortId(id);
    assert.ok(result.endsWith('...'), `got: ${result}`);
    assert.ok(result.length < id.length);
  });

  it('returns "?" for null', () => {
    const f = new AgreementFormatter();
    assert.equal(f.shortId(null), '?');
  });
});
