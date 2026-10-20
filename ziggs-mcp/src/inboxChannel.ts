import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AssistantConnectionClient,
  decodeOperatorKeyClaims,
  InboxClient,
  type Creds,
} from '@ziggs-ai/api-client';

export type InboxChangesOptions = NonNullable<Parameters<InboxClient['getChanges']>[0]>;
export type InboxChangesResult = Awaited<ReturnType<InboxClient['getChanges']>>;

/**
 * The Claude Code channel: an open Claude Code session hears new Ziggs mail
 * within seconds, without polling a tool.
 *
 * A local (stdio) server that declares `experimental['claude/channel']` may
 * push `notifications/claude/channel`; Claude Code puts each one in front of
 * the model as a `<channel>` tag. The server holds the inbox observation
 * long-poll (`/inbox/changes`) and rings once per new delivery.
 *
 * It rings, it does not deliver. An event carries references only (kind and
 * ids), never message text: what a counterparty wrote would otherwise land in
 * the session as if the person had typed it. The model reads the mail through
 * the inbox tools, so claiming, acknowledging and who handles the work stay
 * exactly where they are. Observation itself never claims or acknowledges.
 *
 * Off unless `ZIGGS_MCP_CHANNEL` is set, and Claude Code also has to load the
 * server as a channel (`--dangerously-load-development-channels server:<name>`
 * while channels are a research preview). Without that, Claude Code drops the
 * events and the long-poll costs no tokens.
 */
export const CHANNEL_CAPABILITY = { 'claude/channel': {} };
export const CHANNEL_NOTIFICATION = 'notifications/claude/channel';

/** The longest hold `/inbox/changes` grants. */
const HOLD_SECONDS = 110;
const RETRY_MS = [1_000, 5_000, 15_000, 60_000];

type Delivery = InboxChangesResult['deliveries'][number];
type Observe = (options: InboxChangesOptions) => Promise<InboxChangesResult>;

export interface ChannelEvent {
  content: string;
  meta: Record<string, string>;
}

/** The observation read for these credentials: the agent's, or the connection's. */
export function observeFor(creds: Creds): Observe {
  if (decodeOperatorKeyClaims(creds.operatorKey)?.connectionClientId) {
    const client = new AssistantConnectionClient(creds);
    return (options) => client.getChanges(options);
  }
  const inbox = new InboxClient(creds.operatorKey, creds.agentId, undefined, creds.instanceId, {
    clientSessionId: creds.clientSessionId,
    workspaceIds: creds.workspaceIds,
    app: creds.app,
    sessionName: creds.sessionName,
  });
  return (options) => inbox.getChanges(options);
}

/** One delivery as a channel event: what arrived and where, never what it says. */
export function channelEvent(delivery: Delivery, agentId?: string): ChannelEvent {
  const forYou = !!agentId && delivery.assigneeId === agentId;
  const meta: Record<string, string> = { kind: delivery.kind, resource_id: delivery.resourceId };
  if (delivery.chatId) meta.chat_id = delivery.chatId;
  if (delivery.taskId) meta.task_id = delivery.taskId;
  if (delivery.agreementId) meta.agreement_id = delivery.agreementId;
  if (delivery.orgId) meta.org_id = delivery.orgId;
  if (forYou) meta.for_you = 'true';
  if (delivery.needsHuman) meta.needs_human = 'true';
  const who = forYou ? ' It is assigned to you.' : delivery.needsHuman ? ' It asks for your person.' : '';
  return {
    content: `New Ziggs mail (${delivery.kind.replace(/_/g, ' ')}).${who} Read it with ziggs_inbox and follow its rules.`,
    meta,
  };
}

/** Mail that was already waiting when the session started, as one event. */
export function backlogEvent(count: number): ChannelEvent {
  return {
    content: `${count} ${count === 1 ? 'item was' : 'items were'} already waiting in Ziggs when this session started. Read them with ziggs_inbox when you are free.`,
    meta: { kind: 'backlog', count: String(count) },
  };
}

function apiStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/**
 * Watch the inbox and ring the session for each new delivery. Starts by
 * folding whatever was already waiting into one event, so a session does not
 * open to a wall of tags. Returns a stop function.
 */
export function startInboxChannel(
  server: McpServer,
  observe: Observe,
  options: { agentId?: string; holdSeconds?: number; log?: (line: string) => void } = {},
): () => void {
  const stop = new AbortController();
  const signal = stop.signal;
  const hold = options.holdSeconds ?? HOLD_SECONDS;
  const log = options.log ?? ((line: string) => process.stderr.write(`[ziggs-mcp channel] ${line}\n`));
  const ring = (event: ChannelEvent) =>
    server.server.notification({ method: CHANNEL_NOTIFICATION, params: { ...event } });

  void (async () => {
    let cursor: string | undefined;
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (cursor === undefined) {
          // Catch up without a hold: what is retained now is the backlog.
          let waiting = 0;
          let page: InboxChangesResult;
          do {
            page = await observe({ cursor, signal });
            cursor = page.cursor;
            waiting += page.deliveries.length;
          } while (page.hasMore && !signal.aborted);
          if (waiting > 0 && !signal.aborted) await ring(backlogEvent(waiting));
        }
        const page = await observe({ cursor, waitSeconds: hold, signal });
        cursor = page.cursor;
        failures = 0;
        for (const delivery of page.deliveries) {
          if (signal.aborted) break;
          await ring(channelEvent(delivery, options.agentId));
        }
      } catch (error) {
        if (signal.aborted) break;
        // An expired cursor starts over from what is retained.
        if (apiStatus(error) === 410) { cursor = undefined; continue; }
        const wait = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)];
        failures += 1;
        log(`inbox watch failed (${(error as Error)?.message ?? String(error)}); retrying in ${wait / 1000}s`);
        await sleep(wait, signal);
      }
    }
  })();

  return () => stop.abort();
}
