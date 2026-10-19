import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requestExactMatch } from '../src/platform/requestMatch.js';

describe('requestExactMatch (ZIG-1185)', () => {
  it('hits on exact tag', () => {
    assert.equal(requestExactMatch('email', ['email', 'calendar']), true);
  });

  it('misses on substring / case drift', () => {
    assert.equal(requestExactMatch('email', ['Email']), false);
    assert.equal(requestExactMatch('mail', ['email']), false);
  });

  it('empty match never hits (token-safe)', () => {
    assert.equal(requestExactMatch('', ['email']), false);
    assert.equal(requestExactMatch('   ', ['email']), false);
  });

  it('trims both sides', () => {
    assert.equal(requestExactMatch(' email ', ['email']), true);
  });
});
