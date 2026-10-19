import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mcpToolBudget, trimDescription, MAX_TOOL_DESC_CHARS } from '../src/mcp/createMcpAgent.js';

/**
 * ZIG-759: MCP servers can expose more tools than the LLM provider's `tools`
 * array cap (OpenAI: 128), which 400s the whole turn. mcpToolBudget decides how
 * many MCP tools may be bound, leaving headroom for control + extra tools.
 */
describe('mcpToolBudget', () => {
  it('reserves headroom under the provider cap', () => {
    // 128 cap, no extra tools → 128 - 4 (control reserve) = 124
    assert.equal(mcpToolBudget(128, 0), 124);
  });

  it('subtracts extra (non-MCP) tools from the budget', () => {
    assert.equal(mcpToolBudget(128, 10), 114);
  });

  it('never drops below 1, even when extras exceed the cap', () => {
    assert.equal(mcpToolBudget(128, 500), 1);
    assert.equal(mcpToolBudget(10, 20), 1);
  });

  it('scales with a custom provider cap', () => {
    assert.equal(mcpToolBudget(200, 0), 196);
  });

  it('PostHog case: 146 tools over a 124 budget means truncation', () => {
    const budget = mcpToolBudget(128, 0);
    assert.ok(146 > budget, 'a 146-tool server must be truncated');
    assert.ok(budget < 128, 'bound set stays under the provider cap');
  });
});

/**
 * ZIG-759: verbose MCP servers embed whole manuals in tool descriptions
 * (PostHog's `execute-sql` is ~30K chars). trimDescription bounds each one so
 * the schema does not ship a manual every turn.
 */
describe('trimDescription', () => {
  it('leaves short descriptions untouched', () => {
    assert.equal(trimDescription('Fetch all feature flags.'), 'Fetch all feature flags.');
    assert.equal(trimDescription(undefined), undefined);
    assert.equal(trimDescription(''), '');
  });

  it('truncates an oversized description below the cap + marker', () => {
    const huge = 'A'.repeat(30_000);
    const out = trimDescription(huge)!;
    assert.ok(out.length < huge.length, 'must shrink');
    assert.ok(out.length <= MAX_TOOL_DESC_CHARS + 100, 'stays near the cap');
    assert.match(out, /truncated/, 'flags the truncation');
  });

  it('prefers a sentence/newline boundary near the cap', () => {
    const body = 'First sentence. '.repeat(200); // ~3200 chars of sentences
    const out = trimDescription(body)!;
    // kept head ends at a sentence boundary (before the marker)
    const head = out.replace(/ \[…description truncated;.*$/, '');
    assert.ok(head.endsWith('.'), 'cut on a sentence boundary');
    assert.ok(head.length <= MAX_TOOL_DESC_CHARS);
  });
});
