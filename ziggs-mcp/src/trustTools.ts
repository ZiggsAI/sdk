import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ContextGrantsClient,
  LINK_CAPABILITIES,
  INTRODUCTION_CAPABILITIES,
  PARTY_CAPABILITIES,
  DISCOVERY_CAPABILITIES,
  contextDelegateCapability,
  accessRequestCapability,
  type Creds,
} from '@ziggs-ai/api-client';
import type { ZiggsMcpConfig } from './config.js';
import { destructive } from './toolAnnotations.js';
import { registerStrictTool } from './strictParams.js';
import { toolError } from './toolError.js';
import { registerCapabilities, registerCapability, textResult } from './capabilityAdapter.js';

const DEFAULT_WEB_URL = 'https://ziggsai.com';

/** agent search + context grant management through MCP.
 * The SDK-twin tools (search/get, links, delegate) come from the shared
 * capability layer; only revoking a grant stays MCP-local. Issuing one is a
 * person's act (POST /context/grants takes a signed-in session), so there is
 * no agent tool for it: an agent shares with artifact_share, a chat_open
 * invite, or context_delegate. */
export function registerTrustTools(server: McpServer, creds: Creds, cfg?: ZiggsMcpConfig): void {
  const webUrl = cfg?.ZIGGS_WEB_URL?.replace(/\/$/, '') ?? DEFAULT_WEB_URL;

  registerCapabilities(server, DISCOVERY_CAPABILITIES, creds);

  registerCapability(server, contextDelegateCapability, creds);
  registerCapability(server, accessRequestCapability, creds, { webUrl });

  if (!cfg?.coreOnly) {
    // #7 — the link tool group is skipped by the lean session-start
    // tier (ZIGGS_MCP_CORE_ONLY). Definitions live in the shared capability
    // layer, including the linkSummary shaping the mutations now share.
    registerCapabilities(server, LINK_CAPABILITIES, creds, { webUrl });
    // The introduction rail rides with links: redeeming one is how a
    // meeting somewhere Ziggs does not own becomes a link proposal here.
    registerCapabilities(server, INTRODUCTION_CAPABILITIES, creds, { webUrl });
    // A person not on Ziggs yet arrives by mail or Slack; what the workspace
    // knows about them rides in every room snapshot they are in.
    registerCapabilities(server, PARTY_CAPABILITIES, creds);
  }

  registerStrictTool(
    server,
    'ziggs_context_revoke_grant',
    {
      grantId: z.string(),
    },
    destructive('Revoke a context grant'),
    async ({ grantId }) => {
      try {
        const client = new ContextGrantsClient(creds.operatorKey, creds.agentId);
        const result = await client.revokeGrant(grantId);
        return textResult({ grantId, ...result });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
