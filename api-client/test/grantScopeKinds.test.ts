import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_GRANT_SCOPE_KINDS,
  GRANT_SCOPE_KINDS,
} from '../src/http/grants.js';

describe('grant scope kinds (ZIG-1557)', () => {
  it('names every rail the server GET /grants?scopeKind= accepts', () => {
    assert.deepEqual([...GRANT_SCOPE_KINDS], [
      'chat',
      'agreement',
      'org',
      'artifact',
      'task',
      'connection',
      'wallet',
      'consent',
      'inbox',
    ]);
    assert.deepEqual([...CONTEXT_GRANT_SCOPE_KINDS], [
      'chat',
      'agreement',
      'org',
      'artifact',
      'task',
    ]);
  });
});
