import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import {
  PROTOCOL_TOOLS,
  DISCOVERY_TOOLS,
  MARKETPLACE_TOOLS,
  PAYMENT_TOOLS,
  CONNECTION_TOOLS,
  CONTEXT_TOOLS,
  GRANTS_TOOLS,
  LINK_TOOLS,
  ARTIFACT_TOOLS,
  CHAT_TOOLS,
  CLAUDE_SDK_TOOLS,
} from '@ziggs-ai/agent-sdk';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { PROTOCOL, renderInstructions } from '../src/protocol/delegateProtocol.js';
import { surfaceTools } from './support/surface.js';

/**
 * ZIG-1025 — descriptions can only reference tools that exist.
 *
 * Tool descriptions hand-type sibling tool names ("see ziggs_connection_list",
 * "close the task with ziggs_task_set_result") across both surfaces, plus the
 * server instructions and the PROTOCOL const. Every rename can orphan one
 * silently — the agent gets told to call a tool that no longer exists. This
 * guard extracts every tool-name-shaped token from every description and
 * fails unless it is a registered tool name on that surface.
 *
 * ZIG-1112 extends it to `scripts/`. The rail_verb rename swept descriptions,
 * instructions and PROTOCOL but not the smoke scripts, and this guard could not
 * see them — so two wired smokes called removed tool names and failed outright,
 * and a third asserted a tool was ABSENT from a restricted tier using a name
 * that no longer exists anywhere, passing vacuously while testing nothing.
 */

type SdkTool = {
  schema: { function: { name: string; description?: string; parameters?: unknown } };
};

const SDK_BUNDLES: ReadonlyArray<ReadonlyArray<SdkTool>> = [
  PROTOCOL_TOOLS,
  DISCOVERY_TOOLS,
  MARKETPLACE_TOOLS,
  PAYMENT_TOOLS,
  CONNECTION_TOOLS,
  CONTEXT_TOOLS,
  GRANTS_TOOLS,
  LINK_TOOLS,
  ARTIFACT_TOOLS,
  CHAT_TOOLS,
  CLAUDE_SDK_TOOLS,
] as ReadonlyArray<ReadonlyArray<SdkTool>>;

/** Rails whose `<rail>_...` tokens count as tool references on the SDK side. */
const SDK_RAIL_PREFIXES = [
  'agreement_',
  'task_',
  'context_',
  'grant_',
  'agent_',
  'chat_',
  'artifact_',
  'connection_',
  'link_',
  'org_',
  'payment_',
  'marketplace_',
];

/** Snake-case tokens that share a rail prefix but are data/params, not tools. */
const NON_TOOL_TOKENS = new Set([
  // ids / params / fields that read like rail tokens
  'agreement_lifecycle',
  'task_result',
  // A `sources` entry kind: what a write drew on, not a tool.
  'task_plan_step',
  'chat_id',
  'agent_id',
  'org_id',
  'grant_id',
  'connection_id',
  'link_id',
]);

function extractMcpTokens(text: string): string[] {
  return [...text.matchAll(/\bziggs_\w+\b/g)].map((m) => m[0]);
}

function extractSdkTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
    const token = match[0];
    if (token.startsWith('ziggs_')) continue; // MCP-name references checked on the MCP side
    if (NON_TOOL_TOKENS.has(token)) continue;
    if (SDK_RAIL_PREFIXES.some((p) => token.startsWith(p))) tokens.add(token);
  }
  return [...tokens];
}

async function mcpTools(
  cfg: Partial<ZiggsMcpConfig> = {},
): Promise<Array<{ name: string; description?: string }>> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    { debugTools: false, ...cfg } as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'crossref-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = await surfaceTools(client);
  await client.close();
  return tools;
}

/**
 * ZIG-2116 — the long protocol and the skill ship on both doors: the OAuth
 * (directory) door, which lists every operation and adds ziggs_inbox_claim,
 * and the key-based doors. A name is real when either door registers it.
 */
