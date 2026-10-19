import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import {
  CATALOG_TOOLS,
  NATIVE_TOOLS,
} from '../src/surface.js';
import { surfaceTools } from './support/surface.js';

/**
 * ZIG-941 #7 — the env-gated lean session-start tool tier. With
 * ZIGGS_MCP_CORE_ONLY unset (cfg.coreOnly false) every tool registers as
 * before; when set, the heavy groups (payments, links, connections) are
 * skipped and only the core everyday verbs remain.
 *
 * ZIG-1390 changed what "registers" means for a caller: only the everyday set
 * is listed natively, and the rest is reached through ziggs_tools and the two
 * dispatchers, ziggs_tool_read / ziggs_tool_write.
 * Both tiers are still real, and they compose — core-only removes tools from
 * the surface entirely, while the catalog decides how the survivors are
 * delivered. So this reads the whole surface, not just tools/list.
 */
async function toolNames(cfg: Partial<ZiggsMcpConfig>): Promise<Set<string>> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    cfg as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'core-only-test', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const names = new Set((await surfaceTools(client)).map((t) => t.name));
  await client.close();
  return names;
}

async function nativeNames(cfg: Partial<ZiggsMcpConfig>): Promise<Set<string>> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    cfg as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'native-test', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const { tools } = await client.listTools();
  await client.close();
  return new Set(tools.map((t) => t.name));
}

// The heavy groups the lean tier drops. Publishing/claiming/link-proposing
// ride the agreement verbs now (ZIG-1021/1022), so they live in CORE_TOOLS.
const HEAVY_TOOLS = [
  // payments (paymentTools.ts) — ZIG-1366 cut the movement verbs from every
  // tier, so the balance read is all that is left to gate here.
  'ziggs_payment_balance',
  // links (trustTools.ts)
  'ziggs_link_propose',
  'ziggs_link_list',
  // introductions (trustTools.ts) — ZIG-1595, registered with the link rail
  'ziggs_introduction_mint',
  'ziggs_introduction_redeem',
  'ziggs_introduction_list',
  'ziggs_introduction_revoke',
  // a person not on Ziggs yet (trustTools.ts), registered with the link rail
  'ziggs_party_note',
  // connections (tools.ts) — only the lister. Everything that uses or asks for
  // a connection registers behind directConnection, and this suite builds the
  // listed surface (no directConnection), so none of it is here.
  'ziggs_connection_list',
];

// The core everyday/session-start tools the lean tier keeps.
const CORE_TOOLS = [
  'ziggs_auth_status',
  'ziggs_org_list',
  'ziggs_inbox',
  'ziggs_inbox_peek',
  'ziggs_inbox_changes',
  'ziggs_context_snapshot',
  'ziggs_open',
  'ziggs_access_explain',
  'ziggs_context_read',
  'ziggs_context_expand_reach',
  'ziggs_context_discover_grantable',
  'ziggs_grant_list',
  'ziggs_chat_list',
  'ziggs_chat_open',
  'ziggs_chat_send',
  'ziggs_agreement_list',
  'ziggs_agreement_get',
  'ziggs_agreement_buy',
  'ziggs_agreement_bid',
  'ziggs_agreement_broker',
  'ziggs_agreement_request',
  'ziggs_agreement_handoff',
  'ziggs_agreement_respond',
  'ziggs_agreement_claim',
  // ZIG-1280 — browse and claim travel together, both directions.
  'ziggs_marketplace_view',
  'ziggs_agreement_subcontract',
  'ziggs_agreement_counter',
  'ziggs_agreement_revoke',
  'ziggs_agreement_fulfill',
  'ziggs_task_create',
  'ziggs_task_set_result',
  'ziggs_task_replace_plan',
  'ziggs_task_update_steps',
  'ziggs_task_list',
  'ziggs_task_cancel',
  'ziggs_task_get',
  'ziggs_artifact_record',
  'ziggs_context_delegate',
  'ziggs_context_revoke_grant',
  'ziggs_agent_search',
  'ziggs_agent_get',
];

describe('lean session-start tool tier (ZIG-941 #7)', () => {
  it('flag unset: the core and heavy tools all register (behaviour unchanged)', async () => {
    const names = await toolNames({ debugTools: false });
    for (const t of [...CORE_TOOLS, ...HEAVY_TOOLS]) {
      assert.ok(names.has(t), `expected ${t} in full mode`);
    }
  });

  it('core-only: skips exactly the heavy groups, keeps the core tier', async () => {
    const full = await toolNames({ debugTools: false });
    const core = await toolNames({ debugTools: false, coreOnly: true });

    // Core-only is a strict, smaller subset of the full surface.
    for (const t of core) {
      assert.ok(full.has(t), `${t} is in core-only but not full`);
    }
    assert.ok(core.size < full.size, 'core-only should register fewer tools');

    // Heavy groups are gone; the core tier survives.
    for (const t of HEAVY_TOOLS) {
      assert.equal(core.has(t), false, `${t} must be skipped in core-only mode`);
    }
    for (const t of CORE_TOOLS) {
      assert.ok(core.has(t), `core tool ${t} must survive core-only mode`);
    }

    // The ONLY difference is exactly the heavy groups — asserted by set, not by
    // a magic count, so adding an unrelated core tool later can't break this
    // (and adding a heavy tool without listing it here will).
    const dropped = [...full].filter((t) => !core.has(t)).sort();
    assert.deepEqual(dropped, [...HEAVY_TOOLS].sort());
  });
});

