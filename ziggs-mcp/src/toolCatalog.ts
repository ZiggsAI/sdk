import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape, ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { TitledAnnotations } from './toolAnnotations.js';

/**
 * The tool catalog.
 *
 * Measured on the wire, this surface was 63 tools and 79,932 characters, about
 * 20k tokens a caller carries before doing anything. Names and titles were
 * 2,744 of those characters — 3.4%. The other 96.6% is parameter schemas (47%)
 * and descriptions (35%), and a session typically reaches for a handful of
 * tools, so nearly all of it is paid for and never used.
 *
 * Caching does not fix this. Tool definitions sit in the cacheable prefix, so
 * after the first turn the token *price* is mostly cache reads — but the
 * *context window space* is gone either way. 20k tokens of window is the cost
 * this removes; anyone measuring price alone will find it cheap and conclude
 * wrongly.
 *
 * MCP has no name-only tool: every entry in `tools/list` carries a schema. So
 * the catalog is a dispatcher — the shape `ziggs_mcp_tools_list` /
 * `ziggs_mcp_tool_call` already use for proxied external MCP, and the one that
 * needs no cooperation from any client. Two of them, one per annotation lane
 * (`ziggs_tool_read`, `ziggs_tool_write`): a host and a store reviewer read
 * what a tool is from its annotation, and one dispatcher cannot be read-only
 * and writing at once. Nothing is hidden: `ziggs_tools` names
 * every tool that exists, and `ziggs_tools` with `describe` hands back full
 * schemas on demand. An agent can always find what exists and ask for it,
 * which is what made per-caller filtering the wrong trade.
 *
 * The cost this shape does carry: catalog tools are not first-class in the
 * client's tool UI, and the model loses the native tool-call affordance for
 * them. That is why the everyday set stays natively listed.
 */

export interface CatalogEntry {
  name: string;
  /** The short human phrase — this is the "one line" in the catalog. */
  title: string;
  description: string;
  annotations: TitledAnnotations;
  /** Raw zod shape, lowered to JSON Schema only when a caller asks for it. */
  shape: ZodRawShape;
  /**
   * The strict object `registerStrictTool` built at registration, kept rather
   * than rebuilt. Every dispatch validates against this, and rebuilding it from
   * the shape on each call re-created an object (and its error map) that had
   * not changed since startup — on what is now the surface's main path.
   */
  params: ZodTypeAny;
  /**
   * The registered handler. The dispatchers call through this rather than
   * re-entering the server: one call, one validation, no nested request.
   */
  call: (args: Record<string, unknown>) => Promise<unknown>;
  handle: RegisteredTool;
}

/**
 * Per-server, because one process serves many connections: the remote HTTP
 * transport builds a fresh server per session, and a module-level array would
 * accumulate every tool every connection ever registered.
 */
const catalogs = new WeakMap<McpServer, Map<string, CatalogEntry>>();

export function recordCatalogEntry(
  server: McpServer,
  entry: CatalogEntry,
): void {
  let byName = catalogs.get(server);
  if (!byName) {
    byName = new Map();
    catalogs.set(server, byName);
  }
  byName.set(entry.name, entry);
}

export function catalogFor(server: McpServer): CatalogEntry[] {
  return [...(catalogs.get(server)?.values() ?? [])];
}

export function catalogEntry(
  server: McpServer,
  name: string,
): CatalogEntry | undefined {
  return catalogs.get(server)?.get(name);
}

export function removeCatalogEntry(server: McpServer, name: string): void {
  catalogs.get(server)?.delete(name);
}

/**
 * Lowered JSON Schema per entry, computed once.
 *
 * A tool's schema is frozen for the server's lifetime, and describing is the
 * step the surface asks a caller to take before every unfamiliar dispatch — so
 * lowering the same static zod object on every describe was work with no input
 * that could change. Keyed by entry, so it is collected with the server the
 * entry belongs to.
 */
const loweredSchemas = new WeakMap<CatalogEntry, Record<string, unknown>>();

function inputSchemaOf(entry: CatalogEntry): Record<string, unknown> {
  const cached = loweredSchemas.get(entry);
  if (cached) return cached;
  const lowered = zodToJsonSchema(entry.params, {
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  loweredSchemas.set(entry, lowered);
  return lowered;
}

/** The JSON Schema a caller gets when it asks to describe a tool. */
export function describeEntry(entry: CatalogEntry): Record<string, unknown> {
  return {
    name: entry.name,
    title: entry.title,
    description: entry.description,
    annotations: entry.annotations,
    inputSchema: inputSchemaOf(entry),
  };
}

/** Name + one line, for every tool that exists. This is the cheap 3.4%. */
export function catalogRow(entry: CatalogEntry): Record<string, unknown> {
  return {
    name: entry.name,
    title: entry.title,
    ...(entry.annotations.readOnlyHint ? { readOnly: true } : {}),
    ...(entry.annotations.destructiveHint ? { destructive: true } : {}),
  };
}
