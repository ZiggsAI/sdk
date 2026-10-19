import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PromptBuilder } from '../src/runtime/PromptBuilder.js';
import type { Ctx, Identity } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, 'snapshots');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const IDENTITY: Identity = { agentId: 'agent-001', sessionId: 'chat-snap', laneKey: 'agent-001:chat-snap' };

function makeCtx(extra: Partial<Ctx> = {}): Ctx {
  return {
    identity: IDENTITY,
    tasks: {},
    activeAgreementId: null,
    activeTaskId: null,
    pendingProposalAgreementId: null,
    pendingSubtasks: {},
    collectedResults: [],
    delegatedAgreementIds: [],
    toolResults: [],
    lastOutcome: { kind: 'enter' },
    ...extra,
  };
}

const AGENTS = [
  { agentId: 'agent-001', name: 'TestBot', isYou: true, description: 'A test agent' },
  { agentId: 'agent-002', name: 'HelperBot', isYou: false, description: 'A helper', capabilities: { search: true } },
];
const USERS = [{ userId: 'user-001', userName: 'Alice' }];
const BASE_AGREEMENT = {
  agreementId: 'ag-100', status: 'active',
  parties: {
    creator: { principal: 'user-001', actor: null },
    provider: { principal: null, actor: 'agent-001' },
    payer: { principal: 'user-001', actor: null },
    proposedTo: { principal: null, actor: 'agent-001' },
  },
  creatorIsYou: false, providerIsYou: true, payerIsYou: false, proposedToIsYou: true,
  proposal: { status: 'approved', respondedBy: 'agent-001' },
  money: { price: 500, paymentStatus: 'held' },
  terms: { lifecycle: 'once', description: 'Build a widget' },
  task: {
    taskId: 'task-200', description: 'Build a widget', state: 'in_progress',
    plan: { steps: [
      { order: 1, stepId: 's1', description: 'Design', status: 'completed', result: 'Done' },
      { order: 2, stepId: 's2', description: 'Implement', status: 'in_progress' },
    ] },
  },
};
const PENDING_AGREEMENT = {
  agreementId: 'ag-200', status: 'proposed',
  parties: {
    creator: { principal: null, actor: 'agent-002' },
    provider: { principal: null, actor: 'agent-001' },
    payer: { principal: null, actor: 'agent-002' },
    proposedTo: { principal: null, actor: 'agent-001' },
  },
  creatorIsYou: false, providerIsYou: true, payerIsYou: false, proposedToIsYou: true,
  proposal: { status: 'pending' },
  terms: { description: 'Do research' },
};
const HISTORY = [
  { entryType: 'message', timestamp: '2026-05-06T10:00:00Z', sender: { id: 'user-001', type: 'user' }, receiver: { id: 'agent-001', type: 'agent' }, text: 'Hey, can you help me?' },
  { entryType: 'message', timestamp: '2026-05-06T10:01:00Z', sender: { id: 'agent-001', type: 'agent' }, receiver: { id: 'user-001', type: 'user' }, text: 'Sure, I can help with that.' },
  { entryType: 'task_history', timestamp: '2026-05-06T10:02:00Z', service: { changeType: 'created', task: { taskId: 'task-200', agreementId: 'ag-100', description: 'Build a widget', agentId: 'user-001', executorId: 'agent-001', agreement: { parties: { creator: { principal: 'user-001' }, provider: { actor: 'agent-001' }, proposedTo: { actor: 'agent-001' } } } } } },
];
const ACTIONS = {
  reply: { prompt: { when: 'You want to respond', instruction: 'Write a helpful response', format: '{"thought": "...", "action": "reply", "message": "..."}' }, produces: 'message-sent' as const },
  wait: { prompt: { when: 'Nothing to do right now', instruction: 'Wait for the next event' }, produces: 'wait' as const },
};
const STATE_PROMPT = { role: 'Assistant', goal: 'Help users accomplish tasks', context: 'General purpose agent', constraints: 'Be helpful and concise' };

// ── Scenario builder ──────────────────────────────────────────────────────────

