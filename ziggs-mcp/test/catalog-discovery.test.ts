import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createZiggsMcpServer } from '../src/server.js';
import { registerZiggsTools } from '../src/tools.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { CATALOG_TOOLS, NATIVE_TOOLS } from '../src/surface.js';
import { SEARCH_ALIASES } from '../src/toolAliases.js';
import { callJson, surfaceToolNames, surfaceTools } from './support/surface.js';

/**
 * Finding a tool, and reaching it by name.
 *
 * ZIG-1441: names-first delivery made the catalog listing (name + title only)
 * the entire basis for picking a verb, and searching the plain-English word for
 * what you want returned the wrong tool or nothing.
 *
 * ZIG-1440: a name that is in the catalog but not natively listed used to be
 * uncallable, and the refusal came from inside the MCP SDK ("Tool <name>
 * disabled") where we cannot reword it. Anything holding a name hit a wall.
 */

async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'catalog-discovery', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

async function search(client: Client, needle: string): Promise<string[]> {
  const out = callJson<{ tools: Array<{ name: string }> }>(
    await client.callTool({ name: 'ziggs_tools', arguments: { search: needle } }),
  );
  return out.tools.map((t) => t.name);
}

describe('finding a tool by the word a caller would use (ZIG-1441)', () => {
  it('finds contact and owner access requests using ordinary intent words', async () => {
    const client = await connectedClient();
    for (const query of ['grant', 'permission', 'restricted document']) {
      assert.ok((await search(client, query)).includes('ziggs_access_request'), query);
    }
    for (const query of ['contact teammate', 'create chat', 'start conversation', 'room', 'group', 'channel', 'invite', 'add people']) {
      assert.ok((await search(client, query)).includes('ziggs_chat_open'), query);
    }
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'ziggs_chat_open'), 'starting contact is available alongside sending');
    await client.close();
  });
  it('"hire" lands on the buy verb, not on hand-off', async () => {
    const client = await connectedClient();
    const found = await search(client, 'hire');
    assert.ok(
      found.includes('ziggs_agreement_buy'),
      `"hire" must reach ziggs_agreement_buy, got ${found.join(', ')}`,
    );
    assert.ok(
      found.includes('ziggs_agreement_claim'),
      `"hire" must reach ziggs_agreement_claim, got ${found.join(', ')}`,
    );
    await client.close();
  });

  it('the retired names still route to the verbs that replaced them', async () => {
    const client = await connectedClient();
    assert.ok((await search(client, 'commission')).includes('ziggs_agreement_buy'));
    assert.ok((await search(client, 'quest')).includes('ziggs_agreement_request'));
    await client.close();
  });

  it('every alias names a tool that exists', async () => {
    const client = await connectedClient();
    const surface = new Set(await surfaceToolNames(client));
    for (const name of Object.keys(SEARCH_ALIASES)) {
      assert.ok(surface.has(name), `alias target ${name} is not on the surface`);
    }
    await client.close();
  });

  it('every alias actually finds its tool', async () => {
    const client = await connectedClient();
    for (const [name, aliases] of Object.entries(SEARCH_ALIASES)) {
      for (const alias of aliases) {
        const found = await search(client, alias);
        assert.ok(
          found.includes(name),
          `searching "${alias}" did not return ${name} (got ${found.join(', ') || 'nothing'})`,
        );
      }
    }
    await client.close();
  });

  it('no two agreement verbs share a title', async () => {
    const client = await connectedClient();
    const rows = callJson<{ tools: Array<{ name: string; title: string }> }>(
      await client.callTool({
        name: 'ziggs_tools',
        arguments: { search: 'agreement_' },
      }),
    ).tools;
    const titles = rows.map((r) => r.title);
    assert.equal(
      new Set(titles).size,
      titles.length,
      `two agreement tools share a title: ${titles.join(' | ')}`,
    );
    await client.close();
  });
});

