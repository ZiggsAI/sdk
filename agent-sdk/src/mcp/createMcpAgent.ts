import { resolveWebAppOrigin, connectionsSettingsAppUrl, assistantRequestHeaders, currentWorkExecution } from '@ziggs-ai/api-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConnectionsClient } from '@ziggs-ai/api-client';
import { resolveBackendUrl } from '../shared/backendUrl.js';
import { createAgent, type Agent, type AgentOptions } from '../Agent.js';
import type { ToolDefinition } from '../tools/defineTool.js';
import { laneFromToolContext } from '../tools/toolCreds.js';
import { thinkingDefaults } from '../runtime/defaults.js';
import type { Workflow } from '../types.js';

export type McpTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | {
      type: 'http';
      url: string;
      /**
       * Optional static request headers — e.g. a fixed API key the server is
       * keyed by. Sent on every request to the server. Values are used as-is;
       * `$VAR` interpolation (if any) is the caller's job, mirroring how the
       * stdio path leaves `env` interpolation to the caller.
       */
      headers?: Record<string, string>;
    }
  | {
      /**
       * Brokered connection through the Ziggs MCP gateway: the agent speaks
       * StreamableHTTP to `/connections/:id/mcp` and Ziggs injects the
       * connection owner's OAuth token upstream. The agent never holds the
       * token; every tools/call is checked against the grant's caveats.
       */
      type: 'ziggs';
      /** Connection id (`con_…`) of the user's MCP server connection. */
      connectionId: string;
      /** ConnectionGrant id (`cgr_…`) issued to this agent. */
      grantId: string;
      /** Operator key — defaults to ZIGGS_OPERATOR_KEY. */
      operatorKey?: string;
      /** Ziggs backend base URL — defaults to BACKEND_URL / ZIGGS_BACKEND_URL. */
      baseUrl?: string;
      /** Agent to impersonate (X-Agent-Id) — defaults to the agent agentId. */
      agentId?: string;
    }
  | {
      /**
       * Per-user brokered connection: the agent holds NO
       * connectionId/grantId. It speaks StreamableHTTP to
       * `/connections/mcp/relay` and asserts the invoking end-user via
       * `x-on-behalf-of-user`; the gateway resolves that user's own connection
       * + grant and injects their token. One MCP client is created per invoking
       * user so each keeps an isolated upstream session. Tool schemas cannot be
       * discovered at boot (there is no connection yet) — pass `toolSchema`.
       */
      type: 'ziggs-per-user';
      /** Operator key — defaults to ZIGGS_OPERATOR_KEY. */
      operatorKey?: string;
      /** Ziggs backend base URL — defaults to BACKEND_URL / ZIGGS_BACKEND_URL. */
      baseUrl?: string;
      /** Agent to impersonate (X-Agent-Id) — defaults to the agent agentId. */
      agentId?: string;
      /**
       * The MCP server URL this agent fronts. Not used for gateway calls (the
       * gateway derives the server from the resolved connection), but needed to
       * open a connection request when the invoking user hasn't connected yet
       *. Without it, a NO_USER_CONNECTION surfaces as an error rather
       * than an auto-created consent prompt.
       */
      serverUrl?: string;
    };

/**
 * Typed failure from the Ziggs MCP gateway. `code` is the stable
 * machine-readable reason — e.g. `GRANT_REVOKED`, `GRANT_EXPIRED`,
 * `GRANT_HOLDER_MISMATCH`, `GRANT_CONNECTION_MISMATCH` — so agent code can
 * branch ("revoked → tell the user and stop retrying" vs "network blip →
 * retry") instead of parsing transport-error prose.
 */
export class ZiggsGatewayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ZiggsGatewayError';
    this.code = code;
    this.status = status;
  }
}

/** Open gateway sessions kept per selected execution before the oldest closes. */
const MAX_WORK_SESSIONS = 16;

/**
 * Wrap fetch so structured gateway denials (401/403 with a `code` body)
 * surface as ZiggsGatewayError instead of a generic transport failure.
 */
