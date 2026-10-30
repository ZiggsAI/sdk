import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createZiggsMcpServer } from '../src/server.js';
import { INBOX_CARD_HTML, INBOX_CARD_MIME, INBOX_CARD_URI, inboxCardData } from '../src/inboxCard.js';
import type { ZiggsMcpConfig } from '../src/config.js';

const claims = (extra: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify({ type: 'operator', keyId: 'key', ownerId: 'owner', ...extra })).toString('base64url')}.test`;
/** A browser-consent connection, the door Claude and ChatGPT use. */
const connectionKey = claims({ connectionClientId: 'client', issuedVia: 'mcp_oauth' });

async function connect() {
  const server = createZiggsMcpServer({ operatorKey: connectionKey, agentId: '', instanceId: 'test-host' }, {
    directConnection: false, coreOnly: true, debugTools: false,
  } as ZiggsMcpConfig);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'Claude', version: 'test' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}
afterEach(() => mock.restoreAll());

const snapshot = {
  deliveries: [],
  workspaces: [{ orgId: 'org-1', name: 'Team' }],
  agentIds: ['assistant-1'],
  proposalsAwaitingMe: [
    { agreementId: 'AGR1', title: 'Write the launch note', proposerDisplayName: 'Dana', proposedAt: new Date().toISOString(), status: 'pending' },
  ],
  tasksAwaitingMe: [
    { taskId: 'T1', agreementId: 'AGR2', title: 'Review the deck', state: 'active', plan: { steps: [{ status: 'completed' }, { status: 'pending' }] } },
  ],
};

describe('the inbox card (MCP Apps)', () => {
  it('lists ziggs_inbox_show on the remote door, linked to its view, read-only', async () => {
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'ziggs_inbox_show');
      assert.ok(tool, 'listed natively, not only through the catalog');
      assert.deepEqual(tool._meta, { ui: { resourceUri: INBOX_CARD_URI } });
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    } finally { await client.close(); }
  });

  it('serves the view as an MCP Apps resource that loads nothing from outside', async () => {
    const client = await connect();
    try {
      const read = await client.readResource({ uri: INBOX_CARD_URI });
      const [content] = read.contents as Array<{ uri: string; mimeType: string; text: string }>;
      assert.equal(content.uri, INBOX_CARD_URI);
      assert.equal(content.mimeType, INBOX_CARD_MIME);
      assert.equal(content.text, INBOX_CARD_HTML);
      // No script, style, image or frame from anywhere else, and no HTML parsed from data.
      assert.doesNotMatch(content.text, /<(script|link|img|iframe)[^>]+(src|href)=/i);
      assert.doesNotMatch(content.text, /innerHTML|insertAdjacentHTML|document\.write/);
      // The protocol it speaks, and the only thing its buttons do.
      // size-changed: a host sizes the frame from it, and leaves it at zero height without it.
      for (const method of ['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/tool-result', 'ui/open-link', 'ui/notifications/size-changed'])
        assert.ok(content.text.includes(method), method);
      assert.doesNotMatch(content.text, /tools\/call/);
    } finally { await client.close(); }
  });

  it('reads a snapshot and returns the card as text and as structured data', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (input: unknown) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path.endsWith('/connection-notices'))
        return new Response(JSON.stringify({ notices: [], assistantConnection: true }));
      if (path.endsWith('/inbox/snapshot')) return new Response(JSON.stringify(snapshot));
      return new Response('{}', { status: 404 });
    });
    const client = await connect();
    try {
      const result = await client.callTool({ name: 'ziggs_inbox_show', arguments: {} });
      assert.notEqual(result.isError, true);
      assert.ok(calls.some((path) => path.endsWith('/inbox/snapshot')), 'a snapshot read');
      assert.equal(calls.some((path) => /\/inbox$/.test(path)), false, 'never the acquiring read');
      const text = (result.content as Array<{ text: string }>)[0].text;
      assert.match(text, /Write the launch note/);
      const card = result.structuredContent as ReturnType<typeof inboxCardData>;
      assert.equal(card.waitingOnYou.length, 1);
      assert.equal(card.waitingOnYou[0].title, 'Write the launch note');
      assert.match(card.waitingOnYou[0].url, /^https:\/\//);
      assert.equal(card.yourWork.length, 1);
      assert.equal(card.yourWork[0].title, 'Review the deck');
    } finally { await client.close(); }
  });

  it('puts a plan waiting on the person under Waiting on you, with Review', async () => {
    mock.method(globalThis, 'fetch', async (input: unknown) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/connection-notices'))
        return new Response(JSON.stringify({ notices: [], assistantConnection: true }));
      if (path.endsWith('/inbox/snapshot'))
        return new Response(JSON.stringify({
          ...snapshot,
          planAcksAwaitingMe: [
            { taskId: 'T1', agreementId: 'AGR2', title: 'Review the deck', scope: 'execution', updatedAt: null },
          ],
          truncatedPlanAcks: 0,
        }));
      return new Response('{}', { status: 404 });
    });
    const client = await connect();
    try {
      const result = await client.callTool({ name: 'ziggs_inbox_show', arguments: {} });
      const card = result.structuredContent as ReturnType<typeof inboxCardData>;
      const plan = card.waitingOnYou.find((item) => item.kind === 'plan_ack');
      assert.ok(plan, 'listed as waiting on you');
      assert.equal(plan.title, 'Review the deck');
      assert.match(plan.url, /\/app\/agreements\/AGR2$/);
      assert.deepEqual(card.yourWork, [], 'not also listed as work');
      assert.match(INBOX_CARD_HTML, /"plan_ack" \? "Plan"/);
    } finally { await client.close(); }
  });

  it('says nothing is waiting, as text, when nothing is', () => {
    const card = inboxCardData({ decisions: [], activeWork: [], notice: 'No pending decisions or active tasks.' });
    assert.deepEqual(card, { waitingOnYou: [], moreWaiting: 0, yourWork: [], allUrl: null });
  });
});
