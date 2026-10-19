import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConnectionsClient } from '@ziggs-ai/api-client';
import { defineTool, type ToolDefinition } from '../../../tools/defineTool.js';
import { credsFromToolContext } from '../../../tools/toolCreds.js';
import { resolveZiggsGatewayTarget } from '../../../mcp/createMcpAgent.js';

type Ctx = Record<string, unknown>;

/**
 * Calling a tool on a connected MCP server, one shot.
 *
 * `connection_proxy` cannot do this. That path resolves a NAMED connector from
 * `connection.provider` and checks the action against its fixed action list; a
 * remote MCP server is stored with `provider: 'mcp'`, which no connector matches,
 * so every attempt came back "Unknown provider: mcp". A hosted agent therefore had
 * no way to use an MCP connection at all — found when a Linear grant was issued to
 * `shipped-digest` and its task still failed after two proxy attempts.
 *
 * The gateway (`POST /connections/:id/mcp`) has always been the right door and is
 * already in production; what was missing was a tool that walks through it. The
 * transport, headers and MCP handshake are the same ones `createMcpAgent`'s `ziggs`
 * transport uses — reused rather than re-derived, so a change to the gateway
 * contract lands in one place.
 *
 * Discovery is deliberate: with no `connectionId`/`grantId` the tool asks
 * `GET /grants` for the agent's own live connection grants. One connection means
 * no argument to guess; several means the caller must name one, because picking
 * for them is how an agent reads the wrong workspace and reports it as fact.
 */
async function resolveTarget(
  ctx: Ctx,
  toolName: string,
  connectionId?: string,
  grantId?: string,
): Promise<{ connectionId: string; grantId: string }> {
  if (connectionId && grantId) return { connectionId, grantId };

  const creds = credsFromToolContext(ctx, toolName);

  // The lane belongs here as much as on the call itself: the grant list answers
  // for the party the wake acts for, so a lane-less list is the agent's OWN
  // grants only — and this is the path that PICKS one when the caller named no
  // connection. Without it a hired agent discovers nothing and reports "no live
  // connection grant" while holding its customer's.
  //
  // No explicit baseUrl: ConnectionsClient already resolves it the way the fleet
  // configures it (HTTP_URL). Passing BACKEND_URL here was the same mistake as in
  // the transport — undefined in deployment.
  const groups = await new ConnectionsClient(
    creds.operatorKey,
    creds.agentId,
    undefined,
    creds.laneId,
  ).listForHolder();
  const live = groups.filter((g) => (g.grants ?? []).length > 0);

  if (live.length === 0) {
    throw new Error(
      'No live connection grant. Ask the connection owner to issue one for this agent, then retry.',
    );
  }
  const chosen = connectionId
    ? live.find((g) => g.connectionId === connectionId)
    : live.length === 1
      ? live[0]
      : undefined;
  if (!chosen) {
    throw new Error(
      `Name the connection to use — grants exist on ${live
        .map((g) => g.connectionId)
        .join(', ')}`,
    );
  }
  const grant = grantId
    ? (chosen.grants ?? []).find((g) => g.grantId === grantId)
    : (chosen.grants ?? [])[0];
  if (!grant) {
    throw new Error(`No live grant on ${chosen.connectionId} for this agent`);
  }
  return { connectionId: chosen.connectionId, grantId: grant.grantId };
}

async function withClient<T>(
  ctx: Ctx,
  toolName: string,
  connectionId: string,
  grantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  /**
   * The lane comes from `credsFromToolContext`, the same reader every other
   * tool uses. Reading it off a field of its own (`ctx.laneId`) is how this
   * door came to send no lane at all: the executor states the lane as
   * `chatId` / `sessionId`, so a key by any other name is always undefined,
   * and the gateway then resolves the wake to the agent's own operator and
   * refuses every grant its customer gave it.
   */
  const creds = credsFromToolContext(ctx, toolName);
  const target = resolveZiggsGatewayTarget(
    {
      type: 'ziggs',
      connectionId,
      grantId,
      operatorKey: creds.operatorKey,
      agentId: creds.agentId,
    },
    {
      agentId: creds.agentId,
      laneId: creds.laneId,
    },
  );
  const transport = new StreamableHTTPClientTransport(target.url, {
    requestInit: { headers: target.headers },
  });
  const client = new Client({ name: 'ziggs-agent-sdk', version: '1.0.0' });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    // A leaked session holds an upstream connection open on the gateway.
    await client.close().catch(() => {});
  }
}

