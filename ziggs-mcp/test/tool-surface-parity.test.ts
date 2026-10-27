import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mcpDescription, type Creds } from '@ziggs-ai/api-client';
import {
  PROTOCOL_TOOLS,
  DISCOVERY_TOOLS,
  MARKETPLACE_TOOLS,
  PAYMENT_TOOLS,
  CONNECTION_TOOLS,
  MCP_CONNECTION_TOOLS,
  CONTEXT_TOOLS,
  GRANTS_TOOLS,
  LINK_TOOLS,
  INTRODUCTION_TOOLS,
  PARTY_TOOLS,
  ARTIFACT_TOOLS,
  CHAT_TOOLS,
  CLAUDE_SDK_TOOLS,
} from '@ziggs-ai/agent-sdk';
import {
  agreementClaimCapability,
  listTasksCapability,
  cancelTaskCapability,
  listGrantsCapability,
  marketplaceViewCapability,
  type CapabilityDefinition,
} from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { surfaceTools } from './support/surface.js';

type JsonSchemaProp = {
  type?: string;
  enum?: unknown[];
  [k: string]: unknown;
};

/** Minimal structural view of an agent-sdk tool. */
type NamedTool = {
  schema: {
    function: {
      name: string;
      description?: string;
      parameters?: {
        properties?: Record<string, JsonSchemaProp>;
        required?: string[];
      };
    };
  };
};

/**
 * ZIG-903 — one capability table, enforced in CI.
 *
 * ZIG-450 stated the rule: "any difference between the SDK and MCP tool surfaces
 * must be deliberate and written down, not accidental." This test reads BOTH
 * real tool registries and fails when they drift from the table below.
 *
 * ZIG-1020 finished the rename batch and DELETED the `rename` escape hatch:
 * a shared capability now has exactly one base name — the MCP name is
 * `ziggs_` + the SDK name, no exceptions. A base-name mismatch is a hard
 * failure; it can no longer be "documented" into acceptability.
 *
 * A row is EITHER:
 *   - shared: `sdk` and `mcp` both set, and their base names MUST agree
 *     (base = the name minus a leading `ziggs_`).
 *   - surface-specific: exactly one of `sdk`/`mcp` set, and MUST carry `reason`.
 *
 * Adding a tool to one surface, deleting one, or renaming without updating the
 * table fails this test with a message naming the offending tool/row.
 *
 * ZIG-957: shared rows also compare input-schema contracts:
 *   - required param name sets (after stripping session-injected keys like chatId)
 *   - type + enum for the intersection of property names
 * Names-green alone used to let free-string SDK fields ship against MCP enums
 * (planReviewTiming) and renamed required params (status vs state) slip through.
 */
interface ParityRow {
  capability: string;
  sdk?: string;
  mcp?: string;
  /** Required when a row is surface-specific (only one side present). */
  reason?: string;
}

/** Params the MCP session (or SDK tool context) supplies — not part of the shared contract. */
const SURFACE_CONTEXT_PARAMS = new Set(['chatId']);

type ToolInputSchema = {
  properties: Record<string, JsonSchemaProp>;
  required: string[];
};

// Base name = the tool name with a leading `ziggs_` stripped, so the MCP
// convention (`ziggs_*`) can be compared against the bare SDK name.
function baseName(name: string): string {
  return name.replace(/^ziggs_/, '');
}

