import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeOperatorKeyClaims,
  resolveDelegateCreds,
  resolveDelegateHttpUrl,
} from '../src/index.js';

function forge(payload: Record<string, unknown>): string {
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

describe('resolveDelegateCreds', () => {
  it('prefers ZIGGS_API_URL over HTTP_URL', () => {
    const key = forge({ type: 'operator', boundAgentId: 'ada' });
    const resolved = resolveDelegateCreds({
      ZIGGS_API_URL: 'https://api.ziggsai.com',
      HTTP_URL: 'http://localhost:3000',
      ZIGGS_OPERATOR_KEY: key,
    });
    assert.equal(resolved.httpUrl, 'https://api.ziggsai.com');
    assert.equal(resolved.agentId, 'ada');
    assert.equal(
      resolveDelegateHttpUrl({
        ZIGGS_API_URL: 'https://api.ziggsai.com',
        HTTP_URL: 'http://localhost:3000',
      }),
      'https://api.ziggsai.com',
    );
  });

  it('accepts an agent-scoped key without ZIGGS_AGENT_ID', () => {
    const resolved = resolveDelegateCreds({
      ZIGGS_OPERATOR_KEY: forge({ type: 'operator', boundAgentId: 'ada' }),
    });
    assert.equal(resolved.agentId, 'ada');
  });

  it('refuses a session token', () => {
    assert.throws(
      () =>
        resolveDelegateCreds({
          ZIGGS_OPERATOR_KEY: forge({ type: 'session', sub: 'u1' }),
          ZIGGS_AGENT_ID: 'ada',
        }),
      /not a session JWT/,
    );
  });

  it('ignores a non-string boundAgentId', () => {
    const claims = decodeOperatorKeyClaims(
      forge({ type: 'operator', boundAgentId: 12 }),
    );
    assert.equal(claims?.boundAgentId, null);
    assert.equal(claims?.issuedVia, undefined);
    const kept = decodeOperatorKeyClaims(
      forge({ type: 'operator', boundAgentId: 'ada', issuedVia: 'mcp_oauth' }),
    );
    assert.equal(kept?.issuedVia, 'mcp_oauth');
  });
});