describe('names-first delivery (ZIG-1390)', () => {
  it('a cold connection lists only the everyday set plus the catalog tools', async () => {
    const native = await nativeNames({ debugTools: false });
    assert.deepEqual(
      [...native].sort(),
      [...NATIVE_TOOLS, ...CATALOG_TOOLS].sort(),
    );
  });

  it('every tool that exists is still named, and none is only named', async () => {
    const all = await toolNames({ debugTools: false });
    const native = await nativeNames({ debugTools: false });
    // Nothing is hidden: the catalog is a delivery change, not a filter.
    assert.ok(all.size > native.size, 'the catalog should carry the rest');
    for (const t of CORE_TOOLS) {
      assert.ok(all.has(t), `${t} must stay findable through the catalog`);
    }
  });

  // A host reads `destructiveHint` off the tool it is asked to run, at
  // tools/list time. Most writes cannot be taken back, so the write dispatcher
  // carries the hint itself: a host that asks before destructive tools asks
  // before any dispatched write, and no tool has to be native for that.
  it('the write dispatcher is destructive and carries irreversible tools', async () => {
    const server = createZiggsMcpServer(
      { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
      { debugTools: false } as ZiggsMcpConfig,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'destructive-dispatch', version: '0.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    const writeLane = tools.find((t) => t.name === 'ziggs_tool_write')?.annotations as
      | { readOnlyHint?: boolean; destructiveHint?: boolean }
      | undefined;
    assert.deepEqual([writeLane?.readOnlyHint, writeLane?.destructiveHint], [false, true]);
    const readLane = tools.find((t) => t.name === 'ziggs_tool_read')?.annotations as
      | { readOnlyHint?: boolean; destructiveHint?: boolean }
      | undefined;
    assert.deepEqual([readLane?.readOnlyHint, readLane?.destructiveHint], [true, false]);
    // A destructive catalog tool dispatches like any write: the refusal, if
    // any, comes from the tool itself, never from the lane.
    const result = await client.callTool({
      name: 'ziggs_tool_write',
      arguments: { tool: 'ziggs_agreement_fulfill', args: { agreementId: 'agr_1' } },
    });
    const text = (result as { content: Array<{ text?: string }> }).content
      .map((c) => c.text ?? '')
      .join('');
    assert.doesNotMatch(text, /cannot be called through|call it by name/);
    await client.close();
  });

  // A host and a store reviewer both read what a tool is from its annotation.
  // One dispatcher for reads and writes was marked write for all of them, so
  // each lane carries one kind of tool and names the other lane when it refuses.
  it('each dispatcher carries one lane and names the other lane when it refuses', async () => {
    const server = createZiggsMcpServer(
      { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
      { debugTools: false } as ZiggsMcpConfig,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'lanes', version: '0.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools: listed } = await client.listTools();
    const native = new Set(listed.map((t) => t.name));
    const readLane = listed.find((t) => t.name === 'ziggs_tool_read');
    const writeLane = listed.find((t) => t.name === 'ziggs_tool_write');
    assert.equal(readLane?.annotations?.readOnlyHint, true, 'the read dispatcher is annotated read-only');
    assert.equal(writeLane?.annotations?.readOnlyHint, false, 'the write dispatcher is annotated as a write');

    const catalog = (await surfaceTools(client)).filter((t) => !native.has(t.name));
    const aRead = catalog.find(
      (t) => (t.annotations as { readOnlyHint?: boolean }).readOnlyHint === true,
    );
    const aWrite = catalog.find((t) => {
      const a = t.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean };
      return a.readOnlyHint !== true && !a.destructiveHint;
    });
    assert.ok(aRead && aWrite, 'the catalog has both lanes to test with');

    const text = (result: unknown) =>
      (result as { content: Array<{ text?: string }> }).content
        .map((c) => c.text ?? '')
        .join('');

    const wrongLaneForRead = await client.callTool({
      name: 'ziggs_tool_write',
      arguments: { tool: aRead!.name, args: {} },
    });
    assert.equal((wrongLaneForRead as { isError?: boolean }).isError, true);
    assert.match(text(wrongLaneForRead), /read-only/);
    assert.match(text(wrongLaneForRead), /ziggs_tool_read/);

    const wrongLaneForWrite = await client.callTool({
      name: 'ziggs_tool_read',
      arguments: { tool: aWrite!.name, args: {} },
    });
    assert.equal((wrongLaneForWrite as { isError?: boolean }).isError, true);
    assert.match(text(wrongLaneForWrite), /ziggs_tool_write/);
    await client.close();
  });

  it('the catalog listing costs a fraction of the full schemas', async () => {
    const server = createZiggsMcpServer(
      { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
      { debugTools: false } as ZiggsMcpConfig,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'catalog-cost', version: '0.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    const onConnect = JSON.stringify(tools).length;
    const everything = JSON.stringify(await surfaceTools(client)).length;
    await client.close();
    // The measured baseline before this change was ~80k characters on connect.
    // Guard the shape of the win, not an exact number that will drift.
    assert.ok(
      onConnect < everything / 4,
      `connecting should cost far less than the whole surface (${onConnect} vs ${everything})`,
    );
  });
});