describe('ziggs_inbox_ack says what the server refuses (ZIG-2032)', () => {
  it('an empty handled list is safe when nothing is assigned', async () => {
    const client = await connectedClient();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'ziggs_inbox_ack');
    assert.ok(tool, 'ziggs_inbox_ack is registered');
    assert.match(tool.description ?? '', /INBOX_ACK_UNHANDLED/);
    assert.match(tool.description ?? '', /empty is safe when none is/);
    await client.close();
  });
});

describe('a name in the catalog stays callable (ZIG-1440)', () => {
  afterEach(() => mock.restoreAll());

  it('lists only the native set plus the catalog tools', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [...NATIVE_TOOLS, ...CATALOG_TOOLS].sort(),
    );
    await client.close();
  });

  it('a catalog tool called directly by name runs instead of refusing', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    assert.ok(
      !tools.some((t) => t.name === 'ziggs_agreement_list'),
      'precondition: ziggs_agreement_list is catalog-only, not natively listed',
    );

    // A wrong argument is the cheap proof the call REACHED the tool: a disabled
    // tool refuses before validation, so a schema complaint can only come from
    // the tool itself.
    const result = (await client.callTool({
      name: 'ziggs_agreement_list',
      arguments: { nonsenseParam: 1 },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    const text = result.content.map((c) => c.text ?? '').join('');
    assert.match(text, /nonsenseParam/, `expected a named refusal, got: ${text}`);
    assert.doesNotMatch(text, /disabled/i, 'the dead-end error is back');
    await client.close();
  });
});

describe('a rare capability is found through the catalog, not made native', () => {
  it('search + describe reach subcontract, cancel, and access explain', async () => {
    const client = await connectedClient();
    const listed = await client.listTools();
    assert.ok(
      !listed.tools.some((t) => t.name === 'ziggs_agreement_subcontract'),
      'precondition: subcontract stays catalog-only',
    );

    const subcontract = await search(client, 'subcontract');
    assert.ok(
      subcontract.includes('ziggs_agreement_subcontract'),
      `"subcontract" must reach ziggs_agreement_subcontract, got ${subcontract.join(', ')}`,
    );
    assert.ok(
      !subcontract.includes('ziggs_agreement_broker'),
      '"subcontract" is the parent-rail verb, not broker',
    );

    const cancel = await search(client, 'cancel');
    assert.ok(cancel.includes('ziggs_task_cancel'), `cancel → ${cancel.join(', ')}`);

    const explain = await search(client, 'explain');
    assert.ok(
      explain.includes('ziggs_access_explain'),
      `explain → ${explain.join(', ')}`,
    );

    const described = callJson<{
      tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
    }>(
      await client.callTool({
        name: 'ziggs_tools',
        arguments: {
          describe: [
            'ziggs_agreement_subcontract',
            'ziggs_task_cancel',
            'ziggs_access_explain',
          ],
        },
      }),
    ).tools;
    const byName = new Map(described.map((t) => [t.name, t]));
    assert.ok(byName.get('ziggs_agreement_subcontract')?.inputSchema?.properties?.parentAgreementId);
    assert.ok(byName.get('ziggs_task_cancel')?.inputSchema?.properties?.taskId);
    assert.ok(byName.get('ziggs_access_explain')?.inputSchema?.properties);

    await client.close();
  });

  it('cannot discover or dispatch standalone point movement or point purchases', async () => {
    const client = await connectedClient();
    const names = await surfaceToolNames(client);
    assert.ok(names.includes('ziggs_payment_balance'));
    assert.ok(!names.some(name => /checkout|onramp|buy_points|purchase_points/.test(name)));
    for (const tool of ['ziggs_payment_transfer', 'ziggs_payment_hold', 'ziggs_payment_release', 'ziggs_payment_create_intent', 'ziggs_payment_checkout']) {
      assert.ok(!names.includes(tool));
      for (const name of ['ziggs_tool_write', 'ziggs_tool_read']) {
        const response = await client.callTool({ name, arguments: { tool, args: { amount: 100, toWalletId: 'other', agreementId: 'claimed-work' } } });
        assert.match(JSON.stringify(response), /No such tool|not found|unknown tool/i);
      }
      const direct = await client.callTool({ name: tool, arguments: {} });
      assert.match(JSON.stringify(direct), /No such tool|not found|unknown tool/i);
    }
    await client.close();
  });

  it('connection proxy and payment movement stay off the listed door', async () => {
    const client = await connectedClient();
    const names = await surfaceToolNames(client);
    for (const banned of [
      'ziggs_connection_proxy',
      'ziggs_connection_request',
      'ziggs_mcp_tool_call',
      'ziggs_payment_transfer',
      'ziggs_payment_hold',
      'ziggs_payment_release',
    ]) {
      assert.ok(!names.includes(banned), `${banned} must not be on the listed catalog`);
    }
    assert.ok(names.includes('ziggs_payment_balance'), 'balance read stays findable');

    const proxySearch = await search(client, 'connection_proxy');
    assert.ok(
      !proxySearch.includes('ziggs_connection_proxy'),
      'search must not invent the excluded proxy',
    );

    const dispatch = callJson<{ error?: string }>(
      await client.callTool({
        name: 'ziggs_tool_write',
        arguments: { tool: 'ziggs_connection_proxy', args: {} },
      }),
    );
    const text = JSON.stringify(dispatch);
    assert.match(text, /No such tool|ziggs_connection_proxy/, text);
    assert.doesNotMatch(text, /disabled/i);

    await client.close();
  });
});