export function wrapGatewayFetch(
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.delete('X-Ziggs-Execution');
    for (const [key, value] of Object.entries(assistantRequestHeaders())) headers.set(key, value);
    const response = await baseFetch(input, { ...init, headers });
    if (response.status === 401 || response.status === 403) {
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as { code?: unknown; message?: unknown } | null;
      if (body && typeof body.code === 'string') {
        throw new ZiggsGatewayError(
          body.code,
          typeof body.message === 'string' ? body.message : body.code,
          response.status,
        );
      }
    }
    return response;
  }) as typeof fetch;
}

/** Resolve the gateway URL + auth headers for a `type: 'ziggs'` transport. */
export function resolveZiggsGatewayTarget(
  config: Extract<McpTransportConfig, { type: 'ziggs' }>,
  defaults: { agentId?: string; laneId?: string } = {},
): { url: URL; headers: Record<string, string> } {
  if (!config.connectionId) {
    throw new Error('ziggs MCP transport requires a connectionId');
  }
  if (!config.grantId) {
    throw new Error('ziggs MCP transport requires a grantId');
  }
  const operatorKey = config.operatorKey || process.env.ZIGGS_OPERATOR_KEY;
  if (!operatorKey) {
    throw new Error(
      'ziggs MCP transport requires an operatorKey (or ZIGGS_OPERATOR_KEY)',
    );
  }
  const agentId = config.agentId || defaults.agentId;
  if (!agentId) {
    throw new Error(
      'ziggs MCP transport requires an agentId to impersonate (X-Agent-Id)',
    );
  }
  const baseUrl = resolveBackendUrl(config.baseUrl);
  return {
    url: new URL(`${baseUrl}/connections/${encodeURIComponent(config.connectionId)}/mcp`),
    headers: {
      authorization: `Bearer ${operatorKey}`,
      'x-agent-id': agentId,
      'x-grant-id': config.grantId,
      // The lane, so the broker can tell who this wake acts for. Until it was
      // sent, this door was the unfenced one: the named-connector proxy states
      // its lane, so the same account and the same grant got two different
      // answers depending on which door the agent used. Built by the shared
      // helper, because a copy of this header going missing is invisible.
      ...assistantRequestHeaders(),
    },
  };
}

/**
 * Resolve the per-user gateway URL + headers. No connectionId/grantId —
 * the gateway resolves the invoking user's own connection + grant from
 * `x-on-behalf-of-user` + the impersonated agent.
 */
export function resolvePerUserGatewayTarget(
  config: Extract<McpTransportConfig, { type: 'ziggs-per-user' }>,
  agentId: string,
  userId: string,
  onBehalfOfAgreementId?: string,
  laneId?: string,
): { url: URL; headers: Record<string, string> } {
  const operatorKey = config.operatorKey || process.env.ZIGGS_OPERATOR_KEY;
  if (!operatorKey) {
    throw new Error(
      'ziggs-per-user MCP transport requires an operatorKey (or ZIGGS_OPERATOR_KEY)',
    );
  }
  const baseUrl = resolveBackendUrl(config.baseUrl);
  return {
    url: new URL(`${baseUrl}/connections/mcp/relay`),
    headers: {
      authorization: `Bearer ${operatorKey}`,
      'x-agent-id': agentId,
      'x-on-behalf-of-user': userId,
      // when this call runs under a delegation, userId is the delegating
      // agent (senderId), not the end-user who owns the connection. The gateway
      // uses this agreement to resolve the delegation root's user.
      ...(onBehalfOfAgreementId ? { 'x-on-behalf-of-agreement': onBehalfOfAgreementId } : {}),
      // The lane, for the same reason as the path-id door above.
      ...assistantRequestHeaders(),
    },
  };
}

