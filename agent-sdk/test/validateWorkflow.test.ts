import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow, WorkflowValidationError } from '../src/runtime/validateWorkflow.js';
import { thinkingDefaults } from '../src/runtime/defaults.js';
import type { Workflow } from '../src/types.js';

const validThinking = (initial = 'idle'): Workflow['states'][string] => {
  const dflt = thinkingDefaults({ initial });
  return {
    kind: 'thinking',
    prompt: { role: 'r' },
    actions: { ...dflt.actions, doThing: { prompt: { instruction: 'i' }, produces: 'message-sent' } },
    transitions: [...dflt.transitions],
  };
};

describe('validateWorkflow', () => {
  it('accepts a valid workflow', () => {
    const w: Workflow = {
      id: 'a', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 'thinking' }] },
        thinking: validThinking('idle'),
      },
    };
    const { errors, warnings } = validateWorkflow(w);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
  });

  it('throws on missing initial state', () => {
    const w = { id: 'a', description: 'd', initial: 'nope', states: { idle: { kind: 'parked', transitions: [] } } } as Workflow;
    assert.throws(() => validateWorkflow(w), WorkflowValidationError);
  });

  it('throws on transition pointing to unknown state', () => {
    const w: Workflow = {
      id: 'a', description: 'd', initial: 'idle',
      states: { idle: { kind: 'parked', transitions: [{ to: 'ghost' }] } },
    };
    assert.throws(() => validateWorkflow(w), WorkflowValidationError);
  });

  it('throws when state kind is missing', () => {
    const w = { id: 'a', description: 'd', initial: 'idle', states: { idle: { transitions: [] } } } as unknown as Workflow;
    assert.throws(() => validateWorkflow(w), WorkflowValidationError);
  });

  it('throws when parked state has prompt', () => {
    const w = { id: 'a', description: 'd', initial: 'idle', states: { idle: { kind: 'parked', prompt: {}, transitions: [] } } } as unknown as Workflow;
    assert.throws(() => validateWorkflow(w), WorkflowValidationError);
  });

  it('throws when action.produces is unknown', () => {
    const w = {
      id: 'a', description: 'd', initial: 'idle',
      states: { idle: { kind: 'thinking', prompt: {}, actions: { x: { prompt: { instruction: 'i' }, produces: 'bogus' } }, transitions: [], allowNoWait: true } },
    } as unknown as Workflow;
    assert.throws(() => validateWorkflow(w), WorkflowValidationError);
  });

  it('warns when thinking state has no wait fallthrough', () => {
    const w: Workflow = {
      id: 'a', description: 'd', initial: 'idle',
      states: {
        idle: {
          kind: 'thinking',
          prompt: {},
          actions: { greet: { prompt: { instruction: 'i' }, produces: 'message-sent' } },
          transitions: [{ to: 'idle', when: o => o.kind === 'message-sent' }],
        },
      },
    };
    const { warnings } = validateWorkflow(w);
    assert.ok(warnings.some(w => w.includes('wait')));
  });

  it('warns when thinking state has no error fallthrough (ZIG-303)', () => {
    const w: Workflow = {
      id: 'a', description: 'd', initial: 'idle',
      states: {
        idle: {
          kind: 'thinking',
          prompt: {},
          actions: {
            wait: { prompt: { instruction: 'i' }, produces: 'wait' },
            greet: { prompt: { instruction: 'i' }, produces: 'message-sent' },
          },
          transitions: [
            { to: 'idle', when: o => o.kind === 'message-sent' },
            { to: 'idle', when: o => o.kind === 'wait' },
          ],
        },
      },
    };
    const { warnings } = validateWorkflow(w);
    assert.ok(warnings.some(w => w.includes('error')));
  });

  it('does not warn when allowNoWait is set', () => {
    const w: Workflow = {
      id: 'a', description: 'd', initial: 'idle',
      states: {
        idle: {
          kind: 'thinking',
          prompt: {},
          actions: { greet: { prompt: { instruction: 'i' }, produces: 'message-sent' } },
          transitions: [{ to: 'idle' }],
          allowNoWait: true,
        },
      },
    };
    const { warnings } = validateWorkflow(w);
    assert.equal(warnings.length, 0);
  });

  it('errors when a thinking state declares timeoutMs', () => {
    const w = {
      id: 'a', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 't' }] },
        t: { ...validThinking('idle'), timeoutMs: 5000 },
      },
    } as unknown as Workflow;
    assert.throws(() => validateWorkflow(w), /parked states only/);
  });

  it('errors on non-positive/non-numeric parked timeoutMs', () => {
    for (const bad of [0, -5, NaN, '5000']) {
      const w = {
        id: 'a', description: 'd', initial: 'idle',
        states: { idle: { kind: 'parked', timeoutMs: bad, transitions: [{ to: 'idle', when: (o: any) => o.kind === 'state-timeout' }] } },
      } as unknown as Workflow;
      assert.throws(() => validateWorkflow(w), /finite number > 0/, `expected error for timeoutMs=${String(bad)}`);
    }
  });

  it('warns when a timed parked state has no state-timeout transition', () => {
    const w: Workflow = {
      id: 'a', description: 'd', initial: 'idle',
      states: { idle: { kind: 'parked', timeoutMs: 5000, transitions: [{ to: 'idle', when: o => o.kind === 'message-received' }] } },
    };
    const { warnings } = validateWorkflow(w);
    assert.ok(warnings.some(x => x.includes('park loudly')));
  });

  it('no warning when a timed parked state handles state-timeout', () => {
    const w: Workflow = {
      id: 'a', description: 'd', initial: 'idle',
      states: { idle: { kind: 'parked', timeoutMs: 5000, transitions: [{ to: 'idle', when: o => o.kind === 'state-timeout' }] } },
    };
    const { warnings } = validateWorkflow(w);
    assert.ok(!warnings.some(x => x.includes('park loudly')));
  });

  it('errors when an action produces the reserved state-timeout kind', () => {
    const w = {
      id: 'a', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 't' }] },
        t: { kind: 'thinking', prompt: {}, allowNoWait: true, actions: { bad: { prompt: { instruction: 'i' }, produces: 'state-timeout' } }, transitions: [{ to: 'idle' }] },
      },
    } as unknown as Workflow;
    assert.throws(() => validateWorkflow(w), /reserved for runtime/);
  });

  it('errors on the retired timeout outcome kind', () => {
    const w = {
      id: 'a', description: 'd', initial: 'idle',
      states: {
        idle: { kind: 'parked', transitions: [{ to: 't' }] },
        t: { kind: 'thinking', prompt: {}, allowNoWait: true, actions: { bad: { prompt: { instruction: 'i' }, produces: 'timeout' } }, transitions: [{ to: 'idle' }] },
      },
    } as unknown as Workflow;
    assert.throws(() => validateWorkflow(w), /unknown outcome kind "timeout"/);
  });
});
