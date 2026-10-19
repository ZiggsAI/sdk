import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_TOOL_NAMES,
  PROTOCOL_TOOL_TO_OPERATION,
  mapProtocolToolToOperation,
  isProtocolToolName,
  requireProtocolOperation,
} from '../src/tasks/protocolRegistry.js';
import { PROTOCOL_TOOLS } from '../src/platform/tools/tier1/protocolTools.js';

describe('protocolRegistry', () => {
  it('maps known tools', () => {
    assert.equal(
      mapProtocolToolToOperation('agreement_propose'),
      'agreement-propose',
    );
    assert.equal(
      mapProtocolToolToOperation('task_set_result'),
      'task-update',
    );
    assert.equal(
      mapProtocolToolToOperation('agreement_respond'),
      'agreement-respond',
    );
    // ZIG-132 — counter / check tools.
    assert.equal(
      mapProtocolToolToOperation('agreement_counter'),
      'agreement-counter-proposal',
    );
    assert.equal(
      mapProtocolToolToOperation('agreement_get'),
      'agreement-check-proposal',
    );
    assert.equal(mapProtocolToolToOperation('unknown'), null);
  });

  it('isProtocolToolName', () => {
    assert.equal(isProtocolToolName('agreement_propose'), true);
    assert.equal(isProtocolToolName('task_set_result'), true);
    assert.equal(isProtocolToolName('agreement_counter'), true);
    assert.equal(isProtocolToolName('agreement_get'), true);
    assert.equal(isProtocolToolName('other'), false);
  });

  it('PROTOCOL_TOOL_NAMES is non-empty', () => {
    assert.ok(PROTOCOL_TOOL_NAMES.length > 0);
  });
});

/**
 * ZIG-1110: the set of protocol verbs was written down twice — once as the tool
 * definitions and once as this table — and drifted. `agreement_fulfill` was
 * defined and dispatched but absent from the table, so `isProtocolToolName`
 * returned false and the verb that permanently ends an engagement degraded to
 * an ordinary tool call at all four consumers (applyEffects, routingLabels,
 * buildOutcome ×2) — its result never reached context.
 *
 * These hold the two sets equal in BOTH directions. A one-way check is what let
 * it ship: a tool defined with no table entry was the exact failure, and an
 * entry with no tool is a verb the model is told about and cannot call.
 */
describe('protocol registry ↔ protocol tools', () => {
  const definedToolNames = (): string[] =>
    PROTOCOL_TOOLS.map(
      (t) => (t.schema.function as { name: string }).name,
    ).sort();

  it('every defined tool has a registry entry', () => {
    for (const name of definedToolNames()) {
      assert.ok(
        isProtocolToolName(name),
        `${name} is a defined protocol tool but missing from PROTOCOL_TOOL_TO_OPERATION — its result would never reach context`,
      );
    }
  });

  it('every registry entry has a defined tool', () => {
    const defined = new Set(definedToolNames());
    for (const name of PROTOCOL_TOOL_NAMES) {
      assert.ok(
        defined.has(name),
        `${name} is in the registry but no tool defines it`,
      );
    }
  });

  it('the two sets are exactly equal', () => {
    assert.deepEqual(definedToolNames(), [...PROTOCOL_TOOL_NAMES].sort());
  });

  it('agreement_fulfill is protocol — the verb that ends an engagement', () => {
    assert.equal(isProtocolToolName('agreement_fulfill'), true);
    assert.equal(
      mapProtocolToolToOperation('agreement_fulfill'),
      'agreement-fulfill',
    );
  });

  it('every operation is distinct — two verbs cannot share one state effect', () => {
    const ops = Object.values(PROTOCOL_TOOL_TO_OPERATION);
    assert.equal(new Set(ops).size, ops.length);
  });

  it('requireProtocolOperation names the table to edit rather than failing quietly', () => {
    assert.throws(
      () => requireProtocolOperation('agreement_invent'),
      /agreement_invent.*PROTOCOL_TOOL_TO_OPERATION/s,
    );
  });
});
