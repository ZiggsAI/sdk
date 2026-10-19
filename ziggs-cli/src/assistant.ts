import { createHash } from 'node:crypto';
import { configureApiClient, decodeOperatorKeyClaims, isDirectoryBoarded, resolveDelegateCreds, type Creds } from '@ziggs-ai/api-client';
import { createZiggsOperations } from '@ziggs-ai/ziggs-mcp/operations';

export interface AssistantOptions {
  session?: string;
  app?: string;
  sessionName?: string;
  workspaces?: string;
}

function header(name: string, value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text || text.length > max || /[^\x20-\x7e]/.test(text)) {
    throw new Error(`${name} must contain 1–${max} printable ASCII characters.`);
  }
  return text;
}

/** Explicit per-chat identity; never derive it from a shared user or cwd. */
export function assistantSession(options: AssistantOptions, env: NodeJS.ProcessEnv = process.env) {
  const clientSessionId = header('session', options.session ?? env.ZIGGS_SESSION_ID, 128);
  if (!clientSessionId) throw new Error('Pass --session <id> or ZIGGS_SESSION_ID. Run ziggs session new once per assistant chat and reuse its ID.');
  const workspaceIds = header('workspaces', options.workspaces ?? env.ZIGGS_WORKSPACES, 4096);
  if (workspaceIds && (workspaceIds.split(',').some(s => !s.trim()) || workspaceIds.split(',').length > 20)) {
    throw new Error('workspaces must be a comma-separated list of 1–20 nonempty workspace IDs.');
  }
  return {
    clientSessionId,
    // Full SHA-256 fits the server's 64-character host limit and avoids
    // collisions from truncating long, similarly-prefixed session IDs.
    instanceId: createHash('sha256').update(`ziggs-cli:${clientSessionId}`).digest('hex'),
    app: header('app', options.app ?? env.ZIGGS_APP ?? 'Ziggs CLI', 80),
    sessionName: header('session-name', options.sessionName ?? env.ZIGGS_SESSION_NAME, 160),
    workspaceIds,
  };
}

export function assistantCredentials(options: AssistantOptions, env: NodeJS.ProcessEnv = process.env): Creds {
  const session = assistantSession(options, env);
  const resolved = resolveDelegateCreds(env);
  if (resolved.httpUrl) configureApiClient({ httpUrl: resolved.httpUrl });
  return {
    operatorKey: resolved.operatorKey,
    agentId: resolved.agentId,
    ...session,
    ...(env.ZIGGS_LANE_ID ? { laneId: env.ZIGGS_LANE_ID } : {}),
  };
}

export function assistantOperations(options: AssistantOptions) {
  const creds = assistantCredentials(options);
  const claims = decodeOperatorKeyClaims(creds.operatorKey);
  return createZiggsOperations(creds, {
    ZIGGS_OPERATOR_KEY: creds.operatorKey,
    ZIGGS_WEB_URL: process.env.ZIGGS_WEB_URL,
    ZIGGS_OWNER_USER_ID: process.env.ZIGGS_OWNER_USER_ID,
    resolvedAgentId: creds.agentId,
    // Preserve the credential's restrictions. A CLI is not a way to widen
    // an OAuth-connected assistant's allowed operation surface.
    directConnection: !isDirectoryBoarded(claims),
    coreOnly: false,
    debugTools: false,
  });
}