async function directoryTools(): Promise<Array<{ name: string; description?: string }>> {
  const connectionKey = `test.${Buffer.from(JSON.stringify({ connectionClientId: 'crossref' })).toString('base64url')}.test`;
  const server = createZiggsMcpServer(
    { operatorKey: connectionKey, agentId: 'agent-1' } as unknown as Creds,
    { debugTools: false, directConnection: false } as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'crossref-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = await surfaceTools(client);
  await client.close();
  return tools;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Script files that drive the MCP surface by tool name. Read as text rather than
 * imported — most are .mjs smokes with live side effects.
 */
function scriptSources(): Array<{ path: string; text: string }> {
  const dir = join(REPO_ROOT, 'scripts');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') || f.endsWith('.ts'))
    .map((f) => ({ path: `scripts/${f}`, text: readFileSync(join(dir, f), 'utf8') }))
    .filter((f) => f.text.includes('ziggs_'));
}

/**
 * The skill we publish. It names tools throughout, and it is read by a model
 * rather than by a compiler, so a tool it names that no longer exists is a
 * documented instruction to make a call that fails.
 *
 * This was not scanned before, and it drifted: the skill kept sending agents to
 * a session-start tool that had been folded away, and its payments page
 * documented a rail that no longer exists.
 */
function skillSources(): Array<{ path: string; text: string }> {
  const dir = join(REPO_ROOT, 'ziggs-mcp/skills');
  const out: Array<{ path: string; text: string }> = [];
  const walk = (d: string, rel: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(full, path);
      else {
        const text = readFileSync(full, 'utf8');
        if (text.includes('ziggs_')) out.push({ path, text });
      }
    }
  };
  walk(dir, 'ziggs-mcp/skills');
  return out;
}

describe('description cross-reference guard (ZIG-1025)', () => {
  it('every ziggs_* token in MCP descriptions, server instructions, and the PROTOCOL const is a registered MCP tool', async () => {
    const tools = await mcpTools();
    const registered = new Set(tools.map((t) => t.name));
    const orphans: string[] = [];

    for (const tool of tools) {
      for (const token of extractMcpTokens(tool.description ?? '')) {
        if (!registered.has(token)) orphans.push(`${token} (referenced by ${tool.name})`);
      }
    }
    // The long protocol is the skill's source, read on either door.
    const eitherDoor = new Set([
      ...registered,
      ...(await directoryTools()).map((t) => t.name),
    ]);
    for (const token of extractMcpTokens(renderInstructions())) {
      if (!eitherDoor.has(token)) orphans.push(`${token} (referenced by server instructions)`);
    }
    for (const [key, fragment] of Object.entries(PROTOCOL)) {
      for (const token of extractMcpTokens(String(fragment))) {
        if (!eitherDoor.has(token)) orphans.push(`${token} (referenced by PROTOCOL.${key})`);
      }
    }

    assert.deepEqual(
      [...new Set(orphans)],
      [],
      `descriptions reference tools that do not exist:\n - ${[...new Set(orphans)].join('\n - ')}`,
    );
  });

  it('every rail-prefixed token in SDK descriptions is a registered SDK tool', () => {
    const registered = new Set<string>();
    for (const bundle of SDK_BUNDLES) {
      for (const tool of bundle) registered.add(tool.schema.function.name);
    }
    const orphans: string[] = [];
    for (const bundle of SDK_BUNDLES) {
      for (const tool of bundle) {
        const blob = [
          tool.schema.function.description ?? '',
          JSON.stringify(tool.schema.function.parameters ?? {}),
        ].join('\n');
        for (const token of extractSdkTokens(blob)) {
          if (!registered.has(token)) {
            orphans.push(`${token} (referenced by ${tool.schema.function.name})`);
          }
        }
      }
    }
    assert.deepEqual(
      [...new Set(orphans)],
      [],
      `SDK descriptions reference tools that do not exist:\n - ${[...new Set(orphans)].join('\n - ')}`,
    );
  });

  // ZIG-1112: the rename missed scripts/ because nothing looked there.
  it('every ziggs_* token in scripts/ is a registered MCP tool', async () => {
    const registered = new Set((await mcpTools()).map((t) => t.name));
    const sources = scriptSources();
    assert.ok(
      sources.length > 0,
      'expected scripts/ to contain files referencing ziggs_* tools',
    );

    const orphans: string[] = [];
    for (const { path, text } of sources) {
      for (const token of new Set(extractMcpTokens(text))) {
        if (!registered.has(token)) orphans.push(`${token} (${path})`);
      }
    }

    assert.deepEqual(
      [...new Set(orphans)].sort(),
      [],
      `scripts reference tools that do not exist:\n - ${[...new Set(orphans)].sort().join('\n - ')}`,
    );
  });

  // The skill is shipped to users and read by a model. A name it carries that
  // no longer exists is an instruction to make a call that cannot succeed.
  it('every ziggs_* token in the published skill is a tool that exists', async () => {
    // The skill ships inside the stdio package, so its reader is on a
    // connection they configured themselves — which is the surface that carries
    // the named-connector proxy. Checking it against the listed surface would
    // flag a tool the skill's actual audience can call.
    // ZIG-2116: the plugins ship it on the OAuth door too, so a name either
    // door registers is real.
    const registered = new Set([
      ...(await mcpTools({ directConnection: true })).map((t) => t.name),
      ...(await directoryTools()).map((t) => t.name),
    ]);
    const sources = skillSources();
    assert.ok(sources.length > 0, 'expected skills/ to reference ziggs_* tools');

    const orphans: string[] = [];
    for (const { path, text } of sources) {
      for (const token of new Set(extractMcpTokens(text))) {
        if (!registered.has(token)) orphans.push(`${token} (${path})`);
      }
    }

    assert.deepEqual(
      [...new Set(orphans)].sort(),
      [],
      `the published skill names tools that do not exist:\n - ${[...new Set(orphans)].sort().join('\n - ')}`,
    );
  });

  it('detects a fabricated orphaned reference', () => {
    const registered = new Set(['ziggs_agreement_get']);
    const tokens = extractMcpTokens('Read it with ziggs_agreement_get, then close via ziggs_task_finish.');
    const orphans = tokens.filter((t) => !registered.has(t));
    assert.deepEqual(orphans, ['ziggs_task_finish']);
  });
});
