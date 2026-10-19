import {
  connectionProxyCapability,
  requestConnectionCapability,
  ConnectionsClient,
} from '@ziggs-ai/api-client';
import { defineTool, type ToolDefinition } from '../../../tools/defineTool.js';
import { toolFromCapability } from '../../../tools/capabilityAdapter.js';
import { resolveBackendUrl } from '../../../shared/backendUrl.js';

type Ctx = Record<string, unknown>;

// connection_proxy / connection_request are shared capability
// definitions (api-client). connection_list_grants stays SDK-only: the MCP
// surface folds connection listing into ziggs_connection_list (
// allowance in the parity table).

export const connectionProxyTool: ToolDefinition = toolFromCapability(connectionProxyCapability);
export const requestConnectionTool: ToolDefinition = toolFromCapability(
  requestConnectionCapability,
);

export const connectionListGrantsTool: ToolDefinition = defineTool(
  'connection_list_grants',
  {
    connectionId: {
      type: 'string',
      required: true,
      description: 'The stored connection to list grants for.',
    },
  },
  async (args, ctx) => {
    if (!args['connectionId']) throw new Error('connectionId is required');
    const operatorKey = (ctx as Ctx)?.['operatorKey'] as string | undefined;
    if (!operatorKey) throw new Error('operatorKey missing from tool context');
    const baseUrl = resolveBackendUrl();
    const client = new ConnectionsClient(
      operatorKey,
      ((ctx as Ctx)?.['agentId'] as string) || undefined,
      baseUrl,
    );
    try {
      const grants = await client.listGrants({ connectionId: args['connectionId'] as string });
      return { grants: grants || [] };
    } catch (e) {
      const err = e as Error & { status?: number; body?: string };
      const wrapped = new Error(`Failed to list connection grants: ${err.message}`) as Error & {
        status?: number;
        body?: string;
      };
      if (err.status !== undefined) wrapped.status = err.status;
      if (err.body !== undefined) wrapped.body = err.body;
      throw wrapped;
    }
  },
  {
    // this shipped with no description at all — the model was handed a
    // name and a parameter and left to guess what the tool was for. Found by the
    // new SDK tool-text guard.
    description:
      "List the grants issued to this agent on one stored connection. Returns the grantId that connection_proxy needs. Use it when you have a connectionId but not the grantId — grant_list (scopeKind [\"connection\"]) is the wider read across every connection.",
  },
);

export const CONNECTION_TOOLS: ToolDefinition[] = [
  connectionProxyTool,
  connectionListGrantsTool,
  requestConnectionTool,
];
