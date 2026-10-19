import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { agreementHandoffCapability } from '../src/capabilities/agreementVerbs.js';
import { configureApiClient } from '../src/config.js';

configureApiClient({ httpUrl: 'http://handoff.test' });
afterEach(() => mock.restoreAll());
for (const surface of ['sdk', 'mcp'] as const) {
  for (const to of [undefined, 'customer']) {
    test(`${surface} ${to ? 'direct' : 'published'} handoff resolves the provider on the server`, async () => {
      const writes: Record<string, unknown>[] = [];
      mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          writes.push(JSON.parse(String(init.body)));
          return Response.json({ agreement: { agreementId: 'shared' } });
        }
        return Response.json({ agreement: {
          agreementId: 'parent', publishedService: false,
          parties: { provider: { principal: 'psn_supplier', actor: 'psn_masked_agent' } },
          terms: { description: 'Support' },
        } });
      });
      await agreementHandoffCapability.handler({ parentAgreementId: 'parent', ...(to ? { to } : {}) }, {
        creds: { operatorKey: 'test', agentId: 'owner-agent' }, surface, webUrl: 'http://localhost:1234',
      });
      assert.equal(writes.length, 1);
      assert.equal(writes[0].useParentProvider, true);
      assert.equal(writes[0].providerId, undefined);
      assert.equal(writes[0].parentAgreementId, 'parent');
      assert.equal(writes[0].proposedTo, to ?? 'everyone');
    });
  }
}
test('an old server cannot silently turn a handoff into a work request', async () => {
  const methods: string[] = [];
  mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    return Response.json({ agreement: { agreementId: 'parent', parties: { provider: { actor: 'psn_agent' } } } });
  });
  await assert.rejects(agreementHandoffCapability.handler({ parentAgreementId: 'parent' }, {
    creds: { operatorKey: 'test', agentId: 'owner-agent' }, surface: 'sdk', webUrl: 'http://localhost:1234',
  }), /updated server/);
  assert.deepEqual(methods, ['GET']);
});