const PARITY_TABLE: ParityRow[] = [
  // ── Agreement rail ────────────────────────────────────────────────────────
  { capability: 'buy work from a named counterparty (they work, you pay)', mcp: 'ziggs_agreement_buy', reason: 'MCP splits the propose dispatch into one verb per shape (ZIG-1376); the SDK keeps the single verb because its proposals run through the protocol-operation path, which carries a crash-replay idempotency key the capability adapter has no equivalent for — moving it would trade a dispatch table for duplicate priced agreements on replay.' },
  { capability: 'offer to work for a named counterparty (you work, they pay)', mcp: 'ziggs_agreement_bid', reason: 'One verb per propose shape; see ziggs_agreement_buy.' },
  { capability: 'broker work between two other parties', mcp: 'ziggs_agreement_broker', reason: 'One verb per propose shape; the only verb that still names a provider.' },
  { capability: 'post a request (claimer works, you pay)', mcp: 'ziggs_agreement_request', reason: 'One verb per propose shape; see ziggs_agreement_buy.' },
  { capability: 'hand off an agent you hired', mcp: 'ziggs_agreement_handoff', reason: 'One verb per propose shape; the provider is read from the parent hire rather than passed.' },
  { capability: 'connect with someone', sdk: 'link_propose', mcp: 'ziggs_link_propose' },
  { capability: 'propose an agreement (direct / broadcast / link)', sdk: 'agreement_propose', reason: 'SDK-side single verb; MCP uses the per-shape verbs above.' },
  { capability: 'respond to a direct proposal', sdk: 'agreement_respond', mcp: 'ziggs_agreement_respond' },
  { capability: 'claim an open broadcast (request / offer / link invite)', sdk: 'agreement_claim', mcp: 'ziggs_agreement_claim' },
  { capability: 'counter a proposal', sdk: 'agreement_counter', mcp: 'ziggs_agreement_counter' },
  { capability: 'inspect an agreement', sdk: 'agreement_get', mcp: 'ziggs_agreement_get' },
  { capability: 'revoke an agreement', sdk: 'agreement_revoke', mcp: 'ziggs_agreement_revoke' },
  { capability: 'fulfill an agreement', sdk: 'agreement_fulfill', mcp: 'ziggs_agreement_fulfill' },
  { capability: 'subcontract under an agreement', sdk: 'agreement_subcontract', mcp: 'ziggs_agreement_subcontract' },
  { capability: 'list my agreements', mcp: 'ziggs_agreement_list', reason: 'SDK reads agreements via prompt-injected context, not a lister tool.' },

  // ── Task rail ─────────────────────────────────────────────────────────────
  { capability: 'create a task', sdk: 'task_create', mcp: 'ziggs_task_create' },
  { capability: 'set task result (terminal transition)', sdk: 'task_set_result', mcp: 'ziggs_task_set_result' },
  { capability: 'replace the task plan (full list)', mcp: 'ziggs_task_replace_plan', reason: 'Restructure the checklist. SDK has no wholesale replace — it ticks steps via task_update_plan_step.' },
  { capability: 'advance one plan step', sdk: 'task_update_plan_step', reason: 'SDK host FSM ticks one step. MCP names changed steps via ziggs_task_update_steps on the same PATCH /plan rail.' },
  { capability: 'patch named plan steps', mcp: 'ziggs_task_update_steps', reason: 'Pull-only progress: name the steps that changed. SDK ticks one step at a time via task_update_plan_step.' },
  { capability: 'list tasks', sdk: 'task_list', mcp: 'ziggs_task_list' },
  { capability: 'cancel a task', sdk: 'task_cancel', mcp: 'ziggs_task_cancel' },
  { capability: 'acknowledge task execution control', mcp: 'ziggs_task_acknowledge_control', reason: 'The SDK host owns interruption and acknowledgement; independent MCP runtimes attest through this tool after their work settles.' },
  { capability: 'fetch one task by id', mcp: 'ziggs_task_get', reason: 'ZIG-940: external agents handed a bare taskId need a by-id read. SDK task reads are prompt-injected.' },

  // ── Context rail ──────────────────────────────────────────────────────────
  { capability: 'acknowledge inbox deliveries', mcp: 'ziggs_inbox_ack', reason: 'ZIG-1882 split the ack off the read so the annotation tells the truth. The SDK has no twin: its host owns the pull/ack cycle over HTTP, and a brain-side ack would race it.' },
  { capability: 'hide a pending decision from the top of the inbox', mcp: 'ziggs_inbox_defer', reason: 'The person said to leave a proposal pending. The SDK host has no twin: the delegate records the mark from the conversation.' },
  { capability: 'read scope contents', sdk: 'context_read', mcp: 'ziggs_context_read' },
  { capability: 'open a returned resource', sdk: 'open', mcp: 'ziggs_open' },
  { capability: 'explain access to a resource', sdk: 'access_explain', mcp: 'ziggs_access_explain' },
  { capability: 'read chat snapshot', sdk: 'context_snapshot', mcp: 'ziggs_context_snapshot' },
  { capability: 'expand a grant into ids', sdk: 'context_expand_reach', mcp: 'ziggs_context_expand_reach' },
  { capability: 'discover grantable context', sdk: 'context_discover_grantable', mcp: 'ziggs_context_discover_grantable' },
  { capability: 'delegate a context grant', sdk: 'context_delegate', mcp: 'ziggs_context_delegate' },
  { capability: 'request scoped access', sdk: 'access_request', mcp: 'ziggs_access_request' },
  { capability: 'revoke a context grant', mcp: 'ziggs_context_revoke_grant', reason: 'SDK context bundle has no revoke; payment_revoke_grant is a different rail (wallet).' },

  // ── Grant rail (cross-rail lister) ────────────────────────────────────────
  { capability: 'list grants (all rails)', sdk: 'grant_list', mcp: 'ziggs_grant_list' },

  // ── Discovery rail ────────────────────────────────────────────────────────
  { capability: 'search agents', sdk: 'agent_search', mcp: 'ziggs_agent_search' },
  { capability: 'fetch one agent by id', sdk: 'agent_get', mcp: 'ziggs_agent_get' },

  // ── Chat rail ─────────────────────────────────────────────────────────────
  { capability: 'open a conversation', sdk: 'chat_open', mcp: 'ziggs_chat_open' },
  { capability: 'send a chat message', sdk: 'chat_send', mcp: 'ziggs_chat_send' },
  { capability: 'list my chats', mcp: 'ziggs_chat_list', reason: 'ZIG-900 decision: on the SDK "what chats can I see" is a context-rail read (grant_list scopeKind=chat — membership auto-mints a chat grant); MCP keeps the session-UX lister for humans in Cursor/Claude.' },

  // ── Marketplace rail (publish/claim ride the agreement grammar) ──────────
  { capability: 'browse the marketplace', sdk: 'marketplace_view', mcp: 'ziggs_marketplace_view' },
  // ZIG-1384 #2 removed `provision_relay_workers` from the MCP surface: an
  // ops composite, not an agent intent.

  // ── Link rail (propose/claim/revoke ride the agreement grammar) ──────────
  // ZIG-1478: one connect verb, whose row is up with the rest of the link rail.
  // `link_create_invite` was the same act with a different way of naming the
  // other side, so `link_propose` takes an email, an agent id, or nothing and
  // hands back a share link when nobody was named.
  { capability: 'list links', sdk: 'link_list', mcp: 'ziggs_link_list' },

  // ── Introduction rail (ZIG-1595) — a meeting off Ziggs becomes a link here ─
  { capability: 'hand someone an introduction', sdk: 'introduction_mint', mcp: 'ziggs_introduction_mint' },
  { capability: 'redeem an introduction you were handed', sdk: 'introduction_redeem', mcp: 'ziggs_introduction_redeem' },
  { capability: 'list introductions you handed out', sdk: 'introduction_list', mcp: 'ziggs_introduction_list' },
  { capability: 'take back an introduction', sdk: 'introduction_revoke', mcp: 'ziggs_introduction_revoke' },

  // ── A person not on Ziggs yet — what your workspace knows about them ──────
  { capability: 'write notes on a person not on Ziggs yet', sdk: 'party_note', mcp: 'ziggs_party_note' },

  // ── Connection rail ───────────────────────────────────────────────────────
  // ZIG-1368 — connection_proxy stays on the SDK, and on MCP only for a
  // caller who configured the connection themselves (cfg.directConnection).
  // This suite builds the listed surface, so it has no MCP twin here.
  { capability: 'use a named-connector stored connection', sdk: 'connection_proxy', reason: 'ZIG-1368: the freeform action-plus-payload shape is off the listed MCP surface; it registers only on a self-configured connection.' },
  { capability: 'request a connection', sdk: 'connection_request', reason: 'Off the listed MCP surface with the rest of the connection rail: a connected assistant cannot use a connection there, so asking its person to grant one would be a trap. Registers only on a self-configured connection (cfg.directConnection).' },
  { capability: 'list my connections (grouped)', mcp: 'ziggs_connection_list', reason: 'Grouped-by-connection presentation kept on MCP (ZIG-893 allowance); SDK exposes the rail via grant_list + connection_list_grants.' },
  { capability: 'list grants for one connection', sdk: 'connection_list_grants', reason: 'Per-connection proxy helper; MCP folds connection listing into ziggs_connection_list (ZIG-893 allowance).' },
  // ZIG-1362 — brokered MCP (provider: mcp). Not connection_proxy, but the same
  // target-plus-freeform-payload shape, so on MCP it registers only on a
  // self-configured connection (cfg.directConnection), like the proxy.
  { capability: 'list tools on a brokered MCP connection', sdk: 'mcp_tools_list', reason: 'Discovery half of the brokered-MCP call; off the listed MCP surface with it, registers only on a self-configured connection.' },
  { capability: 'call a tool on a brokered MCP connection', sdk: 'mcp_tool_call', reason: 'Freeform tool name plus payload into whatever server the owner connected: the shape store reviewers reject. Off the listed MCP surface, registers only on a self-configured connection.' },

  // ── Artifact rail ─────────────────────────────────────────────────────────
  { capability: 'record an artifact', sdk: 'artifact_record', mcp: 'ziggs_artifact_record' },
  {
    capability: 'presign file artifact upload',
    sdk: 'artifact_upload_url',
    mcp: 'ziggs_artifact_upload_url',
  },
  {
    capability: 'complete file artifact upload',
    sdk: 'artifact_complete_file',
    mcp: 'ziggs_artifact_complete_file',
  },
  {
    capability: 'presign file artifact download',
    sdk: 'artifact_download',
    mcp: 'ziggs_artifact_download',
  },
  // ZIG-1384 #2 — re-extraction is a repair operation on our storage, so it
  // left the MCP surface and stays available to the SDK runtime.
  {
    capability: 're-queue file artifact extract',
    sdk: 'artifact_reextract',
    reason: 'ZIG-1384 #2: operator repair work, not an agent intent — off the MCP surface.',
  },
  // ZIG-1037 — an artifact needs no container, so it needs its own listing (the
  // scope reads walk attach tables and cannot see a free-standing one) and its
  // own share (authorship is a root authority with no parent grant to delegate).
  { capability: 'list artifacts I authored', sdk: 'artifact_list', mcp: 'ziggs_artifact_list' },
  // ZIG-1875 (AX-04) — the listing is "what I wrote"; this is "where is the
  // thing about X" over everything the agent can already reach, with the
  // coverage that keeps an empty answer from reading as an empty world.
  { capability: 'find artifacts I can read', sdk: 'artifact_find', mcp: 'ziggs_artifact_find' },
  { capability: 'share an artifact I authored', sdk: 'artifact_share', mcp: 'ziggs_artifact_share' },
  { capability: 'attach an artifact to a chat, task, or agreement', sdk: 'artifact_attach', mcp: 'ziggs_artifact_attach' },

  // ── Payment rail ──────────────────────────────────────────────────────────
  // ZIG-1366 (Shape 2) — the balance read is the whole rail on both surfaces
  // now. Transfer, hold, release, wait-for-approval, resolve-wallet and the
  // three grant mutations are gone from every agent surface: points move as a
  // consequence of an agreement settling, and nowhere else.
  { capability: 'points balance', sdk: 'payment_balance', mcp: 'ziggs_payment_balance' },

  // ── MCP-only: session workarounds (no push channel on pull-only MCP) ──────
  { capability: 'inbox delta + ack', mcp: 'ziggs_inbox', reason: 'MCP session workaround: the SDK host owns the pull/watermark cycle, so no brain-side inbox/ack tool.' },
  { capability: 'inbox observation deltas', mcp: 'ziggs_inbox_changes', reason: 'The host observes through InboxClient; a second brain-side loop would race it.' },
  { capability: 'inbox as a card for the person', mcp: 'ziggs_inbox_show', reason: 'An MCP Apps view a chat host draws for the person. A hosted agent has no person in front of it to show a card to.' },
  { capability: 'inbox peek without taking the mailbox', mcp: 'ziggs_inbox_peek', reason: 'AX-05: orientation/count without acquiring the host lease. The SDK host already peeks over HTTP; a brain-side twin would race it.' },
  // ZIG-1384 #1 folded the session-start card into ziggs_inbox, so there is no
  // separate ziggs_pending_decisions row to keep in step any more.
  { capability: 'auth status', mcp: 'ziggs_auth_status', reason: 'MCP session workaround: operator-key/OAuth binding check for cold hosts; not needed inside the SDK runtime.' },
  { capability: 'list my orgs', mcp: 'ziggs_org_list', reason: 'Org membership listing feeds the OAuth reconnect flow; no SDK counterpart.' },

  // ZIG-1390 — the catalog pair is how a caller reaches everything above that
  // is not natively listed. Purely an MCP delivery concern: an SDK agent is
  // handed its tool bundles directly and never needs to look a tool up.
  { capability: 'list every tool', mcp: 'ziggs_tools', reason: 'ZIG-1390 names-first delivery: MCP-only, since tools/list is the thing being made cheap.' },
  { capability: 'call a read-only tool by name', mcp: 'ziggs_tool_read', reason: 'ZIG-1390 names-first delivery: MCP-only dispatcher for read-only catalog tools. One dispatcher per annotation lane, so a host and a store reviewer read each honestly.' },
  { capability: 'call a writing tool by name', mcp: 'ziggs_tool_write', reason: 'ZIG-1390 names-first delivery: MCP-only dispatcher for catalog tools that change state; irreversible tools are refused and called by name.' },
];

