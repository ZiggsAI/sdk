import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow } from '../src/runtime/validateWorkflow.js';

describe('validateWorkflow mechanical states (ZIG-764)', () => {
  it('accepts mechanical state with tool and produces', () => {
    const result = validateWorkflow({
      id: 'mech',
      description: 'd',
      initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'run', when: () => true }] },
        run: {
          kind: 'mechanical',
          tool: 'relay_execute',
          produces: 'task-closed',
          transitions: [{ to: 'idle', when: () => true }],
        },
      },
    });
    assert.equal(result.errors.length, 0);
  });

  it('rejects mechanical state without tool', () => {
    assert.throws(() =>
      validateWorkflow({
        id: 'bad',
        description: 'd',
        initial: 'idle',
        states: {
          idle: { kind: 'parked', transitions: [] },
          run: {
            kind: 'mechanical',
            tool: '',
            produces: 'task-closed',
            transitions: [{ to: 'idle' }],
          },
        },
      }),
    );
  });

  // ZIG-2058 — tool states get the error-route warning thinking states get.
  it('warns a mechanical state with no error transition, not one with a catch-all', () => {
    const wf = (when: (o: { kind: string }) => boolean) =>
      validateWorkflow({
        id: 'mech',
        description: 'd',
        initial: 'idle',
        states: {
          idle: { kind: 'parked', transitions: [{ to: 'run', when: () => true }] },
          run: {
            kind: 'mechanical',
            tool: 'relay_execute',
            produces: 'task-closed',
            transitions: [{ to: 'idle', when }],
          },
        },
      });
    const narrow = wf((o) => o.kind === 'task-closed');
    assert.ok(narrow.warnings.some((w) => w.includes('mechanical state "run" has no transition')));
    const wide = wf(() => true);
    assert.ok(!wide.warnings.some((w) => w.includes('mechanical state "run"')));
  });
});
