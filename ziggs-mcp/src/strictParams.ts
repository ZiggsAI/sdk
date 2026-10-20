import { DIRECTORY_TOOLS, directoryAnnotations, isDirectorySurface } from './directorySurface.js';
import { appendConnectionNotices, readConnectionNotices } from './connectionNotices.js';
import { workspaceRouter } from './workspaceRouting.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpDescription } from '@ziggs-ai/api-client';
import { z, type ZodRawShape, type ZodObject } from 'zod';
import type { TitledAnnotations } from './toolAnnotations.js';
import { recordCatalogEntry } from './toolCatalog.js';

/**
 * registering a tool with a plain `ZodRawShape` lets the MCP SDK
 * wrap it in a default `z.object()`, which *strips* unknown keys instead of
 * rejecting them. A misspelled param (`nweChat` for `newChat`) was therefore
 * dropped and the call ran anyway, reporting success for the opposite of what
 * the caller asked for.
 *
 * A human typing that into a form gets a red field; an agent got silence, and
 * silence reads as confirmation — there was no feedback loop to self-correct
 * against. So every tool schema is built strict, and the rejection names both
 * the offending key and the params the tool actually accepts.
 */
/** The workspace parameter the router adds to a tool that acts in one. */
export const WORKSPACE_PARAM = 'Workspace orgId, when more than one fits.';

export type StrictShape<S extends ZodRawShape> = ZodObject<
  S,
  'strict',
  z.ZodTypeAny
>;

export function strictParams<S extends ZodRawShape>(
  toolName: string,
  shape: S,
): StrictShape<S> {
  const accepted = Object.keys(shape);
  return z
    .object(shape, {
      // zod's default is "Unrecognized key(s) in object: 'nweChat'" — true but
      // it leaves the caller to guess what the right key was. The issue carries
      // `keys`, so the message can name the typo and the menu next to it.
      errorMap: (issue, ctx) => {
        if (issue.code === z.ZodIssueCode.unrecognized_keys) {
          const offenders = issue.keys.map((k) => `"${k}"`).join(', ');
          const menu = accepted.length ? accepted.join(', ') : '(none)';
          return {
            message:
              `Unknown parameter(s) ${offenders} — ${toolName} did not run. ` +
              `Accepted params: ${menu}. Check for a typo and call again; ` +
              `nothing was changed.`,
          };
        }
        return { message: ctx.defaultError };
      },
    })
    .strict();
}

/**
 * `server.tool(name, description, shape, annotations, cb)` with the shape made
 * strict. The positional `tool()` overloads only accept a raw shape (a built
 * ZodObject is parsed as annotations there), so the strict schema has to go
 * through `registerTool`'s config object.
 *
 * Annotations must carry a title: a titleless tool displays as its wire name
 * (`ziggs_agreement_fulfill`), and the connector directory flags the surface
 * for it. Taking `TitledAnnotations` rather than `ToolAnnotations` is what
 * makes that a compile error instead of a review catch.
 *
 * The title goes out twice from the one source. `title` is where the current
 * spec puts it; `annotations.title` is where clients written against the
 * 2024-11-05 spec still look, and display precedence is title →
 * annotations.title → name, so a client reading either lands on the same copy.
 */
export function registerStrictTool<S extends ZodRawShape>(
  server: McpServer,
  name: string,
  shape: S,
  annotations: TitledAnnotations,
  cb: Parameters<typeof server.registerTool<never, StrictShape<S>>>[2],
  /**
   * Tool `_meta`, for the one thing that needs it today: an MCP Apps view
   * (`{ ui: { resourceUri } }`) that a host renders beside the result.
   */
  meta?: Record<string, unknown>,
): void {
  const directory = isDirectorySurface(server);
  if (directory) {
    // Excluded operations are never registered, so direct calls cannot bypass
    // tools/list. New capabilities require a deliberate allow-list change.
    if (!DIRECTORY_TOOLS.has(name)) return;
    annotations = directoryAnnotations(name, annotations);
  }
  // Built once and kept: the catalog validates every dispatch against this same
  // object, and the describe path lowers it to JSON Schema. Rebuilding it from
  // the shape at each of those calls produced an object that had not changed
  // since registration.
  const router = workspaceRouter(server);
  const nativeOrgId = !!shape.orgId;
  if (router) {
    // Said once per tool and kept short: it rides on most of the surface. Which
    // workspace to use is taught where it matters — the refusal for a call that
    // needs one lists the choices and says to ask the person.
    if (router.acceptsWorkspace(name)) shape = { ...shape, orgId: shape.orgId?.optional() ?? z.string().optional().describe(WORKSPACE_PARAM) };
    cb = router.wrap(name, annotations.readOnlyHint === true, cb as never, nativeOrgId) as typeof cb;
  }
  const routed = cb;
  cb = (async (...args: Parameters<typeof routed>) => {
    const notices = await readConnectionNotices(server, name === 'ziggs_auth_status' || name === 'ziggs_inbox');
    return appendConnectionNotices(server, name, await routed(...args), notices);
  }) as typeof cb;
  const params = strictParams(name, shape);
  // One shape for every description, rendered from the tool's
  // brief (api-client `mcpBriefs.ts`) and its annotation, for the door it is on.
  const description = mcpDescription(
    name,
    annotations.readOnlyHint === true
      ? 'read-only'
      : annotations.destructiveHint === true
        ? 'destructive'
        : 'write',
    directory ? 'directory' : 'compact',
  );
  const handle = server.registerTool(
    name,
    {
      title: annotations.title,
      description,
      inputSchema: params,
      annotations,
      ...(meta ? { _meta: meta } : {}),
    },
    cb,
  );
  // Every tool goes into the catalog as it registers, whether or not
  // it stays natively listed. `applySurfacePolicy` decides that afterwards, and
  // the catalog is what keeps a de-listed tool both findable and callable.
  recordCatalogEntry(server, {
    name,
    title: annotations.title,
    description,
    annotations,
    shape,
    params,
    handle,
    call: (args) =>
      Promise.resolve(
        (cb as (a: Record<string, unknown>) => unknown)(args),
      ),
  });
}
