import { resolveDelegateCreds } from '@ziggs-ai/api-client';
export { decodeOperatorKeyClaims, isOperatorKeyExpired, isDirectoryBoarded, ISSUED_VIA_MCP_OAUTH, ISSUED_VIA_DEVICE_CODE } from '@ziggs-ai/api-client';
export type { OperatorKeyClaims } from '@ziggs-ai/api-client';

const MINT_KEY_HELP =
  'An MCP client that supports OAuth signs in for you when it connects to https://mcp.ziggsai.com/mcp; ' +
  'there is no key to paste (https://ziggsai.com/docs#connect-assistant). ' +
  'To run with a key instead, issue one in the Ziggs app: open your agent, then Agent-only access > Issue key ' +
  '(no ZIGGS_AGENT_ID needed), or Agents > Access keys (/app/agents/access-keys) for a fleet key plus ZIGGS_AGENT_ID. ' +
  'Docs: https://ziggsai.com/docs#claude-code-mcp';

/**
 * Resolve delegate agent id: agent-scoped key (boundAgentId) wins; else ZIGGS_AGENT_ID.
 */
export function resolveDelegateAgentId(
  operatorKey: string,
  envAgentId: string | undefined,
): string {
  return resolveDelegateCreds({
    ZIGGS_OPERATOR_KEY: operatorKey,
    ZIGGS_AGENT_ID: envAgentId,
  }).agentId;
}

export { MINT_KEY_HELP };
