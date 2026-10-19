import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWorkspaceRouting, workspaceRouter } from '../src/workspaceRouting.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { installConnectionNotices, appendConnectionNotices, readConnectionNotices } from '../src/connectionNotices.js';

test('notices accompany tools, expose session state and disappear on the next call after upgrade', async (t) => {
  const server = {} as McpServer;
  const token = `e30.${Buffer.from(JSON.stringify({ type: 'operator', keyId: 'key' })).toString('base64url')}.signature`;
  let notices = ['Ask your person to reconnect in Marketing.'];
  const calls: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls.push(init);
    return new Response(JSON.stringify({ notices }));
  });
  installConnectionNotices(server, { operatorKey: token, agentId: 'old' }, '0.33.1');
  const original = { content: [{ type: 'text', text: JSON.stringify({ session: { connected: true } }) }] };
  const decorated: any = await appendConnectionNotices(server, 'ziggs_auth_status', original);
  assert.equal(decorated.content.at(-1).text, notices[0]);
  assert.deepEqual(JSON.parse(decorated.content[0].text).session.connectionNotices, notices);
  assert.equal(JSON.parse(original.content[0].text).session.connectionNotices, undefined);
  assert.equal((calls[0].headers as Record<string, string>)['X-Ziggs-Mcp-Version'], '0.33.1');
  notices = ['stale'];
  // An ordinary tool call reads the cached answer, not the server.
  assert.equal((await appendConnectionNotices(server, 'ziggs_chat_send', original) as any).content.at(-1).text, 'Ask your person to reconnect in Marketing.');
  assert.equal(calls.length, 1);
  notices = [];
  assert.equal(await appendConnectionNotices(server, 'ziggs_inbox', original), original);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unavailable'); });
  assert.equal(await appendConnectionNotices(server, 'ziggs_chat_send', original), original);
});


test('the same legacy bearer switches to the surviving identity from live metadata', async (t) => {
  const server = {} as McpServer;
  const token = `e30.${Buffer.from(JSON.stringify({ type: 'operator', keyId: 'legacy', boundAgentId: 'retired' })).toString('base64url')}.signature`;
  const base = { operatorKey: token, agentId: 'retired' };
  const creds = installWorkspaceRouting(server, base);
  installConnectionNotices(server, creds, '0.34.1');
  let migrated = false;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    return new Response(JSON.stringify(String(url).includes('connection-notices')
      ? { notices: [], assistantConnection: migrated }
      : { workspaces: [{ orgId: 'team', name: 'Team', agentId: 'survivor' }] }));
  });
  const tool = workspaceRouter(server)!.wrap('ziggs_chat_open', false, async () => ({ content: [{ type: 'text', text: JSON.stringify({ agentId: creds.agentId }) }] }));
  await readConnectionNotices(server);
  assert.equal(JSON.parse((await tool({})).content[0].text!).agentId, 'retired');
  migrated = true;
  await readConnectionNotices(server, true);
  assert.equal(JSON.parse((await tool({ orgId: 'team' })).content[0].text!).agentId, 'survivor');
});
