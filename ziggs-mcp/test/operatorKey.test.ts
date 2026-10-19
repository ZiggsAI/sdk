import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('operatorKey', () => {
  it('decodeOperatorKeyClaims reads ownerId from JWT payload', async () => {
    const payload = Buffer.from(
      JSON.stringify({
        type: 'operator',
        keyId: 'op_test',
        ownerId: 'user-abc',
        boundAgentId: 'my-delegate',
      }),
    ).toString('base64url');
    const token = `hdr.${payload}.sig`;
    const { decodeOperatorKeyClaims } = await import('../src/operatorKey.js');
    const claims = decodeOperatorKeyClaims(token);
    assert.equal(claims?.ownerId, 'user-abc');
  });

  it('decodeOperatorKeyClaims reads boundAgentId from JWT payload', async () => {
    const payload = Buffer.from(
      JSON.stringify({
        type: 'operator',
        keyId: 'op_test',
        boundAgentId: 'my-delegate',
      }),
    ).toString('base64url');
    const token = `hdr.${payload}.sig`;
    const { decodeOperatorKeyClaims } = await import('../src/operatorKey.js');
    const claims = decodeOperatorKeyClaims(token);
    assert.equal(claims?.boundAgentId, 'my-delegate');
    assert.equal(claims?.keyId, 'op_test');
  });

  it('resolveDelegateAgentId uses boundAgentId without env agent id', async () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'operator', boundAgentId: 'delegate-agent' }),
    ).toString('base64url');
    const token = `hdr.${payload}.sig`;
    const { resolveDelegateAgentId } = await import('../src/operatorKey.js');
    assert.equal(resolveDelegateAgentId(token, undefined), 'delegate-agent');
  });

  it('resolveDelegateAgentId rejects conflicting env agent id', async () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'operator', boundAgentId: 'agent-a' }),
    ).toString('base64url');
    const token = `hdr.${payload}.sig`;
    const { resolveDelegateAgentId } = await import('../src/operatorKey.js');
    assert.throws(
      () => resolveDelegateAgentId(token, 'agent-b'),
      /conflicts with agent-scoped key/,
    );
  });

  it('resolveDelegateAgentId requires env agent id for fleet keys', async () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'operator', keyId: 'op_fleet' }),
    ).toString('base64url');
    const token = `hdr.${payload}.sig`;
    const { resolveDelegateAgentId } = await import('../src/operatorKey.js');
    assert.throws(
      () => resolveDelegateAgentId(token, undefined),
      /ZIGGS_AGENT_ID/,
    );
    assert.equal(resolveDelegateAgentId(token, 'cursor-delegate'), 'cursor-delegate');
  });
});