type ScenarioOverrides = {
  statePrompt?: typeof STATE_PROMPT;
  actions?: typeof ACTIONS;
  agents?: unknown[];
  users?: unknown[];
  agreements?: unknown[];
  history?: unknown[];
  tools?: unknown[];
  incomingEvent?: unknown;
  definition?: { description: string };
  stateId?: string;
  ctx?: Ctx;
};

function stabilize(prompt: string): string {
  return prompt.replace(/currentTime: \d{4}-\d{2}-\d{2}T[\d:.]+Z/, 'currentTime: <FROZEN>');
}

function buildScenario(name: string, overrides: ScenarioOverrides = {}): string {
  const builder = new PromptBuilder({ description: 'Snapshot test agent' });
  const raw = builder.buildFromState({
    statePrompt: overrides.statePrompt ?? STATE_PROMPT,
    actions: overrides.actions ?? ACTIONS,
    serverContext: {
      context: {
        agents: (overrides.agents ?? AGENTS) as Record<string, unknown>[],
        users: (overrides.users ?? USERS) as Record<string, unknown>[],
        agreements: (overrides.agreements ?? [BASE_AGREEMENT]) as Record<string, unknown>[],
        history: (overrides.history ?? HISTORY) as Record<string, unknown>[],
      },
      tools: (overrides.tools ?? []) as Record<string, unknown>[],
    },
    incomingEvent: overrides.incomingEvent !== undefined ? overrides.incomingEvent as import('../src/runtime/buildOutcome.js').RawEvent | null : { type: 'message', text: 'Hello!', senderId: 'user-001', senderType: 'user' },
    definition: overrides.definition ?? { description: 'Snapshot test agent' },
    chatId: 'chat-snap',
    stateId: overrides.stateId ?? 'idle',
    ctx: overrides.ctx ?? makeCtx(),
  });
  return stabilize(raw);
}

// Multi-party agreement where the user (creator) is distinct from the
// specialist (provider) and a separate human (proposedTo). Used to exercise
// the <recipients> surface split.
const MULTI_PARTY_AGREEMENT = {
  agreementId: 'ag-300', status: 'proposed',
  parties: {
    creator: { principal: 'user-001', actor: null },
    provider: { principal: null, actor: 'agent-003' },
    payer: { principal: 'user-001', actor: null },
    proposedTo: { principal: 'user-002', actor: null },
  },
  creatorIsYou: false, providerIsYou: false, payerIsYou: false, proposedToIsYou: false,
  proposal: { status: 'pending' },
  terms: { description: 'Order coffee for user-002' },
};
const EXTRA_AGENTS = [
  { agentId: 'agent-001', name: 'TestBot', isYou: true },
  { agentId: 'agent-002', name: 'HelperBot', isYou: false, description: 'A helper' },
  { agentId: 'agent-003', name: 'CoffeeBot', isYou: false, description: 'Coffee specialist' },
];
const EXTRA_USERS = [
  { userId: 'user-001', userName: 'Alice' },
  { userId: 'user-002', userName: 'Bob' },
];

const SCENARIOS: Record<string, ScenarioOverrides> = {
  'basic': {},
  'empty-context': { agents: [], users: [], agreements: [], history: [] },
  'pending-proposal': { agreements: [PENDING_AGREEMENT] },
  'multiple-agreements': { agreements: [BASE_AGREEMENT, PENDING_AGREEMENT] },
  'recipients-surfaces': {
    agents: EXTRA_AGENTS, users: EXTRA_USERS,
    agreements: [BASE_AGREEMENT, MULTI_PARTY_AGREEMENT],
  },
  'task-result-event': {
    incomingEvent: {
      type: 'task_result', senderId: 'agent-002', senderType: 'agent',
      result: { taskId: 'task-200', description: 'Build a widget', state: 'completed', creatorIsYou: false, providerIsYou: true, proposedToIsYou: true, agreement: { agreementId: 'ag-100', parties: { creator: { principal: 'user-001' }, provider: { actor: 'agent-001' }, proposedTo: { actor: 'agent-001' } }, proposal: { status: 'approved' }, money: { price: 500, paymentStatus: 'held' } } },
    },
  },
  'no-event': { incomingEvent: null },
  'with-tools': {
    tools: [
      { schema: { function: { name: 'web_search', description: 'Search the web' } } },
      { schema: { function: { name: 'calculator', description: 'Do math' } } },
    ],
  },
};

