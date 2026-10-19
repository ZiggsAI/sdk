import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactScopeForSession,
  AGREEMENT_LANE_PREFIX,
} from '../src/http/ArtifactsClient.js';

/**
 * ZIG-1032 — a task with no origin chat runs on the lane `agrn-<agreementId>`.
 * That is a routing key, not a chat: passing it as `chatId` asked the backend to
 * write into a chat that does not exist, so every breadcrumb and recorded
 * thought on an agreement lane came back 403 "not authorized for this scope".
 */

test('an agreement lane scopes to the agreement, not a chat', () => {
  const scope = artifactScopeForSession('agrn-agr_1785203433677_7sjw92qs');
  assert.deepEqual(scope, { agreementId: 'agr_1785203433677_7sjw92qs' });
  assert.ok(!('chatId' in scope));
});

test('a real chat id stays a chat scope', () => {
  assert.deepEqual(artifactScopeForSession('wbtelidxg'), { chatId: 'wbtelidxg' });
});

test('a bare agreement id is NOT treated as a lane — it has no prefix', () => {
  // Only the lane form carries the prefix; a bare id arriving here would be a
  // caller mistake, and silently reinterpreting it would hide that.
  assert.deepEqual(artifactScopeForSession('agr_123'), { chatId: 'agr_123' });
});

test('the prefix is the one the lane resolver mints', () => {
  assert.equal(AGREEMENT_LANE_PREFIX, 'agrn-');
});
