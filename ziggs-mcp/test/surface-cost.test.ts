import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mcpBriefNames, type Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import { catalogFor } from '../src/toolCatalog.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { DOORS, measureDoor, overBudget, type Door } from '../scripts/measure-surface.mts';

/**
 * ZIG-2116 — what connecting costs, held in CI.
 *
 * The connect text, each description and each door's whole tool list have a
 * budget (`scripts/measure-surface.mts`). Clients cut what is over theirs, so
 * a change that grows past a budget fails here, where someone has to raise the
 * number on purpose, instead of in a client where a rule silently goes missing.
 */
describe('connecting stays within budget (ZIG-2116)', () => {
  for (const door of DOORS) {
    it(`the ${door} door fits its budgets`, async () => {
      assert.deepEqual(overBudget(await measureDoor(door)), []);
    });
  }
});

const connectionKey = `test.${Buffer.from(JSON.stringify({ connectionClientId: 'c' })).toString('base64url')}.test`;

async function door(
  which: Door,
  cfg: Partial<ZiggsMcpConfig> = {},
): Promise<{ instructions: string; tools: Array<{ name: string; description: string; params: Set<string> }>; catalog: string[] }> {
  const server = createZiggsMcpServer(
    { operatorKey: which === 'directory' ? connectionKey : 'op', agentId: 'agent-1' } as unknown as Creds,
    { debugTools: false, directConnection: which === 'compact', ...cfg } as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'surface-cost', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const instructions = client.getInstructions() ?? '';
  const tools = (await client.listTools()).tools.map((t) => ({
    name: t.name,
    title: t.title ?? '',
    description: t.description ?? '',
    params: new Set(Object.keys((t.inputSchema as { properties?: object }).properties ?? {})),
    agreementId:
      (t.inputSchema as { properties?: { agreementId?: { description?: string } } }).properties?.agreementId
        ?.description ?? '',
  }));
  const catalog = catalogFor(server).map((e) => e.name);
  await client.close();
  return { instructions, tools, catalog };
}

describe('every description comes from a brief (ZIG-2116)', () => {
  it('each tool on either door has one, and no brief outlives its tool', async () => {
    const directory = await door('directory');
    const compact = await door('compact', { debugTools: true });
    const surface = new Set([
      ...directory.tools.map((t) => t.name),
      ...compact.tools.map((t) => t.name),
      ...compact.catalog,
    ]);
    // Registration throws for a tool with no brief, so reaching here means
    // every registered tool has one. What is left is a brief nobody uses.
    const stale = mcpBriefNames().filter((n) => !surface.has(n));
    assert.deepEqual(stale, [], `briefs for tools that are not registered: ${stale.join(', ')}`);
  });
});

/**
 * Fields a description may name that are not inputs of that tool: what a
 * call returns. A new name here is a deliberate decision, not a typo for a
 * parameter the tool would refuse.
 */
const RETURNED_FIELDS = new Set([
  'ackTo',
  'acceptsProposals',
  'approvalAction',
  'listingAgreementId',
  'notSearched',
  'orgId',
  'readPlan',
  'rosterSummary',
  'sessionChatCard',
  'shareUrl',
  'workBrief',
]);

describe('descriptions agree with the tools and with each other (ZIG-2111 / ZIG-2113)', () => {
  for (const which of DOORS) {
    it(`on the ${which} door, every option a description names is one the tool takes`, async () => {
      const { tools } = await door(which);
      const unknown: string[] = [];
      for (const t of tools)
        for (const [token] of t.description.matchAll(/\b[a-z]+[A-Z][A-Za-z]*\b/g))
          if (!t.params.has(token) && !RETURNED_FIELDS.has(token)) unknown.push(`${t.name}: ${token}`);
      assert.deepEqual(unknown, []);
    });
  }

  it('the directory door says one thing about the inbox: reads observe, a claim takes the lease', async () => {
    const { instructions, tools } = await door('directory');
    const text = [instructions, ...tools.map((t) => `${t.name}: ${t.description}`)];
    for (const line of text) {
      assert.doesNotMatch(line, /acquir/i, line);
      assert.doesNotMatch(line, /takes this identity|takes the mailbox|ownership away/i, line);
    }
    const claim = tools.find((t) => t.name === 'ziggs_inbox_claim')!.description;
    assert.match(claim, /Another host is refused \(INBOX_HOST_CONFLICT\)/);
    for (const name of ['ziggs_inbox', 'ziggs_inbox_peek'])
      assert.match(tools.find((t) => t.name === name)!.description, /no claim|claim the inbox/);
    const inbox = tools.find((t) => t.name === 'ziggs_inbox')!.description;
    assert.match(inbox, /No waitSeconds is the session start and is large/);
    assert.match(inbox, /waitSeconds returns only what is new/);
  });

  it('the compact door says its full read takes the lease and its peek does not', async () => {
    const { instructions, tools } = await door('compact');
    const inbox = tools.find((t) => t.name === 'ziggs_inbox')!.description;
    assert.match(inbox, /takes or renews this host’s lease/);
    assert.match(inbox, /No waitSeconds is the session start and is large/);
    assert.match(inbox, /waitSeconds returns only what is new/);
    assert.match(tools.find((t) => t.name === 'ziggs_inbox_peek')!.description, /Does not take the inbox lease/);
    for (const line of [instructions, ...tools.map((t) => t.description)])
      assert.doesNotMatch(line, /ziggs_inbox_claim|ownership away/, line);
  });

  for (const which of DOORS) {
    it(`on the ${which} door, defer hides a pending decision and park is gone (ZIG-2283)`, async () => {
      const { tools } = await door(which);
      assert.equal(tools.some((t) => t.name === 'ziggs_inbox_park'), false);
      const tool = tools.find((t) => t.name === 'ziggs_inbox_defer');
      assert.ok(tool);
      assert.equal(tool.title, 'Hide a pending decision from the inbox');
      assert.match(tool.description, /Hides one pending decision from the top of the inbox until it changes or is about to expire/);
      assert.doesNotMatch(`${tool.title} ${tool.description} ${tool.agreementId}`, /shout/i);
    });
  }
});
