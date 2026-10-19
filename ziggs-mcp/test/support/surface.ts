import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

/**
 * ZIG-1390 — drive the surface the way a real caller does.
 *
 * The everyday tools are listed natively and called by name; everything else is
 * named by `ziggs_tools` and called through `ziggs_tool_read` or
 * `ziggs_tool_write`, whichever its annotation selects. Tests go through this
 * helper rather than `client.callTool` directly so they exercise whichever path
 * the tool actually ships on, and so moving a tool between the two tiers does
 * not silently turn a test into a no-op.
 */

let nativeCache: WeakMap<object, Set<string>> = new WeakMap();

async function nativeNames(client: Client): Promise<Set<string>> {
  const cached = nativeCache.get(client as unknown as object);
  if (cached) return cached;
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  nativeCache.set(client as unknown as object, names);
  return names;
}

let readOnlyCache: WeakMap<object, Map<string, boolean>> = new WeakMap();

/** name → read-only, for every catalog row; the listing carries it, read once per client. */
async function catalogReadOnly(client: Client): Promise<Map<string, boolean>> {
  const cached = readOnlyCache.get(client as unknown as object);
  if (cached) return cached;
  const listing = callJson<{ tools: Array<{ name: string; readOnly?: boolean }> }>(
    await client.callTool({ name: 'ziggs_tools', arguments: {} }),
  );
  const lanes = new Map(listing.tools.map((t) => [t.name, t.readOnly === true]));
  readOnlyCache.set(client as unknown as object, lanes);
  return lanes;
}

/** Forget cached listings — for a test that re-lists after changing the surface. */
export function resetSurfaceCache(): void {
  nativeCache = new WeakMap();
  readOnlyCache = new WeakMap();
}

export function callText(result: unknown): string {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content.map((c) => c.text ?? '').join('');
}

export function callJson<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse(callText(result)) as T;
}

/**
 * Call a tool by name: natively when it is listed, otherwise through the
 * dispatcher its annotation selects — ziggs_tool_read for a read-only tool,
 * ziggs_tool_write for the rest.
 */
export async function callZiggsTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if ((await nativeNames(client)).has(name)) {
    return client.callTool({ name, arguments: args });
  }
  const readOnly = (await catalogReadOnly(client)).get(name) === true;
  return client.callTool({
    name: readOnly ? 'ziggs_tool_read' : 'ziggs_tool_write',
    arguments: { tool: name, args },
  });
}

export interface SurfaceTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

/**
 * Whether this server delivers its surface through the catalog. A server
 * without `ziggs_tools` lists everything natively, and "the whole surface" is
 * just `tools/list` — so these helpers describe the surface however it happens
 * to be delivered, rather than assuming one shape.
 */
async function hasCatalog(client: Client): Promise<boolean> {
  return (await nativeNames(client)).has('ziggs_tools');
}

/** Every tool that exists: the natively listed ones plus the whole catalog. */
export async function surfaceToolNames(client: Client): Promise<string[]> {
  const native = [...(await nativeNames(client))];
  if (!(await hasCatalog(client))) return native.sort();
  const listing = callJson<{ tools: Array<{ name: string }> }>(
    await client.callTool({ name: 'ziggs_tools', arguments: {} }),
  );
  return [...new Set([...native, ...listing.tools.map((t) => t.name)])].sort();
}

/**
 * The full definition of every tool on the surface — native entries as
 * `tools/list` returns them, catalog entries as `ziggs_tools describe` does.
 * Both shapes carry name / title / description / inputSchema / annotations.
 */
export async function surfaceTools(client: Client): Promise<SurfaceTool[]> {
  const { tools } = await client.listTools();
  const nativeSet = new Set(tools.map((t) => t.name));
  const catalogNames = !(await hasCatalog(client))
    ? []
    : callJson<{ tools: Array<{ name: string }> }>(
        await client.callTool({ name: 'ziggs_tools', arguments: {} }),
      ).tools
        .map((t) => t.name)
        .filter((n) => !nativeSet.has(n));

  const described = catalogNames.length
    ? callJson<{ tools: SurfaceTool[] }>(
        await client.callTool({
          name: 'ziggs_tools',
          arguments: { describe: catalogNames },
        }),
      ).tools
    : [];

  return [
    ...tools.map((t) => ({
      name: t.name,
      title: t.title ?? '',
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      annotations: (t.annotations ?? {}) as Record<string, unknown>,
    })),
    ...described,
  ];
}
