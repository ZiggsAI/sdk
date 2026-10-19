import { workspaceRouter } from './workspaceRouting.js';
import { decodeOperatorKeyClaims } from './operatorKey.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getBackendUrl, type Creds } from '@ziggs-ai/api-client';
const readers = new WeakMap<McpServer, (fresh: boolean) => Promise<string[]>>();
/** A notice changes when the person reconnects or updates; a minute is soon enough. */
const NOTICE_TTL_MS = 60_000;
/** The session-start reads always ask the server, so a reconnect shows on the next one. */
const SESSION_READS = new Set(['ziggs_auth_status', 'ziggs_inbox']);
export function installConnectionNotices(server: McpServer, creds: Creds, version: string) {
  if (!decodeOperatorKeyClaims(creds.operatorKey)?.keyId) return;
  let cached: { readAt: number; notices: string[] } | null = null;
  readers.set(server, async (fresh) => {
    if (!fresh && cached && Date.now() - cached.readAt < NOTICE_TTL_MS) return cached.notices;
    try {
      const response = await fetch(`${getBackendUrl().replace(/\/$/, '')}/oauth/connection-notices`, {
        headers: { Authorization: `Bearer ${creds.operatorKey}`, 'X-Ziggs-Mcp-Version': version },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return cached?.notices ?? [];
      const body = await response.json() as { notices?: unknown; assistantConnection?: boolean };
      if (body.assistantConnection) workspaceRouter(server)?.activate();
      const notices = Array.isArray(body.notices) ? body.notices.filter((n): n is string => typeof n === 'string') : [];
      cached = { readAt: Date.now(), notices };
      return notices;
    } catch { return cached?.notices ?? []; } // A notice lookup must never repeat or suppress a tool's write.
  });
}
export async function readConnectionNotices(server: McpServer, fresh = false) {
  return await readers.get(server)?.(fresh) ?? [];
}
export async function appendConnectionNotices(server: McpServer, name: string, value: unknown, providedNotices?: string[]) {
  const notices = providedNotices ?? await readConnectionNotices(server, SESSION_READS.has(name));
  if (!notices?.length || !value || typeof value !== 'object') return value;
  const result = value as { content?: Array<{ type: string; text?: string }> };
  const content = (result.content ?? []).map(item => ({ ...item }));
  if (name === 'ziggs_auth_status' || name === 'ziggs_inbox') {
    const text = content.find(item => item.type === 'text' && item.text);
    if (text?.text) try {
      const payload = JSON.parse(text.text);
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        // The inbox says them once: its envelope may already carry them at
        // the top, and a sentence after the JSON would be a third copy.
        const same = name === 'ziggs_inbox' && JSON.stringify(payload.connectionNotices) === JSON.stringify(notices);
        if (!same) text.text = JSON.stringify({ ...payload, session: { ...payload.session, connectionNotices: notices } });
        if (name === 'ziggs_inbox') return { ...value, content };
      }
    } catch { /* Non-JSON content still gets the plain sentence below. */ }
  }
  for (const notice of notices) if (!content.some(item => item.text === notice)) content.push({ type: 'text', text: notice });
  return { ...value, content };
}
