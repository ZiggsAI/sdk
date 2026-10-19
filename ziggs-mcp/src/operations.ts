import { withAssistantRequest, type Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from './server.js';
import type { ZiggsMcpConfig } from './config.js';
import { catalogFor, catalogEntry, catalogRow, describeEntry } from './toolCatalog.js';
import { aliasMatches } from './toolAliases.js';

/**
 * The same validated, credential-filtered operations without an MCP transport.
 * Shell clients need no host MCP configuration, listener, or background process.
 * Registration retains workspace routing, notices and the credential's surface.
 */
export function createZiggsOperations(creds: Creds, cfg: ZiggsMcpConfig) {
  const server = createZiggsMcpServer(creds, cfg);
  function entryFor(name: string) {
    const entry = catalogEntry(server, name);
    if (!entry) throw new Error(`Unknown or unavailable Ziggs operation: ${name}. Run ziggs tools.`);
    return entry;
  }
  return {
    list(search?: string) {
      const needle = search?.trim().toLowerCase();
      return catalogFor(server)
        .filter(e => !needle || e.name.toLowerCase().includes(needle) || e.title.toLowerCase().includes(needle) || aliasMatches(e.name, needle))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(catalogRow);
    },
    describe(name: string) { return describeEntry(entryFor(name)); },
    async call(name: string, args: Record<string, unknown>, readOnly = false): Promise<unknown> {
      const entry = entryFor(name);
      if (readOnly && entry.annotations.readOnlyHint !== true) {
        throw new Error(`${name} changes state and cannot run with --read-only.`);
      }
      const parsed = entry.params.safeParse(args);
      if (!parsed.success) {
        throw new Error(`${name} did not run: ${parsed.error.issues.map(i => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`);
      }
      return withAssistantRequest({
        clientSessionId: creds.clientSessionId,
        instanceId: creds.instanceId,
        app: creds.app,
        sessionName: creds.sessionName,
        workspaceIds: creds.workspaceIds,
      }, () => entry.call(parsed.data as Record<string, unknown>));
    },
    // Closing this short-lived adapter must not release the logical session's
    // inbox lease: its next CLI process will acknowledge the same envelope.
    close() { return server.close(); },
  };
}
