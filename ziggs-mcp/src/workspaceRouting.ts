import { inboxCardResult } from './inboxCard.js';
import { isDirectorySurface } from './directorySurface.js';
import { toolError } from './toolError.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AssistantConnectionClient,
  withAssistantRequest,
  decodeOperatorKeyClaims,
  parseRef,
  type AssistantWorkspace,
  type Creds,
  type InboxEnvelope,
} from '@ziggs-ai/api-client';
import { formatInboxToolResult } from './inboxToolResult.js';
import { compactTextResult, windowNote } from './inboxCompact.js';
import { sessionRules } from './protocol/connectText.js';
import { formatPendingDecisionsPayload, resolveWebAppOrigin } from './pendingDecisions.js';

/**
 * One assistant identity across workspace hires, with each tool call choosing
 * the workspace that owns its work.
 *
 * The connection's roster (`GET /oauth/workspaces`) is read once a minute and
 * on every session-start read, so a workspace joined mid-session shows up
 * without a reconnect. Per call:
 *
 *  - something that exists (a room, a job, a task, a file): the backend says
 *    which of the connection's assistants is on it, inside the real HTTP
 *    request. The resource reference rides on every subrequest; there is
 *    no separate resolve read and no session-global selected workspace.
 *  - something new: the workspace the call names, else the only one the
 *    connection has. Two or more and none named is refused here, before any
 *    backend call, with the choices, so the assistant asks its human.
 *  - reads with no target: once per workspace, each result labelled; a read
 *    whose answer is the same everywhere runs once.
 *
 * The acting assistant rides on the async context of the call, so two windows
 * on one connection never see each other's pick, and nothing remembers a
 * "current workspace" between calls.
 */

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
type Handler = (args: Record<string, unknown>, ...extra: unknown[]) => Promise<ToolResult>;
type TargetKind = 'chat' | 'task' | 'artifact' | 'agreement' | 'grant' | 'connection';

const routers = new WeakMap<McpServer, WorkspaceRouter>();

/** The catalog and its dispatchers: they reach other tools, which route themselves. */
const GLOBAL = new Set(['ziggs_tools', 'ziggs_tool_read', 'ziggs_tool_write']);
/** The connection's own reads: its roster and its one inbox. */
const CONNECTION = new Set([
  'ziggs_auth_status',
  'ziggs_org_list',
  'ziggs_inbox',
  'ziggs_inbox_show',
  'ziggs_inbox_peek',
  'ziggs_inbox_changes',
  'ziggs_notification_status',
  'ziggs_inbox_ack',
  'ziggs_inbox_defer',
  'ziggs_inbox_claim',
  'ziggs_workspace_sync',
]);
/** Reads whose answer does not depend on the workspace: run once, not once per workspace. */
const SAME_EVERYWHERE = new Set([
  'ziggs_marketplace_view',
  'ziggs_agent_search',
  'ziggs_agent_get',
  'ziggs_link_list',
]);
/**
 * Fan-out reads whose rows are the same record seen from each workspace: one
 * row per id, with the workspaces it was seen in. Not run once, because each
 * workspace calls as its own assistant and can see different rows.
 */
const ONE_ROW_PER_ID: Readonly<Record<string, { list: string; id: string }>> = {
  ziggs_agreement_list: { list: 'agreements', id: 'agreementId' },
};
const TARGET_FIELDS: ReadonlyArray<readonly [string, TargetKind]> = [
  ['chatId', 'chat'],
  ['taskId', 'task'],
  ['artifactId', 'artifact'],
  ['agreementId', 'agreement'],
  ['parentAgreementId', 'agreement'],
  ['grantId', 'grant'],
  ['contextGrantId', 'grant'],
  ['connectionId', 'connection'],
];
const TARGET_KINDS = new Set<string>(['chat', 'agreement', 'task', 'artifact', 'grant', 'connection']);
/** How long the roster is trusted before it is read again. */
export const WORKSPACES_TTL_MS = 60_000;

export const ASK_YOUR_HUMAN =
  "Use the workspace your human named. If they didn't, ask them. Never guess.";

const result = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError } : {}),
});

const refusal = (code: string, message: string, choices: AssistantWorkspace[] = []) =>
  result({ code, message, choices: choices.map(({ orgId, name }) => ({ orgId, name })) }, true);

export function workspaceRouter(server: McpServer): WorkspaceRouter | undefined {
  return routers.get(server);
}

/**
 * Install routing for a connection token. Any other credential (a bound key,
 * a fleet key with ZIGGS_AGENT_ID) names its agent itself and is left alone.
 */