function sdkToolBundles(): ReadonlyArray<NamedTool>[] {
  return [
    PROTOCOL_TOOLS,
    DISCOVERY_TOOLS,
    MARKETPLACE_TOOLS,
    PAYMENT_TOOLS,
    CONNECTION_TOOLS,
    MCP_CONNECTION_TOOLS,
    [...CONTEXT_TOOLS],
    GRANTS_TOOLS,
    LINK_TOOLS,
    INTRODUCTION_TOOLS,
    PARTY_TOOLS,
    ARTIFACT_TOOLS,
    CHAT_TOOLS,
    CLAUDE_SDK_TOOLS,
  ];
}

function sdkRegistry(): Set<string> {
  const names = new Set<string>();
  for (const bundle of sdkToolBundles()) {
    for (const tool of bundle) {
      names.add(tool.schema.function['name'] as string);
    }
  }
  return names;
}

/** SDK name → input schema from defineTool JSON Schema. */
function sdkInputSchemas(): Map<string, ToolInputSchema> {
  const out = new Map<string, ToolInputSchema>();
  for (const bundle of sdkToolBundles()) {
    for (const tool of bundle) {
      const name = tool.schema.function['name'] as string;
      const parameters = tool.schema.function.parameters;
      out.set(name, {
        properties: (parameters?.properties ?? {}) as Record<string, JsonSchemaProp>,
        required: [...(parameters?.required ?? [])],
      });
    }
  }
  return out;
}

