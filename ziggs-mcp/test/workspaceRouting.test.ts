import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantRequestHeaders } from '@ziggs-ai/api-client';
import { WorkspaceRouter } from '../src/workspaceRouting.js';

const workspaces = [
  { orgId: 'a', name: 'Acme', agentId: 'assistant-a' },
  { orgId: 'b', name: 'Beta', agentId: 'assistant-b' },
];
const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const body = (response: { content: { text?: string }[] }) => JSON.parse(response.content[0].text!);

/**
 * A backend double: answers the roster and `resolve`, and counts what was
 * asked, so each test can say how many round trips a call cost.
 */
function backend(opts: {
  roster?: () => unknown[];
  resolve?: (url: string) => { workspace: unknown; choices: unknown[] };
} = {}) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url.includes('/resolve?') ? 'resolve' : 'workspaces');
    if (url.includes('/resolve?')) {
      return new Response(JSON.stringify(opts.resolve?.(url) ?? { workspace: null, choices: [] }));
    }
    return new Response(JSON.stringify({ workspaces: opts.roster?.() ?? workspaces }));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('new work with two workspaces is refused with the choices before any action runs', async () => {
  const api = backend();
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    let calls = 0;
    const tool = router.wrap('ziggs_agreement_propose', false, async () => { calls++; return text({}); });
    const response = await tool({});
    assert.equal(response.isError, true);
    assert.equal(body(response).code, 'WORKSPACE_SELECTION_REQUIRED');
    assert.deepEqual(body(response).choices, workspaces.map(({ orgId, name }) => ({ orgId, name })));
    assert.equal(calls, 0);
    assert.deepEqual(api.calls, ['workspaces']);
  } finally { api.restore(); }
});

test('new work with one workspace runs as that assistant in one round trip and says where', async () => {
  const api = backend({ roster: () => [workspaces[0]] });
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    const tool = router.wrap('ziggs_chat_open', false, async () => text({ agentId: router.creds.agentId }));
    const response = body(await tool({ participantId: 'someone' }));
    assert.equal(response.agentId, 'assistant-a');
    assert.deepEqual(response.workspace, { orgId: 'a', name: 'Acme' });
    assert.deepEqual(api.calls, ['workspaces']);
  } finally { api.restore(); }
});

test('resource calls carry routing hints on the real request without a resolve round trip', async () => {
  const api=backend();
  try {
    const router=new WorkspaceRouter({operatorKey:'key',agentId:''});
    const tool=router.wrap('ziggs_chat_send',false,async args => {
      assert.equal(args.orgId,undefined);
      assert.equal(router.creds.agentId,'');
      return text(assistantRequestHeaders());
    });
    assert.deepEqual(body(await tool({chatId:'room-b'})), {'X-Ziggs-Resource':'chat:room-b'});
    assert.deepEqual(body(await tool({chatId:'room-b',orgId:'b'})), {'X-Ziggs-Resource':'chat:room-b','X-Workspace-Id':'b'});
    assert.deepEqual(api.calls,['workspaces']);
    assert.deepEqual(assistantRequestHeaders(),{});
  } finally {api.restore();}
});

test('open routes by the record its ref names, never fanning out (ZIG-2179)', async () => {
  const api=backend();
  try {
    const router=new WorkspaceRouter({operatorKey:'key',agentId:''});
    let calls=0;
    const tool=router.wrap('ziggs_open',true,async () => {
      calls++;
      return text(assistantRequestHeaders());
    });
    // TQDG9GZ is a task handle (check letter Z); case does not matter.
    assert.deepEqual(body(await tool({ref:'tqdg9gz'})), {'X-Ziggs-Resource':'task:TQDG9GZ'});
    assert.deepEqual(body(await tool({ref:'agr_1791956531449_if5x724t'})), {'X-Ziggs-Resource':'agreement:agr_1791956531449_if5x724t'});
    assert.equal(calls,2);
  } finally {api.restore();}
});

test('grant and connector routing hints stay isolated across concurrent calls', async () => {
  const api=backend();
  try {
    const router=new WorkspaceRouter({operatorKey:'key',agentId:''});
    const tool=router.wrap('ziggs_connection_proxy',false,async () => {
      const before=assistantRequestHeaders();
      await new Promise(r => setTimeout(r,2));
      assert.deepEqual(assistantRequestHeaders(),before);
      return text(before);
    });
    const [a,b]=await Promise.all([tool({grantId:'g-a'}),tool({connectionId:'c-b'})]);
    assert.equal(body(a)['X-Ziggs-Resource'],'grant:g-a');
    assert.equal(body(b)['X-Ziggs-Resource'],'connection:c-b');
    assert.ok(!api.calls.includes('resolve'));
  } finally {api.restore();}
});

