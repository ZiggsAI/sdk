import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeOperatorKeyClaims,
  boundKeyFleetWarning,
} from '../src/shared/operatorKeyClaims.js';

function forgeKey(payload: Record<string, unknown>): string {
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

describe('decodeOperatorKeyClaims', () => {
  it('reads boundAgentId from the payload without verifying', () => {
    const claims = decodeOperatorKeyClaims(
      forgeKey({ type: 'operator', ownerId: 'u1', boundAgentId: 'zigi' }),
    );
    assert.equal(claims?.boundAgentId, 'zigi');
    assert.equal(claims?.ownerId, 'u1');
  });

  it('normalizes a missing binding to null', () => {
    const claims = decodeOperatorKeyClaims(forgeKey({ type: 'operator', ownerId: 'u1' }));
    assert.equal(claims?.boundAgentId, null);
  });

  it('returns null on non-JWT input', () => {
    assert.equal(decodeOperatorKeyClaims('not-a-jwt'), null);
    assert.equal(decodeOperatorKeyClaims(''), null);
  });
});

describe('boundKeyFleetWarning (ZIG-911)', () => {
  it('warns when a bound key drives a multi-agent fleet', () => {
    const line = boundKeyFleetWarning(forgeKey({ boundAgentId: 'zigi' }), 774);
    assert.ok(line, 'warning expected');
    assert.match(line!, /bound to agent "zigi"/);
    assert.match(line!, /1 of 774 registered agents/);
    assert.match(line!, /403/);
    assert.match(line!, /agents:impersonate/);
  });

  it('stays quiet for a one-agent launcher on a bound key (legitimate)', () => {
    assert.equal(boundKeyFleetWarning(forgeKey({ boundAgentId: 'zigi' }), 1), null);
  });

  it('stays quiet for an unbound fleet key', () => {
    assert.equal(boundKeyFleetWarning(forgeKey({ ownerId: 'u1' }), 774), null);
  });

  it('stays quiet when the key is not decodable (backend stays the authority)', () => {
    assert.equal(boundKeyFleetWarning('opaque-key', 774), null);
  });
});