async function mcpListTools(cfg: Partial<ZiggsMcpConfig> = {}) {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    { debugTools: false, ...cfg } as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'parity-test', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const tools = await surfaceTools(client);
  await client.close();
  return tools;
}

async function mcpRegistry(
  cfg: Partial<ZiggsMcpConfig> = {},
): Promise<Set<string>> {
  const tools = await mcpListTools(cfg);
  return new Set(tools.map((t) => t.name));
}

/** MCP name → inputSchema properties + required. */
async function mcpInputSchemas(
  cfg: Partial<ZiggsMcpConfig> = {},
): Promise<Map<string, ToolInputSchema>> {
  const tools = await mcpListTools(cfg);
  const out = new Map<string, ToolInputSchema>();
  for (const t of tools) {
    const schema = t.inputSchema as {
      properties?: Record<string, JsonSchemaProp>;
      required?: string[];
    } | undefined;
    out.set(t.name, {
      properties: (schema?.properties ?? {}) as Record<string, JsonSchemaProp>,
      required: [...(schema?.required ?? [])],
    });
  }
  return out;
}

function enumSet(prop: JsonSchemaProp | undefined): string[] | null {
  if (!prop || !Array.isArray(prop.enum)) return null;
  return [...prop.enum].map(String).sort();
}

