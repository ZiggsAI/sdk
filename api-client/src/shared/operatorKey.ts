import {
  OPERATOR_KEY_ISSUED_VIA,
  isDirectoryBoardedIssuedVia,
} from '@ziggs-ai/contracts';

/** JWT payload fields we read client-side (signature not verified — identity hint only). */
export interface OperatorKeyClaims {
  type?: string;
  keyId?: string;
  ownerId?: string;
  boundAgentId?: string | null;
  connectionClientId?: string | null;
  /**
   * How the key was authorized. MCP consent uses `mcp_oauth` or `device_code`;
   * provisioning and other mint paths carry their own provenance.
   */
  issuedVia?: string;
  exp?: number;
}

/** Decode operator JWT payload without verifying signature (boundAgentId). */
export function decodeOperatorKeyClaims(
  token: string,
): OperatorKeyClaims | null {
  const trimmed = token.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 3) return null;
  try {
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
    );
    const payload = JSON.parse(json) as Record<string, unknown>;
    return {
      type: payload.type as string | undefined,
      keyId: payload.keyId as string | undefined,
      ownerId: payload.ownerId as string | undefined,
      boundAgentId:
        typeof payload.boundAgentId === 'string' ? payload.boundAgentId : null,
      connectionClientId: typeof payload.connectionClientId === 'string' ? payload.connectionClientId : null,
      issuedVia:
        typeof payload.issuedVia === 'string' ? payload.issuedVia : undefined,
      exp: payload.exp as number | undefined,
    };
  } catch {
    return null;
  }
}

export function isOperatorKeyExpired(
  claims: OperatorKeyClaims | null,
): boolean {
  if (!claims?.exp) return false;
  return claims.exp * 1000 <= Date.now();
}

/**
 * The stamps the two consent rails put on the tokens they mint.
 *
 * Re-exported from the contract rather than restated here. This file used to
 * declare the two strings it cared about while the server's list had six, so
 * a rail added there was invisible here until somebody remembered — and the
 * predicate below decides which tool surface a connected assistant gets, so
 * forgetting would have served the whole catalogue to the new rail's
 * credentials.
 */
export const ISSUED_VIA_MCP_OAUTH = OPERATOR_KEY_ISSUED_VIA.MCP_OAUTH;
export const ISSUED_VIA_DEVICE_CODE = OPERATOR_KEY_ISSUED_VIA.DEVICE_CODE;
export { OPERATOR_KEY_ISSUED_VIA };
export type { OperatorKeyIssuedVia } from '@ziggs-ai/contracts';

/**
 * Did a person board this credential through the connector directory?
 *
 * That is the question the tool surface turns on: a connected assistant
 * (Claude, ChatGPT, Cursor) gets the listed, directory-reviewed surface, and
 * anyone who configured this server themselves with an operator key gets the
 * whole thing.
 *
 * Ask it as a predicate, never as `issuedVia === 'mcp_oauth'`. Two consent rails
 * board an assistant through that door — the authorization-code flow and the
 * device-code flow — and both want the same narrowed surface, but the server
 * records them as the different acts they are. An equality test against one
 * value serves the whole catalogue to every credential from the other one.
 *
 * Read off the unverified payload. On the remote endpoint the backend verified
 * the signature before this ran; on stdio the key is the caller's own. Either
 * way the payload is the one the backend signed. And what hangs on the answer
 * is which tools are registered, not what a call may do: every call is still
 * authorized by the backend. Provenance may decide what is OFFERED, never what
 * is PERMITTED.
 */
export function isDirectoryBoarded(claims: OperatorKeyClaims | null): boolean {
  // The set of boarding rails is the contract's, for the reason above: two
  // copies of "which rails board an assistant" is how one of them goes stale.
  return isDirectoryBoardedIssuedVia(claims?.issuedVia);
}

/** Routing hint only. Every request is still authenticated by the backend. */
export function isMcpOAuthDelegateSession(creds: {
  operatorKey: string;
  agentId: string;
}): boolean {
  const claims = decodeOperatorKeyClaims(creds.operatorKey);
  return (
    !!creds.agentId &&
    claims?.boundAgentId === creds.agentId &&
    isDirectoryBoarded(claims)
  );
}
