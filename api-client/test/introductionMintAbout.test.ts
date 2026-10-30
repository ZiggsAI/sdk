import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintIntroductionCapability,
  redeemIntroductionCapability,
} from '../src/capabilities/introductions.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';

const env: CapabilityEnv = {
  creds: { operatorKey: 'op', agentId: 'desk' },
  surface: 'mcp',
};

describe('introduction tools and what a string is about', () => {
  afterEach(() => mock.restoreAll());

  it('refuses half an about instead of minting a plain link', async () => {
    const fetched = mock.method(globalThis, 'fetch', async () => new Response('{}'));
    await assert.rejects(
      () => mintIntroductionCapability.handler({ aboutKind: 'workspace', email: 'ben@acme.com' }, env),
      /actingOrgId from ziggs_auth_status/,
    );
    await assert.rejects(
      () => mintIntroductionCapability.handler({ aboutKind: 'chat' }, env),
      /aboutId is required/,
    );
    assert.equal(fetched.mock.callCount(), 0);
  });

  it('sends a workspace string with the email it is for', async () => {
    let sent: Record<string, unknown> = {};
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ token: 'zint_x', url: 'https://app/intro/zint_x', redeems: { allowed: 1, left: 1 } }));
    });
    await mintIntroductionCapability.handler(
      { aboutKind: 'workspace', aboutId: 'org_1', email: 'ben@acme.com' },
      env,
    );
    assert.deepEqual(sent.about, { kind: 'workspace', id: 'org_1' });
    assert.equal(sent.email, 'ben@acme.com');
  });

  it('sends the person’s yes only when confirm is true', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ token: 'zint_x', outcome: 'joined', from: { orgId: 'o', agentId: null } }));
    });
    await redeemIntroductionCapability.handler({ token: 'zint_x' }, env);
    await redeemIntroductionCapability.handler({ token: 'zint_x', confirm: true }, env);
    assert.deepEqual(bodies, [{}, { confirm: true }]);
  });
});
