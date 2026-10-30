import { assistantRequestHeaders, decodeOperatorKeyClaims } from '@ziggs-ai/api-client';
/**
 * Call a brokered MCP connection from the ziggs-mcp surface.
 *
 * Same door the SDK's `mcp_tool_call` / `mcp_tools_list` use
 * (`POST /connections/:id/mcp`). `ziggs_connection_proxy` cannot: it resolves
 * a named REST connector from `connection.provider`, and MCP rows are
 * `provider: 'mcp'`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ConnectionsClient,
  getBackendUrl,
  type Creds,
} from '@ziggs-ai/api-client';

export function resolveMcpGatewayTarget(opts: {
  connectionId: string;
  grantId: string;
  operatorKey: string;
  agentId: string;
  baseUrl?: string;
}): { url: URL; headers: Record<string, string> } {
  if (!opts.connectionId) throw new Error('connectionId is required');
  if (!opts.grantId) throw new Error('grantId is required');
  if (!opts.operatorKey) throw new Error('operatorKey is required');
  if (!opts.agentId && !decodeOperatorKeyClaims(opts.operatorKey)?.connectionClientId) throw new Error('agentId is required');
  const baseUrl = (opts.baseUrl || getBackendUrl()).replace(/\/$/, '');
  return {
    url: new URL(
      `${baseUrl}/connections/${encodeURIComponent(opts.connectionId)}/mcp`,
    ),
    headers: {
      authorization: `Bearer ${opts.operatorKey}`,
      ...assistantRequestHeaders(),
      'x-agent-id': opts.agentId,
      'x-grant-id': opts.grantId,
    },
  };
}

export async function resolveMcpConnectionTarget(
  creds: Creds,
  connectionId?: string,
  grantId?: string,
): Promise<{ connectionId: string; grantId: string }> {
  if (connectionId && grantId) return { connectionId, grantId };
  if (!creds.operatorKey) throw new Error('operatorKey is required');
  if (!creds.agentId && !decodeOperatorKeyClaims(creds.operatorKey)?.connectionClientId) throw new Error('agentId is required');

  // The lane matters here too: since the grant list answers for the party the
  // wake acts for, a lane-less list comes back spanning every customer this
  // agent serves — and this is the path that PICKS one when the caller named
  // no connection. baseUrl was missing as well, so it only ever worked
  // against the default backend.
  const groups = await new ConnectionsClient(
    creds.operatorKey,
    creds.agentId,
    getBackendUrl(),
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

/** Test seam — production always uses the StreamableHTTP client below. */
export type McpGatewayRunner = <T>(
  target: { url: URL; headers: Record<string, string> },
  run: (client: Client) => Promise<T>,
) => Promise<T>;

const defaultRunner: McpGatewayRunner = async (target, run) => {
  const transport = new StreamableHTTPClientTransport(target.url, {
    requestInit: { headers: target.headers },
  });
  const client = new Client({ name: 'ziggs-mcp', version: '1.0.0' });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
};

let gatewayRunner: McpGatewayRunner = defaultRunner;

/** @internal tests only */
export function setMcpGatewayRunnerForTests(runner: McpGatewayRunner | null): void {
  gatewayRunner = runner ?? defaultRunner;
}

export async function withMcpGatewayClient<T>(
  creds: Creds,
  connectionId: string,
  grantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  if (!creds.operatorKey || (!creds.agentId && !decodeOperatorKeyClaims(creds.operatorKey)?.connectionClientId)) {
    throw new Error('operatorKey and agentId are required');
  }
  const target = resolveMcpGatewayTarget({
    connectionId,
    grantId,
    operatorKey: creds.operatorKey,
    agentId: creds.agentId,
  });
  return gatewayRunner(target, run);
}