export interface CreateMcpAgentOptions extends Omit<AgentOptions, 'tools' | 'workflow' | 'states' | 'initial'> {
  /** MCP server connection — stdio (local process) or HTTP (remote). */
  transport: McpTransportConfig;
  /** Additional Ziggs tools to register alongside the MCP-derived ones. */
  extraTools?: ToolDefinition[];
  /** Override the default single-state thinking workflow. */
  workflow?: Workflow;
  /**
   * Max tools to bind to the LLM per turn. LLM providers cap the `tools` array
   * (OpenAI: 128); an MCP server exposing more (e.g. PostHog: 146) makes every
   * turn fail with `400 .. array too long`. When the server's tool count
   * exceeds this budget the list is truncated (and logged). Defaults to 128.
   * See; Phase 2 will replace truncation with query-aware selection.
   */
  maxTools?: number;
  /**
   * Restrict the bound tool set to only tools whose name matches one of these
   * case-insensitive substrings, applied BEFORE the maxTools cap. Lets a large
   * MCP server (e.g. PostHog's 146 tools) be narrowed to the handful this agent
   * actually needs — cutting per-turn cost and stopping the model from thrashing
   * across (or never binding) the tool it should call. Empty/undefined = bind
   * all (unchanged behavior). Phase 2 = name-based selection.
   */
  allowedTools?: string[];
  /**
   * Pre-discovered MCP tool schemas. REQUIRED for `type: 'ziggs-per-user'`
   * — there is no boot connection to call `tools/list` on, so the
   * schema is baked at provision time and passed here. Ignored for the other
   * transports, which discover tools live at boot.
   */
  toolSchema?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

/** Provider `tools` array cap (OpenAI's is 128). */
const DEFAULT_MAX_TOOLS = 128;
/** Headroom reserved for control actions (wait/respond) + future additions. */
const CONTROL_TOOL_RESERVE = 4;

/**
 * How many MCP tools may be bound to the LLM, given the provider cap and the
 * number of extra (non-MCP) tools the agent also carries. Always >= 1 so a
 * pathological config still binds something rather than nothing.
 */
export function mcpToolBudget(maxTools: number, extraToolCount: number): number {
  return Math.max(1, maxTools - CONTROL_TOOL_RESERVE - extraToolCount);
}

export interface McpAgentHandle {
  agent: Agent;
  /** Disconnect the MCP client (call on shutdown alongside agent.disconnect()). */
  closeMcp: () => Promise<void>;
  /** Names of MCP tools that were mapped to Ziggs tools on startup. */
  toolNames: string[];
}

export function buildTransport(config: McpTransportConfig, defaults: { agentId?: string } = {}) {
  if (config.type === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env,
    });
  }
  if (config.type === 'ziggs') {
    /**
     * No lane, and there cannot be one: this client is built ONCE at boot and
     * shared by every wake, so any lane baked into its headers would be the
     * wrong one for all but the first. The `ziggs` transport is the legacy
     * fleet entry (`scripts/run-mcp-fleet.ts`) — a fixed connection + grant the
     * operator configured for itself, so the lane-less fence (its own estate)
     * is the right answer for it. A per-lane client belongs to `ziggs-per-user`,
     * which builds one per wake and states the lane there.
     */
    const target = resolveZiggsGatewayTarget(config, defaults);
    return new StreamableHTTPClientTransport(target.url, {
      requestInit: { headers: target.headers },
      fetch: wrapGatewayFetch(),
    });
  }
  if (config.type === 'ziggs-per-user') {
    // Per-user transports are built lazily per invoking user in createMcpAgent
    // (each needs a different x-on-behalf-of-user header), not here.
    throw new Error('ziggs-per-user transport is created per invoking user, not via buildTransport');
  }
  return new StreamableHTTPClientTransport(
    new URL(config.url),
    config.headers && Object.keys(config.headers).length > 0
      ? { requestInit: { headers: config.headers } }
      : undefined,
  );
}

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type McpContent = { type: string; text?: string };

