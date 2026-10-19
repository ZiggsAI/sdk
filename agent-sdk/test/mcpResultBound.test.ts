import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundMcpResult,
  MAX_MCP_RESULT_CHARS,
} from '../src/platform/tools/tier2/mcpConnectionTools.js';

/**
 * A remote MCP server returns the upstream API's payload verbatim, and those are
 * sized for programs: GitHub's `list_pull_requests` with no paging argument
 * answered ~150,000 characters, which the runtime spilled to a file that a hosted
 * agent has no tool to read. The wake ended in "the answer was too big and I
 * cannot see it" — worse than a cut answer, because there is nothing to act on.
 */
describe('boundMcpResult', () => {
  const text = (t: string) => ({ content: [{ type: 'text', text: t }] });

  it('leaves a result that fits completely alone', () => {
    const small = text('two pull requests');
    const bounded = boundMcpResult(small);
    assert.deepEqual(bounded.result, small);
    assert.equal(bounded.truncated, undefined);
  });

  it('cuts an oversized text block and says how big it really was', () => {
    const bounded = boundMcpResult(text('x'.repeat(150_000)), 1_000);
    const kept = (bounded.result as { content: Array<{ text: string }> }).content[0].text;
    assert.ok(kept.startsWith('x'.repeat(1_000)));
    assert.match(kept, /cut here: this block was 150000 characters/);
    assert.equal(bounded.truncated?.originalChars, JSON.stringify(text('x'.repeat(150_000))).length);
    // The note has to stop the model reporting a prefix as the whole answer.
    assert.match(String(bounded.truncated?.note), /do not report it as complete/);
    assert.match(String(bounded.truncated?.note), /paging/);
  });

  it('keeps whole blocks while there is room and drops the rest, counted', () => {
    const bounded = boundMcpResult(
      { content: [
        { type: 'text', text: 'a'.repeat(400) },
        { type: 'text', text: 'b'.repeat(400) },
        { type: 'text', text: 'c'.repeat(400) },
      ] },
      800,
    );
    const kept = (bounded.result as { content: Array<{ text: string }> }).content;
    assert.equal(kept.length, 2);
    assert.equal(kept[0].text, 'a'.repeat(400));
    assert.equal(kept[1].text, 'b'.repeat(400));
    assert.equal(bounded.truncated?.droppedBlocks, 1);
  });

  it('never returns sliced JSON for a shape it does not recognise', () => {
    const bounded = boundMcpResult({ rows: Array.from({ length: 500 }, (_, i) => ({ i })) }, 200);
    const out = bounded.result as { text: string };
    assert.equal(typeof out.text, 'string');
    assert.equal(out.text.length, 200);
    assert.doesNotThrow(() => JSON.stringify(bounded.result));
  });

  it('the default limit leaves room for a real answer without carrying a database', () => {
    assert.ok(MAX_MCP_RESULT_CHARS >= 8_000, 'too small to answer with');
    assert.ok(MAX_MCP_RESULT_CHARS <= 60_000, 'large enough to swallow a wake');
  });
});