export function installWorkspaceRouting(server: McpServer, creds: Creds): Creds {
  const claims = decodeOperatorKeyClaims(creds.operatorKey);
  if (!claims?.connectionClientId && !claims?.boundAgentId) return creds;
  const router = new WorkspaceRouter(creds, !!claims.connectionClientId, isDirectorySurface(server));
  routers.set(server, router);
  return router.creds;
}

export class WorkspaceRouter {
  private readonly active = new AsyncLocalStorage<AssistantWorkspace>();
  /** The base credentials with `agentId` answered by the call in progress. */
  readonly creds: Creds;
  private readonly client: AssistantConnectionClient;
  private roster: { readAt: number; list: AssistantWorkspace[] } | null = null;

  constructor(base: Creds, private enabled = true, private directory = false) {
    this.client = new AssistantConnectionClient(base);
    this.creds = new Proxy(base, {
      get: (target, key, receiver) =>
        key === 'agentId' && this.enabled
          ? (this.active.getStore()?.agentId ?? '')
          : Reflect.get(target, key, receiver),
    });
  }

  activate(): void { this.enabled = true; }

  acceptsWorkspace(name: string): boolean {
    return !GLOBAL.has(name) && !CONNECTION.has(name);
  }

  /** The connection's workspaces, re-read after {@link WORKSPACES_TTL_MS} or on demand. */
  async workspaces(fresh = false): Promise<AssistantWorkspace[]> {
    if (!fresh && this.roster && Date.now() - this.roster.readAt < WORKSPACES_TTL_MS) {
      return this.roster.list;
    }
    const list = await this.client.workspaces();
    this.remember(list);
    return list;
  }

  private remember(list: AssistantWorkspace[]): void {
    this.roster = { readAt: Date.now(), list };
  }

  /** The existing thing a call is about, from the argument that names it. */
  private target(args: Record<string, unknown>): { kind: TargetKind; id: string } | null {
    // open names its record by one ref; its kind is read from it. Without
    // this the call had no target and fanned out to every workspace.
    if (typeof args.ref === 'string' && args.ref.trim()) {
      const ref = parseRef(args.ref);
      if (ref) return { kind: ref.kind, id: ref.id };
    }
    for (const [field, kind] of TARGET_FIELDS) {
      const value = args[field];
      if (typeof value === 'string' && value) return { kind, id: value };
    }
    if (
      typeof args.scopeKind === 'string' &&
      typeof args.scopeId === 'string' &&
      TARGET_KINDS.has(args.scopeKind)
    ) {
      return { kind: args.scopeKind as TargetKind, id: args.scopeId };
    }
    if (typeof args.via === 'string') {
      const split = args.via.indexOf(':');
      const kind = args.via.slice(0, split);
      if (TARGET_KINDS.has(kind)) return { kind: kind as TargetKind, id: args.via.slice(split + 1) };
    }
    return null;
  }

  wrap(name: string, readOnly: boolean, handler: Handler, nativeOrgId = false): Handler {
    const routed = this.wrapConnected(name, readOnly, handler, nativeOrgId);
    return (args, ...extra) => this.enabled ? routed(args, ...extra) : handler(args, ...extra);
  }

