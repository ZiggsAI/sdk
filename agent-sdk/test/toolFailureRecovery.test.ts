import assert from 'node:assert/strict';
import { it } from 'node:test';
import { toolFailureText } from '../src/brain/toolFailureText.js';
import { describeOperationError } from '@ziggs-ai/api-client';

it('runtime failures retain the same callable recovery and approver choices as the shared client', () => {
  const error = Object.assign(new Error('Choose who to ask'), {
    status: 400, code: 'ACCESS_APPROVER_REQUIRED', body: JSON.stringify({
      choices: [{ id: 'itay', name: 'Itay', role: 'operator' }],
      recovery: { tool: 'access_request', args: { scopeKind: 'address', scopeId: 'room', permission: 'reply' }, required: ['reason', 'recipientId'] },
    }),
  });
  const wrapped = new Error('Tool failed', { cause: error });
  assert.deepEqual(JSON.parse(toolFailureText(wrapped)), describeOperationError(error));
});

it('runtime failures keep what a refusal is about, so an agent can list it', () => {
  const error = Object.assign(new Error('Everyone in this bucket reads its replies.'), {
    status: 409, code: 'BUCKET_READERS_MISSING', body: JSON.stringify({
      impact: { bucketId: 'bkt_1', missing: ['ben'] },
    }),
  });
  assert.deepEqual(JSON.parse(toolFailureText(new Error('Tool failed', { cause: error }))), {
    code: 'BUCKET_READERS_MISSING',
    message: 'Everyone in this bucket reads its replies.',
    impact: { bucketId: 'bkt_1', missing: ['ben'] },
  });
});

it('plain runtime errors remain readable', () => {
  assert.equal(toolFailureText(new Error('network unavailable')), 'network unavailable');
});
