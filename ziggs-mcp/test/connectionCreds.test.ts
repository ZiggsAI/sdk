import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionFromBearer,
  parseBearerAuthorization,
} from '../src/connectionCreds.js';

describe('connectionCreds (ZIG-466 library)', () => {
  it('parseBearerAuthorization rejects missing header', () => {
    assert.throws(() => parseBearerAuthorization(undefined), /Bearer/);
  });

  it('connectionFromBearer resolves agent-scoped key', () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'operator', boundAgentId: 'delegate--u1' }),
    ).toString('base64url');
    const bearer = `hdr.${payload}.sig`;
    const { creds, cfg } = connectionFromBearer(bearer, 'https://api.test');
    assert.equal(creds.agentId, 'delegate--u1');
    assert.equal(creds.operatorKey, bearer);
    assert.equal(cfg.HTTP_URL, 'https://api.test');
  });

  // The listed (directory) surface follows the credential, not the endpoint:
  // an assistant boards through the OAuth consent flow, whose tokens the
  // backend stamps; a developer who pastes their own operator key here gets
  // everything stdio gets.
  it('a token the OAuth consent flow minted gets the listed surface', () => {
    const payload = Buffer.from(
      JSON.stringify({
        type: 'operator',
        boundAgentId: 'delegate--u1',
        issuedVia: 'mcp_oauth',
      }),
    ).toString('base64url');
    const { cfg } = connectionFromBearer(`hdr.${payload}.sig`, 'https://api.test');
    assert.equal(cfg.directConnection, false);
  });

  it('an operator key pasted at the remote endpoint gets the whole surface', () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'operator', boundAgentId: 'delegate--u1' }),
    ).toString('base64url');
    const { cfg } = connectionFromBearer(`hdr.${payload}.sig`, 'https://api.test');
    assert.equal(cfg.directConnection, true);
  });

  /**
   * ZIG-1774 — the lane the caller stated reaches `Creds`.
   *
   * Every client in this package sends `creds.laneId` as `X-Ziggs-Lane` and
   * nothing ever set it, so a delegate served by this surface was fenced to
   * its own estate and its customers' grants were refused. The lane arrives
   * off the request the same way the owner-user id does.
   */
  it('carries the stated lane onto the creds every client reads', () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'operator', boundAgentId: 'delegate--u1' }),
    ).toString('base64url');
    const { creds, cfg } = connectionFromBearer(
      `hdr.${payload}.sig`,
      'https://api.test',
      'user_1',
      'agrn-agr_acme',
    );
    assert.equal(creds.laneId, 'agrn-agr_acme');
    assert.equal(cfg.ZIGGS_LANE_ID, 'agrn-agr_acme');
  });

  it('copies a pinned window onto the creds the inbox client sends', () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'operator', boundAgentId: 'delegate--u1', keyId: 'key_1' }),
    ).toString('base64url');
    const { creds } = connectionFromBearer(
      `hdr.${payload}.sig`,
      'https://api.test',
      undefined,
      undefined,
      {
        clientSessionId: 'claude-code-backend',
        workspaceIds: 'org_backend',
        app: 'Claude Code',
        sessionName: 'Claude Code · MacBook · ziggs/backend',
      },
    );
    assert.equal(creds.clientSessionId, 'claude-code-backend');
    assert.equal(creds.workspaceIds, 'org_backend');
    assert.equal(creds.app, 'Claude Code');
    assert.equal(creds.sessionName, 'Claude Code · MacBook · ziggs/backend');
  });

  it('omits laneId when the caller stated none — absent means own estate', () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'operator', boundAgentId: 'delegate--u1' }),
    ).toString('base64url');
    const { creds } = connectionFromBearer(`hdr.${payload}.sig`, 'https://api.test');
    assert.equal('laneId' in creds, false);
  });
});