  private wrapConnected(name: string, readOnly: boolean, handler: Handler, nativeOrgId = false): Handler {
    if (GLOBAL.has(name)) return handler;
    // The routing argument stays out of business payloads; a tool with its own
    // `orgId` parameter gets the picked workspace when the caller named none.
    const invoke: Handler = (args, ...extra) => {
      const { orgId, ...businessArgs } = args;
      return handler(
        nativeOrgId ? { ...args, orgId: orgId ?? this.active.getStore()?.orgId } : businessArgs,
        ...extra,
      );
    };
    if (CONNECTION.has(name)) return (args) => this.connectionTool(name, args);

    return async (args, ...extra) => {
      let workspaces: AssistantWorkspace[];
      let explicit: AssistantWorkspace | undefined;
      let target: { kind: TargetKind; id: string } | null;
      try {
        workspaces = await this.workspaces();
        if (typeof args.orgId === 'string' && args.orgId) {
          explicit = workspaces.find((w) => w.orgId === args.orgId);
          if (!explicit) {
            // A workspace joined since the last read, or one this connection
            // does not work in. The live roster decides which.
            workspaces = await this.workspaces(true);
            explicit = workspaces.find((w) => w.orgId === args.orgId);
            if (!explicit) {
              return refusal(
                'WORKSPACE_NOT_CONNECTED',
                'This connection does not work in that workspace.',
                workspaces,
              );
            }
          }
        }
        target = this.target(args);

      } catch (error) {
        return refusal(
          'CONNECTION_REQUEST_FAILED',
          error instanceof Error ? error.message : String(error),
        );
      }

      if (target) {
        // The target rides with the actual API call, including any preparatory
        // grant discovery. HTTP chooses the assistant; no resolve round trip.
        return withAssistantRequest({orgId: explicit?.orgId, resource: `${target.kind}:${target.id}`},
          () => this.active.run({orgId: explicit?.orgId ?? '', name: explicit?.name ?? '', agentId: ''}, () => invoke(args, ...extra)));
      }
      if (explicit) return this.run(explicit, args, extra, invoke);
      if (readOnly && SAME_EVERYWHERE.has(name) && workspaces.length) {
        return this.run(workspaces[0]!, args, extra, invoke, false);
      }
      if (readOnly && workspaces.length > 1) {
        const runs = await Promise.all(
          workspaces.map(async (w) => ({ workspace: w, raw: await this.run(w, args, extra, invoke, false) })),
        );
        // The same refusal from every workspace is one refusal: a bad input is
        // bad everywhere, and splitting it per workspace made an error read as
        // a success-shaped answer.
        const first = runs[0]!.raw;
        if (
          first.isError &&
          runs.every((r) => r.raw.isError && r.raw.content[0]?.text === first.content[0]?.text)
        ) {
          return first;
        }
        const rows = ONE_ROW_PER_ID[name];
        if (rows) {
          const merged = mergeRows(runs.map((r) => ({ workspace: r.workspace, raw: r.raw })), rows.list, rows.id);
          if (merged) return result(merged);
        }
        return result({
          workspaces: runs.map((r) => ({
            orgId: r.workspace.orgId,
            name: r.workspace.name,
            result: parsed(r.raw),
          })),
        });
      }
      if (workspaces.length === 1) return this.run(workspaces[0]!, args, extra, invoke);
      return refusal(
        'WORKSPACE_SELECTION_REQUIRED',
        workspaces.length
          ? ASK_YOUR_HUMAN
          : 'This connection works in no workspace. Turn Works here on in a workspace, or connect again.',
        workspaces,
      );
    };
  }

