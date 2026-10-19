import {
  configureApiClient,
  mcpConnectionIdentity,
  type Creds,
} from '@ziggs-ai/api-client';
import type { ZiggsMcpConfig } from './config.js';
import {
  MINT_KEY_HELP,
  decodeOperatorKeyClaims,
  isDirectoryBoarded,
  resolveDelegateAgentId,
} from './operatorKey.js';

export function parseBearerAuthorization(
  header: string | string[] | undefined,
): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw?.startsWith('Bearer ')) {
    throw new Error(
      `Authorization: Bearer <operator-key> required. ${MINT_KEY_HELP}`,
    );
  }
  const token = raw.slice('Bearer '.length).trim();
  if (!token) {
    throw new Error(`empty bearer token. ${MINT_KEY_HELP}`);
  }
  return token;
}

/**
 * Per-connection credentials from HTTP Authorization.
 *
 * `laneId` is the wake's lane, read off `X-Ziggs-Lane` by the caller that
 * mounts this server, exactly as `ownerUserId` is read off its own header. A
 * connection that states none is fenced to the agent's own estate — right for
 * a person who pasted their key, wrong for a delegate holding grants its
 * customer gave.
 */
export function connectionFromBearer(
  bearer: string,
  httpBaseUrl: string,
  ownerUserId?: string,
  laneId?: string,
  session?: {
    clientSessionId?: string;
    workspaceIds?: string;
    app?: string;
    sessionName?: string;
  },
): { creds: Creds; cfg: ZiggsMcpConfig } {
  const resolvedAgentId = resolveDelegateAgentId(bearer, undefined);
  if (httpBaseUrl) {
    process.env.HTTP_URL = httpBaseUrl;
    // Same global reach as the env write it replaces: api-client
    // holds one base URL per process, so the last connection wins here too.
    configureApiClient({ httpUrl: httpBaseUrl });
  }
  const cfg: ZiggsMcpConfig = {
    ZIGGS_OPERATOR_KEY: bearer,
    ZIGGS_API_URL: httpBaseUrl,
    HTTP_URL: httpBaseUrl,
    ZIGGS_AGENT_ID: undefined,
    ZIGGS_OWNER_USER_ID: ownerUserId,
    ZIGGS_LANE_ID: laneId,
    resolvedAgentId,
    debugTools: false,
    coreOnly: false,
    // The listed surface for a token the OAuth consent flow minted (a connected
    // assistant), the whole surface for an operator key someone pasted here
    // themselves. The line is the credential, not this endpoint; see
    // ZiggsMcpConfig.directConnection.
    directConnection: !isDirectoryBoarded(decodeOperatorKeyClaims(bearer)),
  };
  /**
   * The inbox host is this CONNECTION, not the process serving it.
   *
   * This server also runs inside the API process, which serves every connected
   * assistant and gets a new identity on every deploy. Stamping that made all
   * of them one host and moved it under all of them at once, so a hosted
   * `ziggs_inbox` read answered 409 for up to 220 seconds after each restart.
   * The key is what stays put across both. Undefined only for a credential
   * carrying no `keyId`, which then falls back to the process default.
   */
  const instanceId = mcpConnectionIdentity(bearer);
  return {
    creds: {
      operatorKey: bearer,
      agentId: resolvedAgentId,
      ...(laneId ? { laneId } : {}),
      ...(instanceId ? { instanceId } : {}),
      ...(session?.clientSessionId ? { clientSessionId: session.clientSessionId } : {}),
      ...(session?.workspaceIds ? { workspaceIds: session.workspaceIds } : {}),
      ...(session?.app ? { app: session.app } : {}),
      ...(session?.sessionName ? { sessionName: session.sessionName } : {}),
    },
    cfg,
  };
}