// ── Snapshot helpers ──────────────────────────────────────────────────────────

async function readSnapshot(name: string): Promise<string | null> {
  try { return await readFile(join(SNAPSHOT_DIR, `${name}.txt`), 'utf-8'); }
  catch { return null; }
}

async function writeSnapshot(name: string, content: string): Promise<void> {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  await writeFile(join(SNAPSHOT_DIR, `${name}.txt`), content, 'utf-8');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PromptBuilder snapshots', () => {
  before(async () => { await mkdir(SNAPSHOT_DIR, { recursive: true }); });

  for (const [name, overrides] of Object.entries(SCENARIOS)) {
    it(`scenario: ${name}`, async () => {
      const prompt = buildScenario(name, overrides);

      assert.ok(typeof prompt === 'string', 'prompt should be a string');
      assert.ok(prompt.length > 0, 'prompt should not be empty');
      assert.ok(prompt.includes('<agent>'), 'prompt must contain <agent> tag');
      assert.ok(prompt.includes('</agent>'), 'prompt must contain closing </agent> tag');
      assert.ok(prompt.includes('<self>'), 'prompt must contain <self> section');
      assert.ok(prompt.includes('<world>'), 'prompt must contain <world> section');
      assert.ok(prompt.includes('<decision_schema>'), 'prompt must contain <decision_schema> section');

      const existing = await readSnapshot(name);
      if (existing === null || UPDATE) {
        await writeSnapshot(name, prompt);
        console.log(`    [snapshot] ${existing === null ? 'created' : 'updated'}: ${name}.txt`);
        return;
      }
      if (prompt !== existing) {
        const pLines = prompt.split('\n'), eLines = existing.split('\n'), diffs: string[] = [];
        for (let i = 0; i < Math.max(pLines.length, eLines.length); i++) {
          if (pLines[i] !== eLines[i]) {
            diffs.push(`  line ${i + 1}:\n    expected: ${(eLines[i] ?? '(missing)').slice(0, 120)}\n    actual:   ${(pLines[i] ?? '(missing)').slice(0, 120)}`);
            if (diffs.length >= 5) { diffs.push('  ... (more diffs truncated)'); break; }
          }
        }
        assert.fail(`Prompt snapshot "${name}" changed. Run with UPDATE_SNAPSHOTS=1 to accept.\n\nDiffs:\n${diffs.join('\n')}`);
      }
    });
  }
});

// ── Targeted assertions ──────────────────────────────────────────────────────
// Snapshots catch *whether* the prompt changed; these assertions catch
// *what specifically* the rendering contract is. Update the snapshots freely
// while keeping these guarantees stable.

const HANGUL_RE = /[\u{AC00}-\u{D7AF}]/u;

function extractSection(prompt: string, open: string, close: string): string | null {
  const start = prompt.indexOf(open);
  const end = prompt.indexOf(close);
  if (start === -1 || end === -1 || end < start) return null;
  return prompt.slice(start, end + close.length);
}