function contractRequired(required: string[]): string[] {
  return required.filter((k) => !SURFACE_CONTEXT_PARAMS.has(k)).sort();
}

/**
 * ZIG-957 — for every shared row:
 *   1. required param names must match (session-injected keys like chatId stripped)
 *   2. type/enum of properties present on BOTH sides must match
 * Optional property-set asymmetry between the two surfaces is allowed;
 * renamed required params (status vs state) and free-string vs enum are not.
 */
function schemaDriftViolations(
  table: ParityRow[],
  sdkSchemas: Map<string, ToolInputSchema>,
  mcpSchemas: Map<string, ToolInputSchema>,
): string[] {
  const errors: string[] = [];
  for (const row of table) {
    if (!row.sdk || !row.mcp) continue;
    const sdkSchema = sdkSchemas.get(row.sdk);
    const mcpSchema = mcpSchemas.get(row.mcp);
    if (!sdkSchema || !mcpSchema) continue;
    const sdkProps = sdkSchema.properties;
    const mcpProps = mcpSchema.properties;

    const sdkReq = contractRequired(sdkSchema.required).join(',');
    const mcpReq = contractRequired(mcpSchema.required).join(',');
    if (sdkReq !== mcpReq) {
      errors.push(
        `shared "${row.capability}" required params: SDK=[${sdkReq || '(none)'}] vs MCP=[${mcpReq || '(none)'}]`,
      );
    }

    for (const key of Object.keys(sdkProps)) {
      if (!(key in mcpProps)) continue;
      const s = sdkProps[key];
      const m = mcpProps[key];
      const sType = s?.type;
      const mType = m?.type;
      if (sType && mType && sType !== mType) {
        errors.push(
          `shared "${row.capability}" param "${key}": SDK type=${sType} vs MCP type=${mType}`,
        );
      }
      const sEnum = enumSet(s);
      const mEnum = enumSet(m);
      if (sEnum || mEnum) {
        if (!sEnum || !mEnum || sEnum.join('|') !== mEnum.join('|')) {
          errors.push(
            `shared "${row.capability}" param "${key}": SDK enum=[${sEnum?.join(',') ?? '(none)'}] vs MCP enum=[${mEnum?.join(',') ?? '(none)'}]`,
          );
        }
      }
    }
  }
  return errors;
}