export const mcpToolsListTool: ToolDefinition = defineTool(
  'mcp_tools_list',
  {
    connectionId: {
      type: 'string',
      description:
        'Connection to inspect. Omit when you hold a grant on exactly one — it is then resolved for you.',
    },
    grantId: {
      type: 'string',
      description: 'Grant to use. Omit to use the live grant found on that connection.',
    },
    names: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Tool names to return the FULL parameters (inputSchema) for. Omit to get the names and descriptions only — a whole server of schemas is tens of thousands of characters and gets cut, which is worse than not asking.',
    },
  },
  async (args, ctx) => {
    const t = await resolveTarget(
      ctx as Ctx,
      'mcp_tools_list',
      args['connectionId'] as string | undefined,
      args['grantId'] as string | undefined,
    );
    /**
     * Names first, schemas on demand — the same two-step this platform's own MCP
     * surface settled on. One Linear server answers 53 tools and 78,000
     * characters of schema; asking for all of it fills a wake with parameters for
     * tools the agent will not call, and the cut lands mid-schema where the half
     * that survives still looks complete.
     */
    const wanted = (args['names'] as string[] | undefined)?.filter((n) => typeof n === 'string' && n);
    const tools = await withClient(ctx as Ctx, 'mcp_tools_list', t.connectionId, t.grantId, async (c) => {
      const res = await c.listTools();
      const rows = res.tools ?? [];
      const picked = wanted?.length ? rows.filter((tool) => wanted.includes(tool.name)) : rows;
      return picked.map((tool) => ({
        name: tool.name,
        description: tool.description ?? null,
        /**
         * The parameters, which this used to drop.
         *
         * Without them an agent has to GUESS what a tool takes, and a guessed
         * argument is not an error — most servers ignore what they do not know
         * and answer with an empty list. That empty list then reads as "nothing
         * happened": a weekly digest reported one item shipped for a week with
         * fifty, because `status`, `filter.state.name` and `updatedAfter` were
         * all invented and all silently matched nothing.
         */
        ...(wanted?.length ? { inputSchema: tool.inputSchema ?? null } : {}),
      }));
    });
    const missing = wanted?.filter((n) => !tools.some((row) => row.name === n)) ?? [];
    const bounded = boundMcpResult({ tools }, MAX_MCP_TOOLS_LIST_CHARS);
    return {
      connectionId: t.connectionId,
      grantId: t.grantId,
      ...(bounded.result as { tools?: unknown }),
      ...(bounded.truncated ? { truncated: bounded.truncated } : {}),
      ...(missing.length ? { notFound: missing } : {}),
      ...(wanted?.length
        ? {}
        : {
            note: 'Names and descriptions only. Call again with names:["<tool>"] to get that tool\'s parameters before you pass any arguments — a parameter the server does not declare is usually ignored, and the empty result reads as real emptiness.',
          }),
    };
  },
  {
    description:
      "List the tools a connected MCP server exposes, through the Ziggs gateway. Names and descriptions by default; pass names:[\"<tool>\"] for those tools' full parameters (inputSchema) — the owner's credential stays server-side. Read the schema before calling a tool with arguments: a parameter the server does not declare is usually ignored rather than rejected, so a guessed filter comes back as an empty result that looks like real emptiness. The grant may allow only some tools; a call outside it is refused by the gateway, not by you.",
  },
);

/**
 * How much of one MCP tool result a wake will carry.
 *
 * A remote MCP server hands back the upstream API's payload verbatim, and those
 * are sized for programs, not for a context window: GitHub's `list_pull_requests`
 * with no paging argument answered ~150,000 characters. Past the runtime's limit
 * the result stops being a result — the Claude SDK spills an oversized tool
 * result to a file, and a hosted agent has no filesystem tool to read it with, so
 * the wake ends in "the answer was too big and I cannot see it". Same class of
 * problem as an MCP server that ships a 30K-character tool description, one layer
 * later.
 *
 * A bounded answer with a marker beats an unreadable one: the model can act on
 * "truncated, narrow the call", and it cannot act on a file path.
 */
export const MAX_MCP_RESULT_CHARS = 24_000;

