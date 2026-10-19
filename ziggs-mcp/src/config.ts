import 'dotenv/config';
import { z } from 'zod';
import { configureApiClient, resolveDelegateCreds } from '@ziggs-ai/api-client';
import {
  MINT_KEY_HELP,
  decodeOperatorKeyClaims,
  isDirectoryBoarded,
} from './operatorKey.js';

const envSchema = z.object({
  ZIGGS_API_URL: z.string().optional(),
  HTTP_URL: z.string().optional(),
  /** Web app base URL for constructing shareable links. Defaults to https://ziggsai.com. */
  ZIGGS_WEB_URL: z.string().optional(),
  ZIGGS_OPERATOR_KEY: z.string().min(1, 'ZIGGS_OPERATOR_KEY is required'),
  /** Optional when the operator key is agent-scoped. */
  ZIGGS_AGENT_ID: z.string().optional(),
  /** Human user id for payer-side proposals — defaults the payer on propose/publish tools. */
  ZIGGS_OWNER_USER_ID: z.string().optional(),
  /**
   * The lane this server's calls belong to — a chat id, or `agrn-<agreementId>`.
   * Sent as `X-Ziggs-Lane` on every fenced call. Unset means the agent acts for
   * itself, which is right for a person who configured this server with their
   * own key, and wrong for a delegate that has been hired: that one holds
   * grants its CUSTOMER gave, and the server refuses those to a wake that
   * states no lane.
   */
  ZIGGS_LANE_ID: z.string().optional(),
  /**
   * Pins this server's inbox host identity (`X-Ziggs-Instance`).
   *
   * One host owns an agent's inbox and a second is refused for 220 seconds, so
   * a stdio server that a SCHEDULER respawns per run — the NanoClaw
   * one-minute task starting `npx @ziggs-ai/ziggs-mcp` — is a new host every
   * run and is refused by the previous run's lease. Set this to the same value
   * on every run and they are one host. A server that stays up needs nothing:
   * its process is its host.
   */
  ZIGGS_INSTANCE_ID: z.string().optional(),
  /**
   * Workspaces this window reads, comma-separated org ids. Sent as
   * `X-Ziggs-Workspaces`. Unset reads everything the assistant may read.
   * A hosted connection sets the header on the MCP request instead; this
   * process serves every window, so it must not take the list from the env.
   */
  ZIGGS_WORKSPACES: z.string().optional(),
  /** Label on the assistant page, such as "Claude Code". */
  ZIGGS_APP: z.string().optional(),
  /** Person-readable window name. Unset becomes the app plus the time. */
  ZIGGS_SESSION_NAME: z.string().optional(),
  /** Set to 1/true/yes to register internal/debug-only MCP tools. */
  ZIGGS_MCP_DEBUG: z.string().optional(),
  /**
   * Set to 1/true/yes to register only the core everyday/session-start tools,
   * skipping the heavy groups (payments, links, marketplace, connections) to
   * cut cold-start deferred-loading (#7). Unset = all tools register.
   */
  ZIGGS_MCP_CORE_ONLY: z.string().optional(),
});

type EnvConfig = z.infer<typeof envSchema>;