function mcpContentToResult(content: McpContent[]): unknown {
  const text = content
    .map(c => (c.type === 'text' ? c.text ?? '' : JSON.stringify(c)))
    .join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Calls one MCP tool. The single-client path closes over a fixed client; the
 * per-user path uses `context.senderId` to pick that user's client.
 */
type McpToolCaller = (
  toolName: string,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
) => Promise<{ isError?: boolean; content: McpContent[] }>;

function mapMcpTools(callTool: McpToolCaller, tools: McpTool[]): ToolDefinition[] {
  return tools.map(tool => ({
    schema: {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
    },
    handler: async (
      args: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => {
      const result = await callTool(tool.name, args, context);
      if (result.isError) {
        throw new Error(mcpContentToResult(result.content) as string);
      }
      return mcpContentToResult(result.content);
    },
    isGenericFallback: true,
  }));
}

function buildDefaultWorkflow(description: string, mcpTools: McpTool[]): Workflow {
  const dflt = thinkingDefaults({ initial: 'idle' });
  // Bind each MCP tool as an explicit action so runTurn includes them in the
  // LLM API call and the decision schema. Without this, allowedToolNames is
  // empty and the tools array passed to the LLM is also empty.
  const toolActions = Object.fromEntries(
    mcpTools.map(t => [t.name, {
      tool: t.name,
      prompt: { when: t.description || `Use ${t.name}` },
    }]),
  );
  return {
    id: 'mcp-agent',
    description: description || 'MCP-backed agent',
    initial: 'idle',
    states: {
      idle: {
        kind: 'thinking',
        prompt: {
          role: 'You are a helpful agent powered by an MCP server.',
          goal: description || 'Help the user by calling the available tools.',
          constraints: 'Use your tools to answer the user\'s request. After gathering results, use "respond" to send the answer. Use "wait" only when no action is needed.',
        },
        actions: {
          ...dflt.actions,
          ...toolActions,
          respond: {
            prompt: {
              instruction: 'Send your final answer to the user.',
              when: 'You have gathered enough information and are ready to reply to the user.',
              format: 'args: { receiverId: "<userId>", message: "<your answer>" }',
            },
            produces: 'message-sent',
          },
        },
        transitions: [
          { to: 'idle', when: (o) => o.kind === 'wait' },
          { to: 'idle', when: (o) => o.kind === 'error' },
          { to: 'done', when: (o) => o.kind === 'message-sent' },
        ],
      },
      done: {
        kind: 'parked',
        transitions: [
          { to: 'idle', when: (o) => o.kind === 'message-received' },
        ],
      },
    },
  };
}

/**
 * Max chars for a single tool description bound to the LLM. Verbose MCP servers
 * embed whole manuals in their descriptions (PostHog's `execute-sql` alone is
 * ~30K chars of HogQL docs; its 146 tools total ~54K tokens of descriptions) and
 * that full block rides every turn. Keep the lead — what the tool does + how to
 * call it — and drop the embedded reference; agents fetch detail via dedicated
 * schema/help tools at call time. Tunable; big enough to preserve real guidance.
 *.
 */
export const MAX_TOOL_DESC_CHARS = 2000;

/** Truncate one description at a sentence/newline boundary near the cap. */
export function trimDescription(desc: string | undefined): string | undefined {
  if (!desc || desc.length <= MAX_TOOL_DESC_CHARS) return desc;
  const slice = desc.slice(0, MAX_TOOL_DESC_CHARS);
  const boundary = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '));
  const head = boundary > MAX_TOOL_DESC_CHARS * 0.6 ? slice.slice(0, boundary + 1) : slice;
  return `${head.trimEnd()} […description truncated; use the server's schema/help tools for full detail]`;
}

/** Trim oversized descriptions across the tool set (cost control). */
function trimToolDescriptions(tools: McpTool[], agentId: string | undefined): McpTool[] {
  let trimmedCount = 0;
  let savedChars = 0;
  const out = tools.map((t) => {
    const nextDesc = trimDescription(t.description);
    if (nextDesc === t.description) return t;
    trimmedCount += 1;
    savedChars += (t.description?.length ?? 0) - (nextDesc?.length ?? 0);
    return { ...t, description: nextDesc };
  });
  if (trimmedCount > 0) {
    console.warn(
      `[createMcpAgent] ${agentId}: trimmed ${trimmedCount} oversized tool description(s) to ${MAX_TOOL_DESC_CHARS} chars, saving ~${Math.round(savedChars / 4 / 1000)}K tokens/turn.`,
    );
  }
  return out;
}

/**
 * Keep only tools whose name matches one of the allowlist substrings
 * (case-insensitive). No allowlist → pass through unchanged. Applied before the
 * maxTools cap so a targeted agent binds exactly the tools it needs.
 */
function filterToolsByAllowlist(
  tools: McpTool[],
  allowedTools: string[] | undefined,
  agentId: string | undefined,
): McpTool[] {
  if (!allowedTools || allowedTools.length === 0) return tools;
  const patterns = allowedTools.map((p) => p.toLowerCase());
  const kept = tools.filter((t) =>
    patterns.some((p) => t.name.toLowerCase().includes(p)),
  );
  console.warn(
    `[createMcpAgent] ${agentId}: tool allowlist active — bound ${kept.length}/${tools.length} tools matching [${allowedTools.join(', ')}]${kept.length === 0 ? ' ⚠️ NONE MATCHED — check patterns against the server\'s tool names' : ': ' + kept.map((t) => t.name).join(', ')}.`,
  );
  return kept;
}

/**
 * Cap the tool set bound to the LLM at the provider limit (OpenAI 128) —
 * truncate and log rather than crash — and trim oversized descriptions so the
 * bound schema doesn't ship a manual every turn. Phase 1. Shared by the
 * boot-time (single-client) and per-user paths. When `allowedTools` is set the
 * server's tools are narrowed by name first, so the cap rarely bites.
 */
function capTools(
  tools: McpTool[],
  agentId: string | undefined,
  maxTools: number,
  extraToolCount: number,
  allowedTools?: string[],
): McpTool[] {
  const allowed = filterToolsByAllowlist(tools, allowedTools, agentId);
  const trimmed = trimToolDescriptions(allowed, agentId);
  const budget = mcpToolBudget(maxTools, extraToolCount);
  if (trimmed.length <= budget) return trimmed;
  console.warn(
    `[createMcpAgent] ${agentId}: MCP server exposes ${trimmed.length} tools, over the ${maxTools}-tool LLM cap; binding the first ${budget}, dropping ${trimmed.length - budget}.`,
  );
  return trimmed.slice(0, budget);
}

/**
 * Wraps any MCP server as a Ziggs Agent.
 *
 * 1. Opens a connection to the MCP server (stdio, HTTP, or the Ziggs gateway).
 * 2. Calls tools/list and maps each tool to a Ziggs ToolDefinition.
 * 3. Returns an Agent pre-loaded with those tools, ready to connectAsync().
 *
 * Usage (local stdio server):
 *   const { agent, closeMcp } = await createMcpAgent({
 *     transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
 *     agentId: 'my-github-agent',
 *     name: 'GitHub Agent',
 *     description: 'Wraps the GitHub MCP server',
 *   });
 *   await agent.connectAsync();
 *
 * Usage (OAuth-protected remote server, brokered through Ziggs — the user
 * connected the server and issued this agent a grant; the agent never sees
 * the user's token):
 *   const { agent, closeMcp } = await createMcpAgent({
 *     transport: { type: 'ziggs', connectionId: 'con_abc', grantId: 'cgr_xyz' },
 *     agentId: 'my-notion-agent',
 *     name: 'Notion Agent',
 *     description: 'Works in the owner\'s Notion via their MCP connection',
 *   });
 *   await agent.connectAsync();
 *
 *   process.on('SIGTERM', async () => {
 *     await agent.disconnect();
 *     await agent.drain();
 *     await closeMcp();
 *   });
 */
export async function createMcpAgent(options: CreateMcpAgentOptions): Promise<McpAgentHandle> {
  const { transport: transportConfig, extraTools = [], workflow, maxTools = DEFAULT_MAX_TOOLS, allowedTools, toolSchema, ...agentOptions } = options;

  // ── Per-user path: no boot connection; one MCP client per invoking
  // user, each carrying that user's on-behalf-of header for an isolated session.
  if (transportConfig.type === 'ziggs-per-user') {
    const agentId = transportConfig.agentId || agentOptions.agentId;
    if (!agentId) {
      throw new Error('ziggs-per-user MCP transport requires an agentId to impersonate');
    }
    if (!toolSchema || toolSchema.length === 0) {
      throw new Error('ziggs-per-user MCP transport requires toolSchema (no boot connection to discover tools)');
    }
    const tools = capTools(toolSchema as McpTool[], agentId, maxTools, extraTools.length, allowedTools);

    const clients = new Map<string, Promise<Client>>();
    const clientFor = (
      userId: string,
      onBehalfOfAgreementId?: string,
      laneId?: string,
    ): Promise<Client> => {
      // Key by user + agreement + lane: the gateway may resolve a different
      // end-user per agreement (delegation), and the lane decides which party's
      // grants this session may spend, so sessions must not be shared across
      // any of the three. The headers are fixed when the transport is built,
      // so a session reused across lanes would carry the first lane's fence.
      const cacheKey = `${userId}|${onBehalfOfAgreementId ?? ''}|${assistantRequestHeaders()['X-Ziggs-Execution'] ?? ''}`;
      let p = clients.get(cacheKey);
      if (!p) {
        p = (async () => {
          const target = resolvePerUserGatewayTarget(
            transportConfig,
            agentId,
            userId,
            onBehalfOfAgreementId,
            laneId,
          );
          const transport = new StreamableHTTPClientTransport(target.url, {
            requestInit: { headers: target.headers },
            fetch: wrapGatewayFetch(),
          });
          const c = new Client({ name: 'ziggs-mcp-agent', version: '1.0.0' });
          await c.connect(transport);
          return c;
        })().catch((err: unknown) => {
          // Don't cache a failed connect (e.g. NO_USER_CONNECTION before the
          // user consents) — the next turn must be able to retry.
          clients.delete(cacheKey);
          throw err;
        });
        clients.set(cacheKey, p);
      }
      return p;
    };

    // When the invoking user hasn't connected this server, open a connection
    // request targeting THEM (X-On-Behalf-Of-User) so the consent prompt lands
    // in their inbox. The backend dedups pending requests, so retrying every
    // turn is safe.
    const backendBase = resolveBackendUrl(transportConfig.baseUrl);
    // App URL for the user-facing connect link: api.ziggsai.com → ziggsai.com.
    const appUrl = resolveWebAppOrigin(undefined, backendBase);
    const serverLabel = transportConfig.serverUrl
      ? new URL(transportConfig.serverUrl).host
      : 'the external service';
    // Open a connection request for this user; returns its id so the caller can
    // deep-link the user straight to it on the Connections page.
    // The server holds the invoking user to the people this wake may ask, so
    // the request carries the same lane as the call that missed: in the hire's
    // room that user is its customer.
    const triggerConnectionRequest = async (
      userId: string,
      laneId?: string,
    ): Promise<string | null> => {
      if (!transportConfig.serverUrl) return null;
      const operatorKey = transportConfig.operatorKey || process.env.ZIGGS_OPERATOR_KEY;
      if (!operatorKey) return null;
      try {
        const body = await new ConnectionsClient(operatorKey, agentId, backendBase).requestMcpConnection({
          serverUrl: transportConfig.serverUrl,
          tools: tools.map(t => t.name),
          onBehalfOfUserId: userId,
        });
        return ((body as { request?: { requestId?: string } })?.request?.requestId) ?? null;
      } catch {
        // Best-effort: the backend dedups pending requests and the caller falls
        // back to a plain Connections-page link when there's no requestId.
        return null;
      }
    };

    const caller: McpToolCaller = async (name, args, context) => {
      const userId = typeof context.senderId === 'string' ? context.senderId : undefined;
      if (!userId) {
        throw new Error('per-user MCP tool call requires an invoking user (context.senderId is missing)');
      }
      // for a delegated wake, senderId is the delegating agent, not the
      // connection-owning end-user; pass the agreement so the gateway resolves
      // the delegation root's user.
      const onBehalfOfAgreementId =
        typeof context.onBehalfOfAgreementId === 'string' ? context.onBehalfOfAgreementId : undefined;
      /**
       * The lane this wake runs in, read the same way every tool reads it.
       * Without it the relay states no lane, the gateway resolves the wake to
       * the agent's own operator, and any grant the CUSTOMER gave is refused —
       * on the door built for exactly that case. Omitting a lane can only
       * narrow reach, never widen it, so the miss never raises.
       */
      const laneId = laneFromToolContext(context);
      // (B): per-user resolution is intermittently flaky even when the
      // connection is valid and resolvable — the same on-behalf call fails with
      // NO_USER_CONNECTION on one wake and succeeds on the next. clientFor never
      // caches a failed connect, so each attempt re-resolves from scratch. Retry
      // a few times (with backoff) before surfacing the connect prompt, so a
      // transient miss no longer fails the whole fetch step.
      const MAX_ATTEMPTS = 3;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const c = await clientFor(userId, onBehalfOfAgreementId, laneId);
          return (await c.callTool({ name, arguments: args })) as {
            isError?: boolean;
            content: McpContent[];
          };
        } catch (err) {
          lastErr = err;
          const resolutionMiss =
            err instanceof ZiggsGatewayError && err.code === 'NO_USER_CONNECTION';
          const transient = resolutionMiss || !(err instanceof ZiggsGatewayError);
          if (attempt < MAX_ATTEMPTS && transient) {
            console.warn(
              `[createMcpAgent] per-user ${name} attempt ${attempt}/${MAX_ATTEMPTS} failed (${(err as Error).message}); retrying with a fresh connection`,
            );
            await new Promise((r) => setTimeout(r, 500 * attempt));
            continue;
          }
          break;
        }
      }
      if (
        lastErr instanceof ZiggsGatewayError &&
        lastErr.code === 'NO_USER_CONNECTION' &&
        transportConfig.serverUrl
      ) {
        const requestId = await triggerConnectionRequest(userId, laneId).catch(() => null);
        const link = connectionsSettingsAppUrl(appUrl, requestId);
        return {
          content: [
            {
              type: 'text',
              text: `ACTION NEEDED: the user has not connected ${serverLabel}. Ask them to approve the connection here: ${link} — then retry.`,
            },
          ],
        };
      }
      throw lastErr;
    };

    const agent = createAgent({
      ...agentOptions,
      workflow: workflow ?? buildDefaultWorkflow(agentOptions.description ?? '', tools),
      tools: [...mapMcpTools(caller, tools), ...extraTools],
    });
    return {
      agent,
      closeMcp: async () => {
        await Promise.all(
          [...clients.values()].map(p => p.then(c => c.close()).catch(() => {})),
        );
      },
      toolNames: tools.map(t => t.name),
    };
  }

  // ── Single-client path (stdio / http / brokered ziggs): discover tools at boot.
  const transport = buildTransport(transportConfig, { agentId: agentOptions.agentId });
  const client = new Client({ name: 'ziggs-mcp-agent', version: '1.0.0' });
  try {
    await client.connect(transport);

    const rawTools = capTools((await client.listTools()).tools as McpTool[], agentOptions.agentId, maxTools, extraTools.length, allowedTools);
    // A brokered gateway session is bound to the work it was opened in, so a
    // call made inside a selected execution opens (and keeps) a session of its
    // own; the boot session serves calls made outside any execution.
    const workClients = new Map<string, Promise<Client>>();
    const clientFor = (): Promise<Client> => {
      const work = transportConfig.type === 'ziggs' ? currentWorkExecution()?.contextId : undefined;
      if (!work) return Promise.resolve(client);
      let pending = workClients.get(work);
      if (!pending) {
        if (workClients.size >= MAX_WORK_SESSIONS) {
          const [oldest, closing] = workClients.entries().next().value as [string, Promise<Client>];
          workClients.delete(oldest);
          void closing.then(c => c.close()).catch(() => {});
        }
        const scoped = new Client({ name: 'ziggs-mcp-agent', version: '1.0.0' });
        pending = scoped
          .connect(buildTransport(transportConfig, { agentId: agentOptions.agentId }))
          .then(() => scoped);
        pending.catch(() => workClients.delete(work));
        workClients.set(work, pending);
      }
      return pending;
    };
    const caller: McpToolCaller = async (name, args) =>
      (await clientFor()).callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: McpContent[] }>;
    const mcpTools = mapMcpTools(caller, rawTools);

    const resolvedWorkflow = workflow ?? buildDefaultWorkflow(agentOptions.description ?? '', rawTools);
    const agent = createAgent({
      ...agentOptions,
      workflow: resolvedWorkflow,
      tools: [...mcpTools, ...extraTools],
    });

    return {
      agent,
      closeMcp: async () => {
        await Promise.all(
          [client, ...workClients.values()].map(c => Promise.resolve(c).then(open => open.close()).catch(() => {})),
        );
      },
      toolNames: rawTools.map((t: McpTool) => t.name),
    };
  } catch (err) {
    // Validation and tool discovery can fail after stdio has spawned a child.
    // A rejected factory must release the transport it already acquired.
    await client.close().catch(() => {});
    throw err;
  }
}