describe('PromptBuilder — <recipients> surface split', () => {
  const MULTI = buildScenario('targeted-recipients', {
    agents: EXTRA_AGENTS, users: EXTRA_USERS,
    agreements: [BASE_AGREEMENT, MULTI_PARTY_AGREEMENT],
  });
  const recipients = extractSection(MULTI, '<recipients>', '</recipients>');

  it('emits all subsections in order', () => {
    assert.ok(recipients, 'no <recipients> block');
    const expected = ['<users>', '</users>', '<agents>', '</agents>', '<chat>', '</chat>', '<agreement>', '</agreement>', '<task>', '</task>', '<transfer>', '</transfer>'];
    let cursor = 0;
    for (const tag of expected) {
      const idx = recipients!.indexOf(tag, cursor);
      assert.ok(idx >= 0, `missing "${tag}" after offset ${cursor}`);
      cursor = idx + tag.length;
    }
  });

  it('classifies humans under <users> and agents under <agents>', () => {
    const users = extractSection(MULTI, '<users>', '</users>')!;
    const agents = extractSection(MULTI, '<agents>', '</agents>')!;
    assert.match(users, /user-001/);
    assert.match(users, /user-002/);
    assert.doesNotMatch(users, /agent-002/);
    assert.match(agents, /agent-002/);
    assert.match(agents, /agent-003/);
    assert.doesNotMatch(agents, /user-001/);
  });

  it('omits the self agent id from every recipient subsection', () => {
    // agent-001 is `isYou` in the fixture.
    assert.doesNotMatch(recipients!, /agent-001/);
  });

  it('tags chat entries with [user] or [agent]', () => {
    const chat = extractSection(MULTI, '<chat>', '</chat>')!;
    assert.match(chat, /user-001\)\s*\[user\]/);
    assert.match(chat, /agent-002\).*\[agent\]/);
  });

  it('tags <agreement> entries with agreementId:role', () => {
    const ag = extractSection(MULTI, '<agreement>', '</agreement>')!;
    // user-001 is creator+payer on ag-100; user-002 is proposedTo on ag-300.
    assert.match(ag, /user-001[^\n]*ag-100:creator/);
    assert.match(ag, /user-002[^\n]*ag-300:proposedTo/);
    assert.match(ag, /agent-003[^\n]*ag-300:provider/);
  });

  it('falls back to a placeholder when no agreement parties exist', () => {
    const prompt = buildScenario('no-agreements', { agreements: [] });
    const ag = extractSection(prompt, '<agreement>', '</agreement>')!;
    const task = extractSection(prompt, '<task>', '</task>')!;
    assert.match(ag, /\(no agreement parties/);
    assert.match(task, /\(no task parties/);
  });

  it('lists every counterparty under <transfer>', () => {
    const transfer = extractSection(MULTI, '<transfer>', '</transfer>')!;
    for (const id of ['user-001', 'user-002', 'agent-002', 'agent-003']) {
      assert.ok(transfer.includes(id), `<transfer> missing ${id}`);
    }
  });

  // ZIG-1137 — opaque presentation refs stay on <chat> for echo-reply, never on <transfer>.
  it('keeps opaque refs on <chat> and out of <transfer>', () => {
    const prompt = buildScenario('opaque-recipients', {
      users: [
        { userId: 'user-001', userName: 'Alice' },
        { userId: 'rpb_masked_user', userName: 'Masked' },
      ],
      agents: [{ agentId: 'psn_masked_agent', name: 'Face', description: 'masked' }],
      agreements: [],
    });
    const chat = extractSection(prompt, '<chat>', '</chat>')!;
    const transfer = extractSection(prompt, '<transfer>', '</transfer>')!;
    assert.match(chat, /rpb_masked_user/);
    assert.match(chat, /psn_masked_agent/);
    assert.doesNotMatch(transfer, /rpb_masked_user/);
    assert.doesNotMatch(transfer, /psn_masked_agent/);
    assert.match(transfer, /user-001/);
  });
});

describe('PromptBuilder — <agreements> block', () => {
  it('shows real party ids and proposal status when data is populated', () => {
    const prompt = buildScenario('agreements-populated', { agreements: [BASE_AGREEMENT, PENDING_AGREEMENT] });
    const block = extractSection(prompt, '<agreements>', '</agreements>')!;
    assert.match(block, /Agreement ag-100/);
    assert.match(block, /Agreement ag-200/);
    assert.doesNotMatch(block, /Creator: N\/A/);
    assert.doesNotMatch(block, /\[UNKNOWN\]/);
    assert.match(block, /Proposal: pending/);
    assert.match(block, /Proposal: approved/);
  });
});

