import type { Creds } from '@ziggs-ai/api-client';
import type { ZiggsMcpConfig } from './config.js';

export function credsFromConfig(cfg: ZiggsMcpConfig): Creds {
  return {
    operatorKey: cfg.ZIGGS_OPERATOR_KEY,
    agentId: cfg.resolvedAgentId,
    // The lane, so a hired delegate can spend the grants its customer gave it.
    // Every client in this package reads it off `Creds`, so leaving it unset
    // here silently fences all of them to the agent's own estate.
    ...(cfg.ZIGGS_LANE_ID ? { laneId: cfg.ZIGGS_LANE_ID } : {}),
    // Unset means this process is the host, which is right for a server that
    // stays up and wrong for one a scheduler respawns per run — that one pins
    // ZIGGS_INSTANCE_ID so every run is the same host.
    ...(cfg.ZIGGS_INSTANCE_ID ? { instanceId: cfg.ZIGGS_INSTANCE_ID } : {}),
    ...(cfg.ZIGGS_WORKSPACES ? { workspaceIds: cfg.ZIGGS_WORKSPACES } : {}),
    ...(cfg.ZIGGS_APP ? { app: cfg.ZIGGS_APP } : {}),
    ...(cfg.ZIGGS_SESSION_NAME ? { sessionName: cfg.ZIGGS_SESSION_NAME } : {}),
  };
}