export interface ZiggsMcpConfig extends EnvConfig {
  /** Resolved delegate agent — from boundAgentId or ZIGGS_AGENT_ID. */
  resolvedAgentId: string;
  /** When true, register internal/debug-only tools such as ziggs_smoke_impersonation. */
  debugTools: boolean;
  /**
   * When true, register only the core everyday/session-start tool tier and skip
   * the heavy groups (payments, links, marketplace, connections) #7.
   */
  coreOnly: boolean;
  /**
   * True unless the credential was minted by the MCP OAuth consent flow.
   *
   * The consent flow is how a connected assistant (Claude, ChatGPT, Cursor)
   * boards, and it is the door the connector directory hands out. A store
   * reviewer has to be able to tell from a tool's definition what it will do,
   * so that surface carries no tool whose target is whatever the caller names
   * with a freeform payload: the connection rail. Everyone else configured
   * this server themselves with an operator key, on stdio or against the
   * remote endpoint, and gets the compact catalog surface. Directory credentials
   * instead list every permitted tool individually, with no generic dispatch.
   *
   * The line is the credential, not the transport. The backend stamps
   * `issuedVia: "mcp_oauth"` on the tokens the consent flow mints, and this is
   * that stamp read back. It decides which tools are registered, not what a
   * call may do: every call is still authorized by the backend.
   */
  directConnection: boolean;
  /**
   * The serving backend delivers `ziggs.inbox.updated` events to hosts that
   * subscribe (its `MCP_EVENTS_ENABLED`). Only the remote server knows, so it
   * sets this; stdio leaves it unset. Adds one rule to the directory door's
   * connect text, inside that text's budget.
   */
  eventsEnabled?: boolean;
}

/** Parse a truthy env flag (1/true/yes) — shared by ZIGGS_MCP_DEBUG and ZIGGS_MCP_CORE_ONLY. */
function parseBoolFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Load delegate credentials from the environment. */
export function loadConfig(): ZiggsMcpConfig {
  const raw = {
    ZIGGS_API_URL: process.env.ZIGGS_API_URL,
    HTTP_URL: process.env.ZIGGS_API_URL ?? process.env.HTTP_URL,
    ZIGGS_WEB_URL: process.env.ZIGGS_WEB_URL,
    ZIGGS_OPERATOR_KEY: process.env.ZIGGS_OPERATOR_KEY,
    ZIGGS_AGENT_ID: process.env.ZIGGS_AGENT_ID,
    ZIGGS_OWNER_USER_ID: process.env.ZIGGS_OWNER_USER_ID,
    ZIGGS_LANE_ID: process.env.ZIGGS_LANE_ID,
    ZIGGS_INSTANCE_ID: process.env.ZIGGS_INSTANCE_ID,
    ZIGGS_WORKSPACES: process.env.ZIGGS_WORKSPACES,
    ZIGGS_APP: process.env.ZIGGS_APP,
    ZIGGS_SESSION_NAME: process.env.ZIGGS_SESSION_NAME,
    ZIGGS_MCP_DEBUG: process.env.ZIGGS_MCP_DEBUG,
    ZIGGS_MCP_CORE_ONLY: process.env.ZIGGS_MCP_CORE_ONLY,
  };
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`ziggs-mcp: missing or invalid env (${missing}). ${MINT_KEY_HELP}`);
  }

  let resolvedAgentId: string;
  let httpUrl: string | undefined;
  try {
    const delegate = resolveDelegateCreds({
      ZIGGS_API_URL: parsed.data.ZIGGS_API_URL,
      HTTP_URL: process.env.HTTP_URL,
      ZIGGS_OPERATOR_KEY: parsed.data.ZIGGS_OPERATOR_KEY,
      ZIGGS_AGENT_ID: parsed.data.ZIGGS_AGENT_ID,
    });
    resolvedAgentId = delegate.agentId;
    httpUrl = delegate.httpUrl;
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }

  // api-client reads injected config, not the environment. ZIGGS_API_URL beats
  // HTTP_URL inside resolveDelegateCreds, so a dev checkout's .env cannot
  // send a key that named its own API URL to localhost.
  if (httpUrl) {
    process.env.HTTP_URL = httpUrl;
    configureApiClient({ httpUrl });
  }

  return {
    ...parsed.data,
    resolvedAgentId,
    debugTools: parseBoolFlag(parsed.data.ZIGGS_MCP_DEBUG),
    coreOnly: parseBoolFlag(parsed.data.ZIGGS_MCP_CORE_ONLY),
    directConnection: !isDirectoryBoarded(
      decodeOperatorKeyClaims(parsed.data.ZIGGS_OPERATOR_KEY),
    ),
  };
}