describe('PromptBuilder — subtask results surface', () => {
  it('renders pendingSubtasks in machine_context and all collected results, oldest first', () => {
    const prompt = buildScenario('subtasks', {
      ctx: makeCtx({
        activeTaskId: 'parent',
        activeAgreementId: 'ag-100',
        tasks: {
          parent: {
            agreementId: 'ag-100',
            pendingSubtasks: { t9: { agentId: 'spec-1', spawnedAt: 1 } },
            collectedResults: [
              { taskId: 't1', agentId: 'spec-1', status: 'completed', result: 'r1' },
              { taskId: 't2', agentId: 'spec-2', status: 'failed', result: null },
            ],
            delegatedAgreementIds: [],
          },
        },
      }),
    });
    const machine = extractSection(prompt, '<machine_context>', '</machine_context>')!;
    assert.match(machine, /pendingSubtasks/);
    const results = extractSection(prompt, '<subtask_results>', '</subtask_results>')!;
    assert.match(results, /taskId=t1 agent=spec-1 status=completed/);
    assert.match(results, /result: r1/);
    assert.match(results, /taskId=t2 agent=spec-2 status=failed/);
    // oldest first: t1 must appear before t2
    assert.ok(results.indexOf('taskId=t1') < results.indexOf('taskId=t2'));
  });
});

describe('PromptBuilder — history token budget (ZIG-769)', () => {
  function bigHistory(n: number, padChars: number): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, i) => ({
      entryType: 'message',
      timestamp: `2026-05-06T10:${String(i % 60).padStart(2, '0')}:00Z`,
      sender: { id: 'user-001', type: 'user' },
      receiver: { id: 'agent-001', type: 'agent' },
      text: `msg ${i} ` + 'x'.repeat(padChars),
    }));
  }

  function buildWith(history: Record<string, unknown>[], opts: Record<string, unknown>): string {
    const builder = new PromptBuilder({ description: 'budget test', ...opts });
    return builder.buildFromState({
      statePrompt: STATE_PROMPT,
      actions: ACTIONS,
      serverContext: {
        context: { agents: AGENTS as Record<string, unknown>[], users: USERS as Record<string, unknown>[], agreements: [], history },
        tools: [],
      },
      incomingEvent: { type: 'message', text: 'Hello!', senderId: 'user-001', senderType: 'user' },
      definition: { description: 'budget test' },
      chatId: 'chat-budget',
      stateId: 'idle',
      ctx: makeCtx(),
    });
  }

  it('drops oldest entries to fit the token budget and keeps the newest', () => {
    const prompt = buildWith(bigHistory(20, 400), { maxHistoryTokens: 500 });
    const h = extractSection(prompt, '<history>', '</history>')!;
    assert.match(h, /older turns dropped to fit the context budget/);
    assert.match(h, /msg 19\b/);          // newest kept
    assert.doesNotMatch(h, /msg 0\b/);    // oldest dropped
  });

  it('keeps the newest entry even when it alone exceeds the budget', () => {
    const prompt = buildWith(bigHistory(3, 5000), { maxHistoryTokens: 1 });
    const h = extractSection(prompt, '<history>', '</history>')!;
    assert.match(h, /msg 2\b/);
  });

  it('does not truncate when history fits the budget', () => {
    const prompt = buildWith(bigHistory(3, 20), {});
    const h = extractSection(prompt, '<history>', '</history>')!;
    assert.doesNotMatch(h, /context budget/);
  });

  it('still enforces the entry-count ceiling', () => {
    const prompt = buildWith(bigHistory(60, 5), { maxHistoryTokens: 1_000_000 });
    const h = extractSection(prompt, '<history>', '</history>')!;
    assert.match(h, /Showing last 50 of 60 entries/);
  });
});

describe('PromptBuilder — language hygiene', () => {
  it('does not leak Hangul characters from any rendered scenario', () => {
    for (const [name, overrides] of Object.entries(SCENARIOS)) {
      const prompt = buildScenario(name, overrides);
      assert.ok(!HANGUL_RE.test(prompt), `scenario "${name}" leaked Hangul characters`);
    }
  });
});