describe('a name in the catalog stays callable (ZIG-1440)', () => {
  afterEach(() => mock.restoreAll());

  it('EVERY tool on the surface is callable by its own name', async () => {
    // The guard ZIG-1440 asked for, from the other end. The old guard checked
    // that a name in a script EXISTS, and existence stopped implying
    // callability the day catalog tools were disabled — four scripts broke and
    // it stayed green. Nothing is disabled now, so the two are the same thing
    // again, and this is what keeps them that way: re-introduce a `.disable()`
    // and this fails in CI rather than in someone's script.
    //
    // Probing with an unknown key reaches validation and stops there — every
    // tool's schema is `additionalProperties: false` (unknown-params.test.ts
    // pins that), so no handler runs and nothing touches the wire.
    mock.method(globalThis, 'fetch', async (url: string) => {
      throw new Error(`a handler ran on an invalid-params probe: ${String(url)}`);
    });
    const client = await connectedClient();
    const names = (await surfaceTools(client)).map((t) => t.name);
    assert.ok(names.length > 10, 'expected the full tool surface');

    const unreachable: string[] = [];
    for (const name of names) {
      const result = (await client.callTool({
        name,
        arguments: { __callabilityProbe: true },
      })) as { content?: Array<{ text?: string }> };
      const text = (result.content ?? []).map((c) => c.text ?? '').join('');
      // A refusal that names the offending key came from the tool's own schema,
      // which means the call reached the tool.
      if (!/__callabilityProbe/.test(text)) unreachable.push(`${name}: ${text.slice(0, 120)}`);
    }
    assert.deepEqual(
      unreachable,
      [],
      `these names are listed or catalogued but not callable:\n - ${unreachable.join('\n - ')}`,
    );
    await client.close();
  });

  it('the listed schemas are the ones the SDK builds, not a rebuild of them', async () => {
    // The listing filters the SDK's own response. If it were hand-built, the
    // shape could drift on exactly the tools every caller loads, so compare
    // against a server with no policy applied.
    const filtered = await connectedClient();
    // Registration without the policy: the same tools, listed the SDK's way.
    const unfiltered = new McpServer({ name: 'ziggs', version: '0.0.0' });
    registerZiggsTools(
      unfiltered,
      { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
      {} as unknown as ZiggsMcpConfig,
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const raw = new Client({ name: 'unfiltered', version: '0.0.0' });
    await Promise.all([unfiltered.connect(st), raw.connect(ct)]);

    const byName = new Map(
      (await raw.listTools()).tools.map((t) => [t.name, t] as const),
    );
    for (const t of (await filtered.listTools()).tools) {
      if (CATALOG_TOOLS.includes(t.name)) continue;
      assert.deepEqual(t, byName.get(t.name), `${t.name} drifted from the SDK's own entry`);
    }
    await filtered.close();
    await raw.close();
  });
});

describe('each catalog row says how to call it', () => {
  it('every row has a call line that matches its lane and native flag', async () => {
    const client = await connectedClient();
    const listing = callJson<{
      tools: Array<{
        name: string;
        readOnly?: boolean;
        destructive?: boolean;
        native?: boolean;
        call?: string;
      }>;
    }>(await client.callTool({ name: 'ziggs_tools', arguments: {} }));
    const native = new Set<string>(NATIVE_TOOLS);
    for (const row of listing.tools) {
      assert.equal(typeof row.call, 'string', `${row.name} is missing call`);
      assert.equal(
        row.native === true,
        native.has(row.name),
        `${row.name} native=${row.native} vs NATIVE_TOOLS`,
      );
      if (row.native) {
        assert.match(row.call!, new RegExp(`call it by name: ${row.name}`));
        const lane = row.readOnly ? 'ziggs_tool_read' : 'ziggs_tool_write';
        assert.match(row.call!, new RegExp(lane));
      } else {
        const lane = row.readOnly ? 'ziggs_tool_read' : 'ziggs_tool_write';
        assert.match(row.call!, new RegExp(`call via ${lane}`));
      }
    }
    await client.close();
  });

  it('describing a tool gives its call line: native tools by name, the rest through their lane', async () => {
    const client = await connectedClient();
    const described = callJson<{
      tools: Array<{ name: string; call?: string; native?: boolean }>;
      next?: string;
    }>(
      await client.callTool({
        name: 'ziggs_tools',
        arguments: {
          describe: [
            'ziggs_chat_send',
            'ziggs_agreement_revoke',
            'ziggs_agreement_list',
          ],
        },
      }),
    );
    assert.equal(described.next, undefined);
    const byName = new Map(described.tools.map((t) => [t.name, t]));
    const send = byName.get('ziggs_chat_send');
    assert.equal(send?.native, true);
    assert.match(send?.call ?? '', /ziggs_chat_send/);
    const revoke = byName.get('ziggs_agreement_revoke');
    assert.equal(revoke?.native, true);
    assert.match(revoke?.call ?? '', /call it by name: ziggs_agreement_revoke/);
    assert.match(revoke?.call ?? '', /ziggs_tool_write/);
    const list = byName.get('ziggs_agreement_list');
    assert.equal(list?.native, undefined);
    assert.match(list?.call ?? '', /ziggs_tool_read/);
    await client.close();
  });

  it('catalog native flags agree with the capability-map exposure column', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const map = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '../../docs/capability-map.md'),
      'utf8',
    );
    // One exposure column per configuration. This client holds a
    // self-configured operator key, so it compares against `direct`; the
    // consent column lists every permitted tool natively (ZIG-2103) and
    // describes no catalog at all.
    const exposed = new Map<string, string>();
    // Two tables start with a Tool column; only the first has exposure columns.
    let directColumn = -1;
    let sawDirect = false;
    for (const line of map.split('\n')) {
      const cells = line.split('|').map((cell) => cell.trim());
      if (cells[1] === 'Tool') {
        directColumn = cells.indexOf('direct');
        sawDirect ||= directColumn > 0;
      }
      const m = cells[1]?.match(/^`(ziggs_[a-z0-9_]+)`$/);
      if (m && directColumn > 0) exposed.set(m[1], cells[directColumn]);
    }
    assert.ok(sawDirect, 'capability map has a direct column');
    const client = await connectedClient();
    const listing = callJson<{
      tools: Array<{ name: string; native?: boolean }>;
    }>(await client.callTool({ name: 'ziggs_tools', arguments: {} }));
    const drift: string[] = [];
    for (const row of listing.tools) {
      const col = exposed.get(row.name);
      if (!col || col === '-') continue;
      const mappedNative = col === 'n';
      const listedNative = row.native === true;
      if (mappedNative !== listedNative) {
        drift.push(`${row.name}: map=${col} catalog native=${listedNative}`);
      }
    }
    assert.deepEqual(drift, []);
    await client.close();
  });
});