  /** The connection's own reads and acks: never routed, always live. */
  private async connectionTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (name === 'ziggs_inbox_defer') {
        return result(await this.client.park(String(args.agreementId)));
      }
      if (name === 'ziggs_inbox_ack') {
        return result({
          acked: await this.client.ack(String(args.ack), args.handledDeliveryIds as string[] | undefined),
        });
      }
      if (name === 'ziggs_workspace_sync') {
        const synced = await this.client.request<{ workspaces: AssistantWorkspace[] }>('workspaces/sync', {});
        this.remember(synced.workspaces);
        return result(synced);
      }
      if (name === 'ziggs_inbox_claim') {
        const inbox = await this.client.inbox(0, false);
        const workspaces = inbox.workspaces as AssistantWorkspace[] | undefined;
        if (Array.isArray(workspaces)) this.remember(workspaces);
        const deliveryCount = Array.isArray(inbox.deliveries) ? inbox.deliveries.length : 0;
        return compactTextResult({ claimed: true, deliveryCount });
      }
      if (name === 'ziggs_inbox') {
        const inbox = await this.client.inbox(Number(args.waitSeconds ?? 0), this.directory && name === 'ziggs_inbox');
        const workspaces = inbox.workspaces as AssistantWorkspace[] | undefined;
        if (Array.isArray(workspaces)) this.remember(workspaces);
        const self = { agentId: '', agentIds: inbox.agentIds as string[] };
        const news = formatInboxToolResult(
          inbox as unknown as InboxEnvelope,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          self,
        );
        const pending: Record<string, unknown> =
          args.waitSeconds == null
            ? formatPendingDecisionsPayload(inbox as unknown as InboxEnvelope, resolveWebAppOrigin(), {
                withSessionCard: true,
              })
            : {};
        // The connection door gets the same compact read and the same
        // counter note as the compact door; this path builds its own result,
        // so it has to ask for both.
        const note = windowNote(
          news.deliveries,
          self.agentIds ?? [],
        );
        return compactTextResult({
          ...news,
          ...pending,
          ...(args.waitSeconds == null ? { rules: sessionRules('directory') } : {}),
          ...(note && typeof pending.notice === 'string' ? { notice: `${pending.notice} ${note}` } : {}),
          session: { workspaces },
          instruction: `deliveries.forYou is your work; deliveries.forYourPerson is for your person to see. ${ASK_YOUR_HUMAN}`,
        }, { agentIds: self.agentIds ?? [] });
      }
      if (name === 'ziggs_inbox_show') {
        // A snapshot: the card observes the inbox and takes nothing.
        const inbox = await this.client.inbox(0, true);
        const workspaces = inbox.workspaces as AssistantWorkspace[] | undefined;
        if (Array.isArray(workspaces)) this.remember(workspaces);
        return inboxCardResult(
          formatPendingDecisionsPayload(inbox as unknown as InboxEnvelope, resolveWebAppOrigin(), {
            withSessionCard: true,
          }),
        );
      }
      if (name === 'ziggs_notification_status') {
        return result(await this.client.eventStatus(args.orgId as string));
      }
      if (name === 'ziggs_inbox_changes') {
        return result(await this.client.getChanges({
          cursor: args.cursor as string | undefined,
          waitSeconds: args.waitSeconds as number | undefined,
        }));
      }
      if (name === 'ziggs_inbox_peek') {
        return result(await this.client.request(`inbox/peek?wait=${Number(args.waitSeconds ?? 0)}`));
      }
      const workspaces = await this.workspaces(true);
      if (name === 'ziggs_auth_status') return result({ ok: true, workspaces });
      return result({ count: workspaces.length, orgs: workspaces });
    } catch (error) {
      if (
        name === 'ziggs_notification_status' ||
        name === 'ziggs_inbox_changes' ||
        name === 'ziggs_inbox_ack'
      )
        return toolError(error);
      return refusal(
        'CONNECTION_REQUEST_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Run the tool as one assistant. The result says which workspace it ran in
   * (`workspace: { orgId, name }` on an object result) unless the caller
   * already knows, as a fan-out does.
   */
  private async run(
    workspace: AssistantWorkspace,
    args: Record<string, unknown>,
    extra: unknown[],
    handler: Handler,
    label = true,
  ): Promise<ToolResult> {
    return withAssistantRequest({ orgId: workspace.orgId }, () => this.active.run(workspace, async () => {
      const response = await handler(args, ...extra);
      if (!label || response.isError) return response;
      return {
        ...response,
        content: response.content.map((block) => {
          if (block.type !== 'text' || !block.text) return block;
          const value = parseJson(block.text);
          if (!value || typeof value !== 'object' || Array.isArray(value)) return block;
          return {
            ...block,
            text: JSON.stringify({
              ...(value as Record<string, unknown>),
              workspace: { orgId: workspace.orgId, name: workspace.name },
            }),
          };
        }),
      };
    }));
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A tool result as data: its JSON when it is JSON, else its text. */
/**
 * One row per record across a fan-out, each with `seenIn`: the workspaces that
 * returned it. When the copies differ, the one read from the record's own
 * workspace wins, since it is the one that carries the real `orgId`. A row with
 * no id (a `fields` projection without it) is matched on its content. Null when
 * a successful run has no such list, so the caller keeps the labelled shape.
 */
function mergeRows(
  runs: Array<{ workspace: AssistantWorkspace; raw: ToolResult }>,
  list: string,
  id: string,
): Record<string, unknown> | null {
  const ok = runs.filter((r) => !r.raw.isError);
  const failed = runs.filter((r) => r.raw.isError);
  const bodies = ok.map((r) => parsed(r.raw) as Record<string, unknown> | null);
  if (!ok.length || bodies.some((b) => !b || !Array.isArray(b[list]))) return null;

  type Row = Record<string, unknown>;
  const byKey = new Map<string, { row: Row; seenIn: Array<{ orgId: string; name: string }> }>();
  ok.forEach(({ workspace }, i) => {
    for (const row of bodies[i]![list] as Row[]) {
      const key = typeof row?.[id] === 'string' ? `id:${row[id]}` : `row:${JSON.stringify(row)}`;
      const seen = { orgId: workspace.orgId, name: workspace.name };
      const entry = byKey.get(key);
      if (!entry) {
        byKey.set(key, { row, seenIn: [seen] });
        continue;
      }
      // Kept copy not from the record's own workspace, this one is: take it.
      const keptIsHome = entry.seenIn.some((w) => w.orgId === entry.row.orgId);
      if (!keptIsHome && row.orgId === workspace.orgId) entry.row = row;
      entry.seenIn.push(seen);
    }
  });
  const merged = [...byKey.values()].map(({ row, seenIn }) => ({ ...row, seenIn }));
  const { [list]: _rows, count: _count, ...rest } = bodies[0]!;
  return {
    ...rest,
    count: merged.length,
    [list]: merged,
    ...(failed.length
      ? {
          failedIn: failed.map((r) => ({
            orgId: r.workspace.orgId,
            name: r.workspace.name,
            result: parsed(r.raw),
          })),
        }
      : {}),
  };
}

function parsed(response: ToolResult): unknown {
  const block = response.content[0];
  if (!block?.text) return null;
  const value = parseJson(block.text);
  return value === undefined ? block.text : value;
}
