import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactScope,
  AGREEMENT_LANE_PREFIX,
} from '../src/http/ArtifactsClient.js';
import { withWorkExecution } from '../src/http/operatorHeaders.js';
import type { WorkExecutionContext } from '@ziggs-ai/contracts';

/**
 * An artifact is scoped to an explicit conversation or explicit work. A
 * processing lane (`agrn-<agreementId>`, `msgn-<messageId>` or a custom
 * resolver key) is a routing key and is never sent as an address.
 */

test('an agreement scopes by itself, never by a lane name', () => {
  const scope = artifactScope({ agreementId: 'agr_1785203433677_7sjw92qs' });
  assert.deepEqual(scope, { agreementId: 'agr_1785203433677_7sjw92qs' });
  assert.ok(!('addressId' in scope));
});

test('a named conversation stays a conversation scope', () => {
  assert.deepEqual(artifactScope({ addressId: 'wbtelidxg' }), { addressId: 'wbtelidxg' });
});

test('an unattached private artifact needs no conversation or agreement', () => {
  assert.deepEqual(artifactScope(), {});
  assert.deepEqual(artifactScope({}), {});
});

test('the selected execution scopes the write', async () => {
  const work = { contextId: 'xec_work', actorId: 'a', principalId: 'p', agreementId: 'agr_work', position: 'provider', audienceIds: [], audienceRevision: 'r' } as WorkExecutionContext;
  const direct = { ...work, contextId: 'xec_direct', agreementId: null, action: { kind: 'message', id: 'm1' } } as WorkExecutionContext;
  await withWorkExecution(work, () => assert.deepEqual(artifactScope({ addressId: 'room' }), { agreementId: 'agr_work' }));
  await withWorkExecution(direct, () => assert.deepEqual(artifactScope(), {}));
});

test('the prefix is the one the lane resolver mints', () => {
  assert.equal(AGREEMENT_LANE_PREFIX, 'agrn-');
});