test('an explicit workspace needs no resolve and the roster is read once a minute', async () => {
  const api = backend();
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    const tool = router.wrap('ziggs_chat_open', false, async () => text({ agentId: router.creds.agentId }));
    assert.equal(body(await tool({ orgId: 'b', participantId: 'x' })).agentId, 'assistant-b');
    assert.equal(body(await tool({ orgId: 'a', participantId: 'x' })).agentId, 'assistant-a');
    assert.deepEqual(api.calls, ['workspaces']);
  } finally { api.restore(); }
});

test('a workspace joined since the last read is found by re-reading the roster', async () => {
  let current = [...workspaces];
  const api = backend({ roster: () => current });
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    const tool = router.wrap('ziggs_chat_open', false, async () => text({ agentId: router.creds.agentId }));
    assert.equal(body(await tool({ orgId: 'a', participantId: 'x' })).agentId, 'assistant-a');
    assert.equal(body(await tool({ orgId: 'c', participantId: 'x' })).code, 'WORKSPACE_NOT_CONNECTED');
    current = [...workspaces, { orgId: 'c', name: 'Gamma', agentId: 'assistant-c' }];
    assert.equal(body(await tool({ orgId: 'c', participantId: 'x' })).agentId, 'assistant-c');
    assert.deepEqual(api.calls, ['workspaces', 'workspaces', 'workspaces']);
  } finally { api.restore(); }
});

test('a list with no target runs once per workspace and labels each result', async () => {
  const api = backend();
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    const tool = router.wrap('ziggs_task_list', true, async () => text({ tasks: [router.creds.agentId] }));
    const union = body(await tool({}));
    assert.deepEqual(union.workspaces.map((w: { orgId: string }) => w.orgId), ['a', 'b']);
    assert.deepEqual(union.workspaces[1].result.tasks, ['assistant-b']);
    const narrowed = body(await tool({ orgId: 'a' }));
    assert.deepEqual(narrowed.tasks, ['assistant-a']);
    assert.deepEqual(narrowed.workspace, { orgId: 'a', name: 'Acme' });
  } finally { api.restore(); }
});

test('a read that is the same everywhere runs once, as the first assistant, unlabelled', async () => {
  const api = backend();
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    let calls = 0;
    const tool = router.wrap('ziggs_marketplace_view', true, async () => { calls++; return text({ listings: [] }); });
    const response = body(await tool({}));
    assert.deepEqual(response, { listings: [] });
    assert.equal(calls, 1);
  } finally { api.restore(); }
});

test('a tool with its own workspace argument gets the picked one on each fan-out run', async () => {
  const api = backend();
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    const tool = router.wrap('ziggs_org_members', true, async (args) => text({ orgId: args.orgId }), true);
    const union = body(await tool({}));
    assert.deepEqual(union.workspaces.map((w: { result: { orgId: string } }) => w.result.orgId), ['a', 'b']);
  } finally { api.restore(); }
});

test('concurrent tool calls keep separate assistant credentials', async () => {
  const api = backend();
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    const tool = router.wrap('ziggs_chat_open', false, async () => {
      const before = router.creds.agentId;
      await new Promise((resolve) => setTimeout(resolve, before.endsWith('a') ? 15 : 1));
      assert.equal(router.creds.agentId, before);
      return text({ agentId: router.creds.agentId });
    });
    const [a, b] = await Promise.all([tool({ orgId: 'a' }), tool({ orgId: 'b' })]);
    assert.equal(body(a).agentId, 'assistant-a');
    assert.equal(body(b).agentId, 'assistant-b');
    assert.equal(router.creds.agentId, '');
  } finally { api.restore(); }
});

test('the inbox read refreshes the roster for the calls after it', async () => {
  const api = backend();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/inbox?')) {
      return new Response(JSON.stringify({
        asOf: 'now', deliveries: [], ackTo: null, sources: [], chats: [], tasksAwaitingMe: [],
        openRequestsAwaitingMe: [], proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [],
        agentIds: ['assistant-a'], workspaces: [workspaces[0]],
      }));
    }
    return original(input);
  }) as typeof fetch;
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    const inbox = router.wrap('ziggs_inbox', true, async () => text({}));
    assert.deepEqual(body(await inbox({})).session.workspaces, [workspaces[0]]);
    const tool = router.wrap('ziggs_chat_open', false, async () => text({ agentId: router.creds.agentId }));
    assert.equal(body(await tool({ participantId: 'x' })).agentId, 'assistant-a');
    assert.deepEqual(api.calls, [], 'the roster came with the inbox, no separate read');
  } finally { globalThis.fetch = original; api.restore(); }
});