/**
 * Pure drift check so the same logic guards the real registries AND can be
 * exercised against fabricated drift (the "Verify" bullet). Returns a list of
 * human-readable violations; empty means the table and registries agree.
 */
function driftViolations(
  table: ParityRow[],
  sdk: Set<string>,
  mcp: Set<string>,
): string[] {
  const errors: string[] = [];
  const tableSdk = new Map<string, ParityRow>();
  const tableMcp = new Map<string, ParityRow>();

  for (const row of table) {
    if (!row.sdk && !row.mcp) {
      errors.push(`row "${row.capability}" names neither an SDK nor an MCP tool`);
      continue;
    }
    // Surface-specific rows must justify why they live on one surface only.
    if ((!row.sdk || !row.mcp) && !row.reason) {
      errors.push(`surface-specific row "${row.capability}" is missing a reason`);
    }
    // ZIG-1020: shared rows MUST share a base name — no rename escape hatch.
    if (row.sdk && row.mcp && baseName(row.sdk) !== baseName(row.mcp)) {
      errors.push(
        `shared row "${row.capability}" maps ${row.sdk} ↔ ${row.mcp} — base names must be identical (one name per capability, ZIG-1020)`,
      );
    }
    if (row.sdk) {
      if (tableSdk.has(row.sdk)) {
        errors.push(`SDK tool ${row.sdk} appears in more than one table row`);
      }
      tableSdk.set(row.sdk, row);
      if (!sdk.has(row.sdk)) {
        errors.push(`table row "${row.capability}" lists SDK tool ${row.sdk}, but it is not registered`);
      }
    }
    if (row.mcp) {
      if (tableMcp.has(row.mcp)) {
        errors.push(`MCP tool ${row.mcp} appears in more than one table row`);
      }
      tableMcp.set(row.mcp, row);
      if (!mcp.has(row.mcp)) {
        errors.push(`table row "${row.capability}" lists MCP tool ${row.mcp}, but it is not registered`);
      }
    }
  }

  for (const name of sdk) {
    if (!tableSdk.has(name)) {
      errors.push(`SDK tool ${name} is registered but has no row in the parity table — add it (shared row or surface-specific with a reason)`);
    }
  }
  for (const name of mcp) {
    if (!tableMcp.has(name)) {
      errors.push(`MCP tool ${name} is registered but has no row in the parity table — add it (shared row or surface-specific with a reason)`);
    }
  }
  return errors;
}

