import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicTools } from '../src/adapters/AnthropicAdapter.js';
import { defineTool } from '../src/tools/defineTool.js';

describe('toAnthropicTools', () => {
  it('returns undefined for an empty tool list', () => {
    assert.equal(toAnthropicTools([]), undefined);
    assert.equal(toAnthropicTools(), undefined);
  });

  it('maps the runtime ToolDefinition shape ({ schema: { function } }) without crashing', () => {
    // This is exactly what runTurn passes (laundered `as unknown as LlmToolSchema[]`).
    // Reading `t.function.name` on this shape threw "Cannot read properties of
    // undefined (reading 'name')" and killed every claude-backed agent with tools.
    const tool = defineTool(
      'order_coffee',
      { size: { type: 'string', required: true }, milk: 'string' },
      async () => ({ ok: true }),
      { description: 'Place a coffee order' },
    );

    const out = toAnthropicTools([tool] as never);
    assert.ok(out);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'order_coffee');
    assert.equal(out[0].description, 'Place a coffee order');
    assert.equal((out[0].input_schema as { type?: string }).type, 'object');
    assert.deepEqual(
      Object.keys((out[0].input_schema as { properties?: Record<string, unknown> }).properties ?? {}),
      ['size', 'milk'],
    );
  });

  it('also accepts the raw wire shape ({ type, function })', () => {
    const wire = {
      type: 'function' as const,
      function: { name: 'ping', description: 'ping', parameters: { type: 'object' } },
    };
    const out = toAnthropicTools([wire]);
    assert.ok(out);
    assert.equal(out[0].name, 'ping');
    assert.equal(out[0].description, 'ping');
  });

  it('falls back to an empty object schema when parameters are absent', () => {
    const wire = { type: 'function' as const, function: { name: 'noargs' } };
    const out = toAnthropicTools([wire]);
    assert.ok(out);
    assert.deepEqual(out[0].input_schema, { type: 'object' });
    assert.equal(out[0].description, '');
  });
});