test('one identity sends explicit workspace headers without sharing concurrent choices', async () => {
  const api = backend({ roster: () => workspaces.map(w => ({ ...w, agentId: 'one-assistant' })) });
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    const tool = router.wrap('ziggs_chat_open', false, async () => {
      const before = assistantRequestHeaders();
      await new Promise(resolve => setTimeout(resolve, 2));
      assert.deepEqual(assistantRequestHeaders(), before);
      return text({ ...before, agentId: router.creds.agentId });
    });
    const [a, b] = await Promise.all([tool({ orgId: 'a' }), tool({ orgId: 'b' })]);
    assert.equal(body(a)['X-Workspace-Id'], 'a');
    assert.equal(body(b)['X-Workspace-Id'], 'b');
    assert.equal(body(a).agentId, 'one-assistant');
    assert.equal(body(b).agentId, 'one-assistant');
    assert.deepEqual(assistantRequestHeaders(), {});
  } finally { api.restore(); }
});

test('the same refusal from every workspace is one refusal, not a per-workspace success (ZIG-2118)', async () => {
  const api = backend();
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    const refusal = { ...text({ error: { code: 'INVALID_INPUT', message: 'Pass exactly one of artifactId, chatId, taskId, agreementId.' } }), isError: true };
    const tool = router.wrap('ziggs_chat_list', true, async () => refusal);
    const response = await tool({});
    assert.equal(response.isError, true);
    assert.equal(body(response).error.code, 'INVALID_INPUT');
    assert.equal(body(response).workspaces, undefined);

    // Different answers per workspace stay labelled per workspace.
    const mixed = router.wrap('ziggs_chat_list', true, async () =>
      router.creds.agentId === 'assistant-a' ? refusal : text({ chats: [] }));
    const labelled = body(await mixed({}));
    assert.deepEqual(labelled.workspaces.map((w: { orgId: string }) => w.orgId), ['a', 'b']);
  } finally { api.restore(); }
});

test('a list of agreements from two workspaces shows each agreement once, with its own org id', async () => {
  const api = backend();
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    // agr_shared belongs to workspace a; b reads it as another org's reader,
    // which gets no orgId. agr_b is only in b.
    const tool = router.wrap('ziggs_agreement_list', true, async () =>
      router.creds.agentId === 'assistant-a'
        ? text({ count: 1, scope: 'mine', agreements: [{ agreementId: 'agr_shared', orgId: 'a', title: 'home' }] })
        : text({
            count: 2,
            scope: 'mine',
            agreements: [
              { agreementId: 'agr_shared', orgId: null, title: 'away' },
              { agreementId: 'agr_b', orgId: 'b' },
            ],
          }));
    const response = body(await tool({}));
    assert.equal(response.workspaces, undefined);
    assert.equal(response.scope, 'mine');
    assert.equal(response.count, 2);
    assert.deepEqual(response.agreements, [
      { agreementId: 'agr_shared', orgId: 'a', title: 'home', seenIn: [{ orgId: 'a', name: 'Acme' }, { orgId: 'b', name: 'Beta' }] },
      { agreementId: 'agr_b', orgId: 'b', seenIn: [{ orgId: 'b', name: 'Beta' }] },
    ]);

    // The home copy wins even when the other workspace answers first.
    const reversed = router.wrap('ziggs_agreement_list', true, async () =>
      router.creds.agentId === 'assistant-a'
        ? text({ agreements: [{ agreementId: 'agr_x', orgId: null }] })
        : text({ agreements: [{ agreementId: 'agr_x', orgId: 'b' }] }));
    assert.equal(body(await reversed({})).agreements[0].orgId, 'b');

    // A workspace that fails is named, and the others still merge.
    const partial = router.wrap('ziggs_agreement_list', true, async () =>
      router.creds.agentId === 'assistant-a'
        ? { ...text({ error: { code: 'FORBIDDEN' } }), isError: true }
        : text({ agreements: [{ agreementId: 'agr_b', orgId: 'b' }] }));
    const partialBody = body(await partial({}));
    assert.equal(partialBody.count, 1);
    assert.deepEqual(partialBody.failedIn, [{ orgId: 'a', name: 'Acme', result: { error: { code: 'FORBIDDEN' } } }]);
  } finally { api.restore(); }
});

test('delegation and result return route by the source task, not the receiving agreement or output', async () => {
  const api = backend();
  try {
    const router = new WorkspaceRouter({ operatorKey: 'key', agentId: '' });
    const tool = router.wrap('ziggs_task_delegate', false, async () => text(assistantRequestHeaders()));
    assert.deepEqual(body(await tool({ action: 'create', taskId: 'parent', agreementId: 'destination', instructionArtifactId: 'instructions' })), { 'X-Ziggs-Resource': 'task:parent' });
    assert.deepEqual(body(await tool({ action: 'return', taskId: 'child', artifactId: 'output' })), { 'X-Ziggs-Resource': 'task:child' });
  } finally { api.restore(); }
});