describe('SDK ↔ MCP tool surface parity (ZIG-903 / ZIG-1020 / ZIG-957)', () => {
  it('every registered tool on both surfaces is accounted for in the parity table', async () => {
    const sdk = sdkRegistry();
    const mcp = await mcpRegistry();
    const violations = driftViolations(PARITY_TABLE, sdk, mcp);
    assert.deepEqual(
      violations,
      [],
      `tool surface drift detected:\n - ${violations.join('\n - ')}`,
    );
  });

  it('shared-row input schemas agree on required names + type/enum for overlapping params (ZIG-957)', async () => {
    const sdkSchemas = sdkInputSchemas();
    const mcpSchemas = await mcpInputSchemas();
    const violations = schemaDriftViolations(PARITY_TABLE, sdkSchemas, mcpSchemas);
    assert.deepEqual(
      violations,
      [],
      `input-schema drift detected:\n - ${violations.join('\n - ')}`,
    );
  });

  /**
   * ZIG-1095 — an agreement has nowhere to keep a plan: no propose, counter or
   * delegate route has ever accepted one, and Agreement has no `plan` field.
   * Offering the parameter anyway meant an agent could lay out its steps, get a
   * 201, and have them dropped with no error to read. The plan belongs to the
   * task rail (task_create / task_replace_plan), which is why task_create is
   * deliberately excluded below rather than swept in.
   */
  it('no agreement propose/counter/subcontract tool offers a parameter the rails discard', async () => {
    const dead = ['plan', 'planReviewTiming', 'requireMidWorkPlanAck', 'parentTaskId'];
    const surfaces = [
      ['SDK', sdkInputSchemas()] as const,
      ['MCP', await mcpInputSchemas()] as const,
    ];
    const offenders: string[] = [];
    for (const [label, schemas] of surfaces) {
      for (const [tool, schema] of schemas) {
        if (!/agreement_(propose|counter|subcontract)$/.test(tool)) continue;
        for (const param of dead) {
          if (schema.properties[param]) {
            offenders.push(`${label} ${tool} still offers ${param}`);
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `dead parameters back on the agreement surface:\n - ${offenders.join('\n - ')}`,
    );
  });

  /**
   * ZIG-1096 — the mirror of the test above. `POST /tasks` accepts `plan`,
   * `planReviewTiming` and `requireMidWorkPlanAck`, so an agent should be able
   * to spawn a task with its checklist attached in ONE call from either
   * surface. MCP offered none of the three, and the generic schema check above
   * cannot catch it: optional property-set asymmetry is deliberately allowed
   * there. Named explicitly here because the plan trio is the one place where
   * that allowance hid a real capability gap.
   */
  it('task_create offers the same plan-at-creation params on both surfaces (ZIG-1096)', async () => {
    const planParams = ['plan', 'planReviewTiming', 'requireMidWorkPlanAck'];
    const sdkSchema = sdkInputSchemas().get('task_create');
    const mcpSchema = (await mcpInputSchemas()).get('ziggs_task_create');
    assert.ok(sdkSchema, 'task_create missing from the SDK registry');
    assert.ok(mcpSchema, 'ziggs_task_create missing from the MCP registry');

    const missing: string[] = [];
    for (const param of planParams) {
      if (!sdkSchema.properties[param]) missing.push(`SDK task_create is missing ${param}`);
      if (!mcpSchema.properties[param]) missing.push(`MCP ziggs_task_create is missing ${param}`);
    }
    assert.deepEqual(
      missing,
      [],
      `plan-at-creation params absent from a surface the rail supports:\n - ${missing.join('\n - ')}`,
    );
  });

  it('detects free-string vs enum drift on a shared param (ZIG-957 mutation)', () => {
    // Fabricate the exact bug that shipped through the names-only guard:
    // SDK planReviewTiming is a bare string while MCP has the real enum.
    // Historical: ZIG-1095 removed planReviewTiming from both counter tools
    // (nothing stored it). These schemas are synthetic — the detector is what
    // is under test, and this shape is the one that got past the old guard.
    const sdkSchemas = new Map<string, ToolInputSchema>([
      [
        'agreement_counter',
        {
          properties: { planReviewTiming: { type: 'string' } },
          required: ['agreementId'],
        },
      ],
    ]);
    const mcpSchemas = new Map<string, ToolInputSchema>([
      [
        'ziggs_agreement_counter',
        {
          properties: {
            planReviewTiming: { type: 'string', enum: ['with_proposal', 'before_execution'] },
          },
          required: ['agreementId'],
        },
      ],
    ]);
    const table: ParityRow[] = [
      { capability: 'counter a proposal', sdk: 'agreement_counter', mcp: 'ziggs_agreement_counter' },
    ];
    const violations = schemaDriftViolations(table, sdkSchemas, mcpSchemas);
    assert.ok(
      violations.some((v) => v.includes('planReviewTiming') && v.includes('enum')),
      `expected planReviewTiming enum drift, got:\n${violations.join('\n')}`,
    );
  });

  it('detects renamed required params (status vs state) (ZIG-957 mutation)', () => {
    const sdkSchemas = new Map<string, ToolInputSchema>([
      [
        'task_set_result',
        {
          properties: {
            taskId: { type: 'string' },
            status: { type: 'string', enum: ['completed', 'failed', 'cancelled'] },
          },
          required: ['taskId', 'status'],
        },
      ],
    ]);
    const mcpSchemas = new Map<string, ToolInputSchema>([
      [
        'ziggs_task_set_result',
        {
          properties: {
            taskId: { type: 'string' },
            state: { type: 'string', enum: ['completed', 'failed', 'cancelled'] },
          },
          required: ['taskId', 'state'],
        },
      ],
    ]);
    const table: ParityRow[] = [
      {
        capability: 'set task result (terminal transition)',
        sdk: 'task_set_result',
        mcp: 'ziggs_task_set_result',
      },
    ];
    const violations = schemaDriftViolations(table, sdkSchemas, mcpSchemas);
    assert.ok(
      violations.some((v) => v.includes('required params') && v.includes('state')),
      `expected status↔state required-name drift, got:\n${violations.join('\n')}`,
    );
  });

  it('detects an added MCP tool that is missing from the table', () => {
    const sdk = new Set(PARITY_TABLE.filter((r) => r.sdk).map((r) => r.sdk!));
    const mcp = new Set(PARITY_TABLE.filter((r) => r.mcp).map((r) => r.mcp!));
    mcp.add('ziggs_brand_new_tool');
    const violations = driftViolations(PARITY_TABLE, sdk, mcp);
    assert.ok(
      violations.some((v) => v.includes('ziggs_brand_new_tool') && v.includes('no row')),
      `expected a violation naming ziggs_brand_new_tool, got:\n${violations.join('\n')}`,
    );
  });

  it('detects a deleted tool that still has a table row', () => {
    const sdk = new Set(PARITY_TABLE.filter((r) => r.sdk).map((r) => r.sdk!));
    const mcp = new Set(PARITY_TABLE.filter((r) => r.mcp).map((r) => r.mcp!));
    sdk.delete('grant_list');
    const violations = driftViolations(PARITY_TABLE, sdk, mcp);
    assert.ok(
      violations.some((v) => v.includes('grant_list') && v.includes('not registered')),
      `expected a violation naming grant_list, got:\n${violations.join('\n')}`,
    );
  });

  it('rejects a shared row whose names diverge — renames can no longer be documented', () => {
    const table: ParityRow[] = [
      { capability: 'x', sdk: 'foo', mcp: 'ziggs_bar' },
    ];
    const violations = driftViolations(table, new Set(['foo']), new Set(['ziggs_bar']));
    assert.ok(
      violations.some((v) => v.includes('base names must be identical')),
      `expected a base-name violation, got:\n${violations.join('\n')}`,
    );
  });

  /**
   * ZIG-1123 — descriptions and result shapes used to drift because each
   * surface retyped them. Shared capabilities register through adapters; the
   * registered copy must still be the capability's copy.
   */
  it('shared capabilities keep the description the adapter registered (ZIG-1123)', async () => {
    const caps: CapabilityDefinition[] = [
      agreementClaimCapability,
      listTasksCapability,
      cancelTaskCapability,
      listGrantsCapability,
      marketplaceViewCapability,
    ];
    const sdkByName = new Map<string, NamedTool>();
    for (const bundle of sdkToolBundles()) {
      for (const tool of bundle) {
        sdkByName.set(tool.schema.function['name'] as string, tool);
      }
    }
    const mcpByName = new Map((await mcpListTools()).map((t) => [t.name, t]));
    const errors: string[] = [];
    for (const cap of caps) {
      const sdkTool = sdkByName.get(cap.names.sdk);
      const mcpTool = mcpByName.get(cap.names.mcp);
      if (!sdkTool) {
        errors.push(`SDK is missing ${cap.names.sdk}`);
        continue;
      }
      if (!mcpTool) {
        errors.push(`MCP is missing ${cap.names.mcp}`);
        continue;
      }
      const sdkDesc = sdkTool.schema.function.description ?? '';
      if (sdkDesc !== cap.descriptions.sdk) {
        errors.push(`${cap.names.sdk} description drifted from capability.descriptions.sdk`);
      }
      // ZIG-2116 — the MCP description is rendered from the capability's
      // brief and annotation; this listing is the compact door.
      if (mcpTool.description !== mcpDescription(cap.names.mcp, cap.annotation, 'compact')) {
        errors.push(`${cap.names.mcp} description drifted from its brief`);
      }
    }
    assert.deepEqual(errors, [], errors.join('\n - '));
  });
});
