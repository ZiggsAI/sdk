import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { extractJSON, safeParseJSON } from '../src/utils/jsonExtractor.js';

describe('extractJSON', () => {
  it('extracts fenced json block', () => {
    const s = 'intro\n```json\n{"a":1}\n```\ntrailer';
    assert.equal(extractJSON(s), '{"a":1}');
  });

  it('extracts first object from noisy text', () => {
    const s = 'prefix {"x": true} suffix';
    assert.equal(extractJSON(s), '{"x": true}');
  });

  it('strips trailing commas', () => {
    const s = '{"a":1,}';
    assert.equal(extractJSON(s), '{"a":1}');
  });

  it('returns trimmed plain string when no brace', () => {
    assert.equal(extractJSON('  hello  '), 'hello');
  });
});

describe('safeParseJSON', () => {
  let origError: typeof console.error;
  before(() => {
    origError = console.error;
    console.error = () => {};
  });
  after(() => {
    console.error = origError;
  });

  it('parses valid json', () => {
    assert.deepEqual(safeParseJSON('{"k":"v"}'), { k: 'v' });
  });

  it('returns fallback on empty', () => {
    assert.equal(safeParseJSON('', 'fb'), 'fb');
    assert.equal(safeParseJSON('   ', 'fb'), 'fb');
  });

  it('repairs raw newlines inside JSON strings', () => {
    const raw = `{"msg":"hello
world"}`;
    const parsed = safeParseJSON(raw, null);
    assert.deepEqual(parsed, { msg: 'hello\nworld' });
  });

  it('returns fallback on hard failure', () => {
    const out = safeParseJSON('not json at all {', 'fb');
    assert.equal(out, 'fb');
  });
});
