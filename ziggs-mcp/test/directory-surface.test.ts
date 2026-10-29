import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createZiggsMcpServer } from '../src/server.js';
import { CONNECTION_ONLY_DIRECTORY_TOOLS, DIRECTORY_TOOLS } from '../src/directorySurface.js';
import { registerStrictTool } from '../src/strictParams.js';
import { readOnly } from '../src/toolAnnotations.js';
import type { ZiggsMcpConfig } from '../src/config.js';

const claims = (extra: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify({ type: 'operator', keyId: 'key', ownerId: 'owner', ...extra })).toString('base64url')}.test`;
/** A browser-consent connection: one key, a roster of workspace assistants. */
const connectionKey = claims({ connectionClientId: 'client', issuedVia: 'mcp_oauth' });
/** A device-boarded key: one assistant in one workspace, no roster. */
const deviceKey = claims({ boundAgentId: 'assistant', issuedVia: 'device_code' });

async function connect(host = 'ChatGPT', key = connectionKey, agentId = '') {
  const server = createZiggsMcpServer({ operatorKey: key, agentId, instanceId: 'test-host' }, {
    directConnection: false, coreOnly: true, debugTools: true,
  } as ZiggsMcpConfig);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: host, version: 'test' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client };
}
const text = (r: unknown) => (r as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('');
afterEach(() => mock.restoreAll());

describe('one directory contract for ChatGPT, Claude and Cursor', () => {
  for (const host of ['ChatGPT', 'Claude', 'Cursor']) {
    it(`${host} gets every allowed operation and explicit effect annotations`, async () => {
      const { client } = await connect(host);
      try {
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((t) => t.name).sort(), [...DIRECTORY_TOOLS].sort());
        for (const t of tools) {
          assert.ok(t.title && t.description && t.inputSchema);
          assert.ok(t.name.length <= 64);
          for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint'])
            assert.equal(typeof t.annotations?.[hint], 'boolean', `${t.name}.${hint}`);
          if (t.annotations?.readOnlyHint) assert.equal(t.annotations.destructiveHint, false, t.name);
        }
        const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;
        // Observing the inbox is a read; taking its lease takes it from others.
        assert.equal(hints('ziggs_inbox')?.readOnlyHint, true);
        assert.deepEqual(
          [hints('ziggs_inbox_claim')?.readOnlyHint, hints('ziggs_inbox_claim')?.destructiveHint],
          [false, true],
        );
        // The directories' rule: a write is destructive when it sends, commits,
        // overwrites, cancels or revokes; undo does not make it additive. Only
        // private additive writes stay non-destructive.
        for (const name of ['ziggs_artifact_record', 'ziggs_artifact_upload_url', 'ziggs_artifact_complete_file', 'ziggs_chat_open', 'ziggs_task_create', 'ziggs_context_delegate', 'ziggs_introduction_mint'])
          assert.equal(hints(name)?.destructiveHint, false, name);
        for (const name of ['ziggs_chat_send', 'ziggs_task_update_steps', 'ziggs_task_replace_plan', 'ziggs_task_cancel', 'ziggs_inbox_ack', 'ziggs_agreement_respond', 'ziggs_agreement_claim', 'ziggs_artifact_share', 'ziggs_introduction_revoke', 'ziggs_task_set_result', 'ziggs_agreement_fulfill', 'ziggs_agreement_revoke', 'ziggs_context_revoke_grant'])
          assert.equal(hints(name)?.destructiveHint, true, name);
        assert.equal(hints('ziggs_payment_balance')?.openWorldHint, false);
        assert.equal(DIRECTORY_TOOLS.has('ziggs_agreement_offer'), false);
        assert.equal(DIRECTORY_TOOLS.has('ziggs_listing_pause'), false);
        assert.equal(DIRECTORY_TOOLS.has('ziggs_listing_resume'), false);
      } finally { await client.close(); }
    });
  }

  it('a device-boarded key gets the same surface minus the roster sync', async () => {
    const { client } = await connect('Cursor', deviceKey, 'assistant');
    try {
      const { tools } = await client.listTools();
      const expected = [...DIRECTORY_TOOLS].filter((name) => !CONNECTION_ONLY_DIRECTORY_TOOLS.has(name));
      assert.deepEqual(tools.map((t) => t.name).sort(), expected.sort());
      const r = await client.callTool({ name: 'ziggs_workspace_sync', arguments: {} });
      assert.equal(r.isError, true);
      assert.match(text(r), /not found|unknown tool/i);
    } finally { await client.close(); }
  });

  it('instructions carry the delegate protocol, not the catalog', async () => {
    const { client } = await connect();
    try {
      const instructions = client.getInstructions() ?? '';
      // What the model must keep doing on this surface.
      for (const kept of ['ackTo', 'handledDeliveryIds', 'task.control', 'WORK_SELECTION_REQUIRED', 'sessionChatCard', 'waitSeconds: 55', 'idempotencyKey'])
        assert.ok(instructions.includes(kept), kept);
      // What this surface does differently.
      assert.ok(instructions.includes('ziggs_inbox_claim'));
      assert.doesNotMatch(instructions, /acquires this host/);
      // What does not exist here.
      assert.doesNotMatch(instructions, /ziggs_tools|ziggs_tool_read|ziggs_tool_write/);
    } finally { await client.close(); }
  });

  it('never registers excluded tools or an unreviewed new capability', async () => {
    const { server, client } = await connect();
    let ran = false;
    registerStrictTool(server, 'ziggs_unreviewed', {}, readOnly('Unreviewed'), async () => { ran = true; return { content: [] }; });
    const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('excluded tools must not reach HTTP'); });
    try {
      for (const name of ['ziggs_tools', 'ziggs_tool_read', 'ziggs_tool_write', 'ziggs_unreviewed',
        'ziggs_connection_proxy', 'ziggs_connection_tools', 'ziggs_smoke_impersonation',
        'ziggs_payment_transfer', 'ziggs_payment_hold', 'ziggs_payment_release', 'ziggs_payment_create_intent']) {
        const r = await client.callTool({ name, arguments: { tool: 'ziggs_chat_send', args: { chatId: 'room', text: 'send' } } });
        assert.equal(r.isError, true, name);
        assert.match(text(r), /not found|unknown tool/i);
      }
      assert.equal(fetch.mock.calls.length, 0);
      assert.equal(ran, false);
    } finally { await client.close(); }
  });

  it('never falls back to an acquiring read on an older backend', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (input: unknown) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      return path.endsWith('/connection-notices')
        ? new Response(JSON.stringify({ notices: [], assistantConnection: true }))
        : new Response('Snapshot unavailable', { status: 404 });
    });
    const { client } = await connect();
    try {
      assert.equal((await client.callTool({ name: 'ziggs_inbox', arguments: { waitSeconds: 0 } })).isError, true);
      assert.ok(calls.includes('/oauth/inbox/snapshot'));
      assert.equal(calls.includes('/oauth/inbox'), false);
    } finally { await client.close(); }
  });

  for (const name of ['ziggs_open', 'ziggs_access_explain']) {
    it(`${name} accepts its advertised and cached arguments through the MCP transport`, async () => {
      const calls: Array<{ path: string; body: unknown }> = [];
      mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/connection-notices')) return new Response(JSON.stringify({ notices: [] }));
        calls.push({ path, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ outcome: 'hidden', ref: { kind: 'chat', id: 'room' }, actions: [], access: { summary: 'Unavailable' }, workContext: { laneId: null } }));
      });
      const { client } = await connect('ChatGPT', deviceKey, 'assistant');
      try {
        const tool = (await client.listTools()).tools.find(tool => tool.name === name)!;
        for (const field of ['ref', 'chatId', 'artifactId', 'taskId', 'agreementId']) {
          assert.ok(tool.inputSchema.properties?.[field], `tools/list omitted ${field}`);
          const result = await client.callTool({ name, arguments: { [field]: 'room' } });
          assert.notEqual(result.isError, true, text(result));
          assert.deepEqual(calls.at(-1), {
            path: name === 'ziggs_open' ? '/context/open' : '/context/access/explain',
            body: { [field]: 'room' },
          });
        }
        const before = calls.length;
        const invalid = await client.callTool({ name, arguments: { ref: 'room', chatId: 'other' } });
        assert.equal(invalid.isError, true);
        assert.equal(calls.length, before);
      } finally { await client.close(); }
    });
  }

  it('publishes hireFor and carries the chosen workspace through MCP validation to the claim', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/connection-notices')) return new Response(JSON.stringify({ notices: [] }));
      calls.push({ path, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ code: 'FIXTURE_REFUSAL', message: 'The backend still decides authority' }), { status: 403 });
    });
    const { client } = await connect('ChatGPT', deviceKey, 'assistant');
    try {
      const tool = (await client.listTools()).tools.find(tool => tool.name === 'ziggs_agreement_claim')!;
      assert.deepEqual((tool.inputSchema.properties?.hireFor as { enum: string[] }).enum, ['me', 'workspace']);
      const result = await client.callTool({ name: 'ziggs_agreement_claim', arguments: { agreementId: 'listing', hireFor: 'workspace' } });
      assert.equal(result.isError, true);
      assert.match(text(result), /FIXTURE_REFUSAL/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, '/agreements/listing/claim');
      assert.equal(calls[0].body.hireFor, 'workspace');
    } finally { await client.close(); }
  });

  it('routes snapshots, claims, acknowledgements and workspace sync separately', async () => {
    const calls: { path: string; method: string }[] = [];
    mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method ?? 'GET' });
      if (path.endsWith('/connection-notices')) return new Response(JSON.stringify({ notices: [], assistantConnection: true }));
      if (path.endsWith('/workspaces/sync')) return new Response(JSON.stringify({ workspaces: [] }));
      if (path.endsWith('/inbox/ack')) return new Response(JSON.stringify({ ackedUpTo: 'ack' }));
      return new Response(JSON.stringify({ asOf: 'now', deliveries: [], chats: [], ackTo: null, tasksAwaitingMe: [], proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [], openRequestsAwaitingMe: [], workspaces: [], agentIds: ['assistant'] }));
    });
    const { client } = await connect();
    try {
      for (const [name, args] of [
        ['ziggs_inbox', { waitSeconds: 0 }], ['ziggs_inbox_claim', {}],
        ['ziggs_inbox_ack', { ack: 'ack', handledDeliveryIds: [] }], ['ziggs_workspace_sync', {}],
      ] as const) assert.notEqual((await client.callTool({ name, arguments: args })).isError, true, name);
      assert.deepEqual(calls.filter((c) => !c.path.endsWith('/connection-notices')), [
        { path: '/oauth/inbox/snapshot', method: 'GET' },
        { path: '/oauth/inbox', method: 'GET' },
        { path: '/oauth/inbox/ack', method: 'POST' },
        { path: '/oauth/workspaces/sync', method: 'POST' },
      ]);
    } finally { await client.close(); }
  });
});
