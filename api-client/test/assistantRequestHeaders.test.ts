import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withAssistantRequest, buildOperatorHeaders, assistantRequestHeaders } from '../src/http/operatorHeaders.js';

test('workspace routing retains session attribution and cannot leak it into another concurrent call', async () => {
  const results = await Promise.all(['codex-chat', 'claude-chat'].map(clientSessionId =>
    withAssistantRequest({ clientSessionId, app: clientSessionId, workspaceIds: 'org-a', instanceId: clientSessionId }, async () => {
      await Promise.resolve();
      return withAssistantRequest({ orgId: 'org-a', resource: 'chat:room' }, async () => {
        await Promise.resolve();
        return buildOperatorHeaders('test-key', 'agent');
      });
    }),
  ));
  for (const [i, session] of ['codex-chat', 'claude-chat'].entries()) {
    assert.equal(results[i]['X-Ziggs-Session'], session);
    assert.equal(results[i]['X-Ziggs-App'], session);
    assert.equal(results[i]['X-Ziggs-Instance'], session);
    assert.equal(results[i]['X-Ziggs-Workspaces'], 'org-a');
    assert.equal(results[i]['X-Workspace-Id'], 'org-a');
    assert.equal(results[i]['X-Ziggs-Resource'], 'chat:room');
  }
  assert.deepEqual(assistantRequestHeaders(), {});
});

test('nested calls inherit only session hints, not a previous routing target', async () => {
  await withAssistantRequest({ clientSessionId: 'same-window', orgId: 'old-org', resource: 'chat:old' }, async () => {
    await withAssistantRequest({ orgId: 'new-org' }, () => {
      const headers = assistantRequestHeaders();
      assert.equal(headers['X-Ziggs-Session'], 'same-window');
      assert.equal(headers['X-Workspace-Id'], 'new-org');
      assert.equal(headers['X-Ziggs-Resource'], undefined);
    });
    assert.equal(assistantRequestHeaders()['X-Ziggs-Resource'], 'chat:old');
  });
});