/**
 * Tool schemas are bigger than tool results and are read once per wake, so they
 * get their own, larger ceiling — a schema cut in half is worse than useless,
 * because the half that survives looks complete.
 */
export const MAX_MCP_TOOLS_LIST_CHARS = 60_000;

const TRUNCATION_ADVICE =
  'Narrow the call instead of repeating it: most servers take paging (perPage/page) ' +
  'or filter arguments, and a named target usually has a narrower tool than a list.';

/**
 * Bound one MCP result, telling the model plainly what was cut.
 *
 * Text blocks are cut individually rather than the JSON being sliced, because a
 * sliced JSON string is invalid and a model handed invalid JSON reports the
 * server as broken.
 */
export function boundMcpResult(
  result: unknown,
  max: number = MAX_MCP_RESULT_CHARS,
): { result: unknown; truncated?: Record<string, unknown> } {
  const whole = JSON.stringify(result) ?? '';
  if (whole.length <= max) return { result };

  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) {
    return {
      result: { text: whole.slice(0, max) },
      truncated: {
        originalChars: whole.length,
        keptChars: max,
        note: `Result was ${whole.length} characters and is cut to ${max}. ${TRUNCATION_ADVICE}`,
      },
    };
  }

  const kept: unknown[] = [];
  let used = 0;
  let dropped = 0;
  for (const block of content) {
    const text = (block as { text?: unknown })?.text;
    if (typeof text !== 'string') {
      const size = (JSON.stringify(block) ?? '').length;
      if (used + size > max) {
        dropped += 1;
        continue;
      }
      used += size;
      kept.push(block);
      continue;
    }
    const room = max - used;
    if (room <= 0) {
      dropped += 1;
      continue;
    }
    if (text.length <= room) {
      used += text.length;
      kept.push(block);
      continue;
    }
    kept.push({
      ...(block as Record<string, unknown>),
      text: `${text.slice(0, room)}\n\n[…cut here: this block was ${text.length} characters]`,
    });
    used = max;
  }

  return {
    result: { ...(result as Record<string, unknown>), content: kept },
    truncated: {
      originalChars: whole.length,
      keptChars: used,
      droppedBlocks: dropped,
      note: `Result was ${whole.length} characters, over the ${max}-character limit, so it is cut. What you have is the beginning, not the whole answer — do not report it as complete. ${TRUNCATION_ADVICE}`,
    },
  };
}

export const mcpToolCallTool: ToolDefinition = defineTool(
  'mcp_tool_call',
  {
    tool: {
      type: 'string',
      required: true,
      description: 'Tool name on the connected MCP server, e.g. list_issues.',
    },
    args: {
      type: 'object',
      description: "Arguments for that tool, as the server's schema defines them.",
    },
    connectionId: {
      type: 'string',
      description:
        'Connection to call through. Omit when you hold a grant on exactly one.',
    },
    grantId: {
      type: 'string',
      description: 'Grant to use. Omit to use the live grant found on that connection.',
    },
  },
  async (args, ctx) => {
    const name = args['tool'] as string;
    if (!name) throw new Error('tool is required');
    const t = await resolveTarget(
      ctx as Ctx,
      'mcp_tools_list',
      args['connectionId'] as string | undefined,
      args['grantId'] as string | undefined,
    );
    const raw = await withClient(ctx as Ctx, 'mcp_tool_call', t.connectionId, t.grantId, (c) =>
      c.callTool({
        name,
        arguments: (args['args'] as Record<string, unknown>) ?? {},
      }),
    );
    const bounded = boundMcpResult(raw);
    return {
      connectionId: t.connectionId,
      tool: name,
      result: bounded.result,
      ...(bounded.truncated ? { truncated: bounded.truncated } : {}),
    };
  },
  {
    description:
      "Call one tool on a connected MCP server through the Ziggs gateway. Use this for a connection whose provider is a remote MCP server — connection_proxy is for named connectors (github, jira) and refuses these with \"Unknown provider: mcp\". The gateway injects the owner's token upstream and checks the tool name against your grant, so you never hold the credential. Discover names with mcp_tools_list, or read allowed_actions off the grant in grant_list. Results are bounded: a payload over the limit comes back cut, with a `truncated` field saying so — pass the server's paging or filter arguments rather than repeating the call.",
  },
);

export const MCP_CONNECTION_TOOLS: ToolDefinition[] = [mcpToolsListTool, mcpToolCallTool];
