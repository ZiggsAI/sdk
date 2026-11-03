import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTaskInputs } from '../src/runtime/runTurn.js';
import { PromptBuilder } from '../src/runtime/PromptBuilder.js';
import { readScopesForWake } from '../src/Agent.js';
import type { ContextSnapshot, Effect } from '../src/types.js';

const snapshot = (items: unknown[]): ContextSnapshot => ({
  history: [], agreements: [], agents: [], users: [],
  work: { agreementId: 'hire', task: { taskId: 'collect' } },
  artifacts: { items },
} as unknown as ContextSnapshot);

describe('readTaskInputs', () => {
  it('opens only the task input artifacts, as this task\'s trigger artifact', async () => {
    const reads: unknown[] = [];
    const eff = async (effect: Effect) => {
      reads.push(effect);
      const scope = (effect as { opts: { workScopes: Array<{ artifactId: string }> } }).opts.workScopes[0];
      return { work: { triggerArtifact: { name: 'Instructions', text: `body of ${scope.artifactId}`, truncated: false } } };
    };
    const inputs = await readTaskInputs(snapshot([
      { artifactId: 'brief', linkRole: 'input' },
      { artifactId: 'earlier-result', linkRole: 'result' },
    ]), 'lane', eff);
    assert.deepEqual(inputs, [{ artifactId: 'brief', name: 'Instructions', text: 'body of brief', truncated: false }]);
    assert.deepEqual(reads, [{
      kind: 'read-context', sessionId: 'lane',
      opts: { workScopes: [{ taskId: 'collect', agreementId: 'hire', artifactId: 'brief' }] },
    }]);
  });

  it('leaves out an input it may not read instead of guessing', async () => {
    const eff = async () => ({ unavailable: true, work: {} });
    assert.deepEqual(await readTaskInputs(snapshot([{ artifactId: 'brief', linkRole: 'input' }]), 'lane', eff), []);
  });

  it('reads nothing outside task work', async () => {
    const eff = async () => assert.fail('no read without a task');
    const ctx = { history: [], agreements: [], agents: [], users: [], artifacts: { items: [{ artifactId: 'brief', linkRole: 'input' }] } } as unknown as ContextSnapshot;
    assert.deepEqual(await readTaskInputs(ctx, 'lane', eff), []);
  });
});

describe('PromptBuilder task inputs', () => {
  it('puts the input bodies in the prompt', () => {
    const prompt = new PromptBuilder({ description: 'worker' }).buildFromState({
      statePrompt: { role: 'r', goal: 'g', constraints: 'c' },
      actions: {},
      serverContext: {
        context: {
          history: [], agreements: [], agents: [], users: [],
          work: { task: { taskId: 'collect' } },
          taskInputs: [{ artifactId: 'brief', name: 'Instructions', text: 'Search five sites.', truncated: false }],
        } as Record<string, unknown>,
        tools: [],
      },
      incomingEvent: null,
      definition: { description: 'worker' },
      addressId: 'lane',
      stateId: 'workingAssignedTask',
      ctx: undefined as never,
    });
    assert.match(prompt, /<task-inputs[^>]*>\n<artifact id="brief" name="Instructions">\nSearch five sites\.\n<\/artifact>\n<\/task-inputs>/);
  });
});

describe('readScopesForWake', () => {
  const wake = [{ agreementId: 'hire', taskId: 'collect' }];
  it('lets a read narrow to one artifact of the same task', () => {
    assert.deepEqual(readScopesForWake([{ taskId: 'collect', agreementId: 'hire', artifactId: 'brief' }], wake),
      [{ agreementId: 'hire', taskId: 'collect', artifactId: 'brief' }]);
  });
  it('keeps the wake scope for any other work', () => {
    assert.deepEqual(readScopesForWake([{ taskId: 'other', artifactId: 'brief' }], wake), wake);
    assert.deepEqual(readScopesForWake([{ taskId: 'collect', agreementId: 'elsewhere', artifactId: 'brief' }], wake), wake);
    assert.deepEqual(readScopesForWake([{ taskId: 'collect', agreementId: 'hire' }], wake), wake);
    assert.deepEqual(readScopesForWake(undefined, wake), wake);
  });
});
