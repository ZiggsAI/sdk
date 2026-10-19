import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defineTool } from '../src/tools/defineTool.js';

describe('defineTool', () => {
  it('requires name and handler', () => {
    assert.throws(() => defineTool('', {}, async () => {}), /name is required/);
    assert.throws(() => defineTool('n', {}, null as unknown as () => Promise<unknown>), /handler function is required/);
  });

  it('builds JSON schema from shorthand', async () => {
    const tool = defineTool(
      'demo',
      {
        q: { type: 'string', required: true },
        n: 'number',
        tags: ['string'],
      },
      async (args) => args
    );
    assert.equal(tool.schema.type, 'function');
    assert.equal(tool.schema.function.name, 'demo');
    const params = tool.schema.function.parameters as Record<string, unknown>;
    assert.equal((params as Record<string, unknown>).type, 'object');
    assert.deepEqual((params as Record<string, unknown>).required, ['q']);
    const props = (params as Record<string, Record<string, { type: string }>>).properties;
    assert.equal(props.q.type, 'string');
    assert.equal(props.n.type, 'number');
    assert.equal(props.tags.type, 'array');
  });

  it('supports echoUserSummaryOnSuccess option', () => {
    const tool = defineTool('t', { x: 'string' }, async () => ({}), { echoUserSummaryOnSuccess: true });
    assert.equal(tool.echoUserSummaryOnSuccess, true);
  });

  it('includes description in schema when provided in options', () => {
    const tool = defineTool('t', { x: 'string' }, async () => ({}), { description: 'Do something useful.' });
    assert.equal(tool.schema.function.description, 'Do something useful.');
  });

  it('omits description from schema when not provided', () => {
    const tool = defineTool('t', { x: 'string' }, async () => ({}));
    assert.equal(tool.schema.function.description, undefined);
  });

  it('runs handler', async () => {
    const tool = defineTool('add', { a: 'number', b: 'number' }, async ({ a, b }) => (a as number) + (b as number));
    const sum = await tool.handler({ a: 2, b: 3 }, {});
    assert.equal(sum, 5);
  });
});
