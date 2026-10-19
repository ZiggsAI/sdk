import { decodeOperatorKeyClaims, isOperatorKeyExpired } from './operatorKey.js';

/**
 * The environment a delegate process was handed. Callers read the process;
 * this module does not.
 */
export interface DelegateEnv {
  ZIGGS_API_URL?: string;
  HTTP_URL?: string;
  ZIGGS_OPERATOR_KEY?: string;
  ZIGGS_AGENT_ID?: string;
}

export interface ResolvedDelegateCreds {
  /** `ZIGGS_API_URL` wins over `HTTP_URL`. Absent when neither is set. */
  httpUrl?: string;
  operatorKey: string;
  /** Empty when the key is a directory connection (`connectionClientId`). */
  agentId: string;
}

const MINT =
  'An MCP client that supports OAuth signs in at https://mcp.ziggsai.com/mcp. ' +
  'To run with a key, issue one in the Ziggs app (Agent-only access, or Agents > Access keys). ' +
  'Docs: https://ziggsai.com/docs#connect-assistant';

/** Which base URL this process was told to use. The specific name wins. */
export function resolveDelegateHttpUrl(env: DelegateEnv): string | undefined {
  const specific = env.ZIGGS_API_URL?.trim();
  if (specific) return specific;
  const generic = env.HTTP_URL?.trim();
  return generic || undefined;
}

/**
 * One reading of a delegate's key, agent, and base URL.
 * An agent-scoped key supplies the agent id. A session JWT is refused.
 */
export function resolveDelegateCreds(env: DelegateEnv): ResolvedDelegateCreds {
  const operatorKey = env.ZIGGS_OPERATOR_KEY?.trim() ?? '';
  if (!operatorKey) {
    throw new Error(`ZIGGS_OPERATOR_KEY is required. ${MINT}`);
  }
  const claims = decodeOperatorKeyClaims(operatorKey);
  if (claims?.type && claims.type !== 'operator') {
    throw new Error(
      `ZIGGS_OPERATOR_KEY must be an operator token (not a session JWT). ${MINT}`,
    );
  }
  if (isOperatorKeyExpired(claims)) {
    throw new Error(
      `operator key expired (keyId=${claims?.keyId ?? 'unknown'}). ${MINT}`,
    );
  }
  const httpUrl = resolveDelegateHttpUrl(env);
  if (claims?.connectionClientId) {
    return { httpUrl, operatorKey, agentId: '' };
  }
  const bound = claims?.boundAgentId?.trim() || '';
  const fromEnv = env.ZIGGS_AGENT_ID?.trim() || '';
  if (bound && fromEnv && bound !== fromEnv) {
    throw new Error(
      `ZIGGS_AGENT_ID (${fromEnv}) conflicts with agent-scoped key bound to "${bound}". ` +
        'Remove ZIGGS_AGENT_ID or use a fleet impersonation key instead.',
    );
  }
  const agentId = bound || fromEnv;
  if (!agentId) {
    throw new Error(
      `set ZIGGS_AGENT_ID, or mint an agent-scoped operator key (boundAgentId in token). ${MINT}`,
    );
  }
  return { httpUrl, operatorKey, agentId };
}
