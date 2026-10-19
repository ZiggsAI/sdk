import { isMcpOAuthDelegateSession } from '../src/shared/operatorKey.js';
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchHostedAgentAccess,
  fetchSessionAccess,
} from '../src/http/OrgsClient.js';
import type { Creds } from '../src/types.js';

const token = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const hosted = { operatorKey: 'op', agentId: 'delegate--hosted' } as Creds;
const delegate = {
  operatorKey: token({ boundAgentId: 'assistant-any-slug', issuedVia: 'mcp_oauth' }),
  agentId: 'assistant-any-slug',
} as Creds;

describe('fetchSessionAccess (ZIG-1272)', () => {
  afterEach(() => mock.restoreAll());

  it('routes by bound credential provenance, including device consent', () => {
    assert.equal(isMcpOAuthDelegateSession(hosted), false);
    assert.equal(isMcpOAuthDelegateSession(delegate), true);
    assert.equal(isMcpOAuthDelegateSession({ ...delegate, agentId: 'someone-else' }), false);
    assert.equal(isMcpOAuthDelegateSession({ ...delegate,
      operatorKey: token({ boundAgentId: delegate.agentId, issuedVia: 'device_code' }),
    }), true);
    assert.equal(isMcpOAuthDelegateSession({ ...delegate,
      operatorKey: token({ boundAgentId: delegate.agentId }),
    }), false);
  });

  it('hosted path uses /orgs/me activeOrgId and never hits Claude-delegate access', async () => {
    const hits: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      hits.push(String(url));
      if (String(url).includes('/orgs/me')) {
        return new Response(
          JSON.stringify({
            activeOrgId: 'org-home',
            orgs: [{ orgId: 'org-home', name: 'Home', kind: 'team' }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${url}`);
    });

    const access = await fetchHostedAgentAccess(hosted, 'https://api.test');
    assert.equal(access.connected, true);
    assert.equal(access.orgId, 'org-home');
    assert.equal(access.orgName, 'Home');
    assert.equal(access.orgKind, 'team');
    assert.equal(
      hits.some((h) => h.includes('/agents/delegate/access')),
      false,
    );

    const routed = await fetchSessionAccess(hosted, 'https://api.test');
    assert.equal(routed.orgId, 'org-home');
  });

  it('prefers activeOrg label when membership omits the agent home org', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      if (String(url).includes('/orgs/me')) {
        return new Response(
          JSON.stringify({
            activeOrgId: 'org-fleet',
            activeOrg: {
              orgId: 'org-fleet',
              name: 'Ziggs Fleet',
              kind: 'team',
            },
            orgs: [{ orgId: 'org-personal', name: 'Personal', kind: 'personal' }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${url}`);
    });

    const access = await fetchHostedAgentAccess(hosted, 'https://api.test');
    assert.equal(access.connected, true);
    assert.equal(access.orgId, 'org-fleet');
    assert.equal(access.orgName, 'Ziggs Fleet');
    assert.equal(access.orgKind, 'team');
  });

  it('delegate path uses /agents/delegate/access', async () => {
    const hits: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      hits.push(String(url));
      if (String(url).includes('/agents/delegate/access')) {
        return new Response(
          JSON.stringify({
            connected: true,
            orgId: 'org-a',
            orgName: 'A',
            orgKind: 'team',
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${url}`);
    });

    const access = await fetchSessionAccess(delegate, 'https://api.test');
    assert.equal(access.connected, true);
    assert.equal(access.orgId, 'org-a');
    assert.ok(hits.some((h) => h.includes('/agents/delegate/access')));
    assert.equal(hits.some((h) => h.includes('/orgs/me')), false);
  });
});
