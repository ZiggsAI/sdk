import { installDirectorySurface } from './directorySurface.js';
import { installConnectionNotices } from './connectionNotices.js';
import { installWorkspaceRouting } from './workspaceRouting.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { AssistantConnectionClient, decodeOperatorKeyClaims, InboxClient, type Creds } from '@ziggs-ai/api-client';
import { loadConfig } from './config.js';
import type { ZiggsMcpConfig } from './config.js';
export type { ZiggsMcpConfig };
import { credsFromConfig } from './creds.js';
import { registerZiggsTools } from './tools.js';
import { applySurfacePolicy } from './surface.js';
import { backendToolPick } from './toolPick.js';
import { renderConnectText } from './protocol/connectText.js';
import { CHANNEL_CAPABILITY, observeFor, startInboxChannel } from './inboxChannel.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

/** Shared MCP server factory — stdio (local) and remote HTTP (backend) reuse this. */
export function createZiggsMcpServer(
  creds: Creds,
  cfg: ZiggsMcpConfig,
): McpServer {
  const server = new McpServer(
    {
      name: 'ziggs-mcp',
      version,
    },
    {
      // Cold-connected clients (Claude Code, Cursor, ChatGPT, Codex) inject
      // this into model context on `initialize`: the short connect text, the
      // same for every client — clients truncate a long one. Covers
      // stdio and remote HTTP alike, since both build the server here.
      instructions: renderConnectText(cfg.directConnection === false ? 'directory' : 'compact', {
        events: cfg.eventsEnabled === true,
        channel: cfg.channel === true && cfg.directConnection !== false,
      }),
    },
  );
  if (cfg.channel === true && cfg.directConnection !== false)
    server.server.registerCapabilities({ experimental: CHANNEL_CAPABILITY });
  if (cfg.directConnection === false) installDirectorySurface(server);
  installConnectionNotices(server, creds, version);
  const routedCreds = installWorkspaceRouting(server, creds);
  registerZiggsTools(server, routedCreds, cfg.directConnection === false
    ? { ...cfg, coreOnly: false, debugTools: false } : cfg);
  // Directory clients get every registered operation directly. The compact
  // catalog remains only for self-configured operator-key clients.
  if (cfg.directConnection !== false)
    applySurfacePolicy(server, { pickTool: backendToolPick(creds) });
  return server;
}

/** Drop this process's inbox host. Best-effort — shutdown must not fail on it. */
export async function releaseStdioInboxHost(creds: Creds): Promise<void> {
  try {
    if (decodeOperatorKeyClaims(creds.operatorKey)?.connectionClientId) {
      await new AssistantConnectionClient(creds).request('inbox/release', {});
      return;
    }
    await new InboxClient(
      creds.operatorKey,
      creds.agentId,
      undefined,
      creds.instanceId,
    ).releaseHost();
  } catch {
    // The next host either takes an already-free inbox or waits out the lease.
  }
}

export function installStdioInboxHostRelease(
  creds: Creds,
  onStop: () => void = () => process.exit(0),
): () => void {
  let stopping = false;
  const signal = () => {
    if (stopping) return;
    stopping = true;
    void releaseStdioInboxHost(creds).finally(onStop);
  };
  process.on('SIGTERM', signal);
  process.on('SIGINT', signal);
  return () => {
    process.off('SIGTERM', signal);
    process.off('SIGINT', signal);
  };
}

export async function startStdioServer(): Promise<void> {
  const cfg = loadConfig();
  const creds = credsFromConfig(cfg);
  const server = createZiggsMcpServer(creds, cfg);
  installStdioInboxHostRelease(creds);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (cfg.channel) startInboxChannel(server, observeFor(creds), { agentId: creds.agentId });
}
