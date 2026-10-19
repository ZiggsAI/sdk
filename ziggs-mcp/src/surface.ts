import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { EVERYDAY_MCP_TOOLS } from '@ziggs-ai/api-client';
import { readOnly, type TitledAnnotations, destructive } from './toolAnnotations.js';
import { registerStrictTool } from './strictParams.js';
import { toolError } from './toolError.js';
import { textResult } from './capabilityAdapter.js';
import { aliasMatches } from './toolAliases.js';
import { pickLine, type PickTool } from './toolPick.js';
import {
  catalogEntry,
  catalogFor,
  catalogRow,
  describeEntry,
  removeCatalogEntry,
  type CatalogEntry,
} from './toolCatalog.js';

/**
 * The tools a cold session gets natively, with their full schemas.
 *
 * Everything else is in the catalog: named by `ziggs_tools`, described on
 * demand, called through `ziggs_tool_read` or `ziggs_tool_write` — or by its
 * own name, which stays callable. The line is drawn at what a session cannot
 * start without:
 *
 * - `ziggs_inbox` is the session-start read — the other two orientation tools
 *   folded into it — so it is where a caller finds out where it stands and
 *   what it has been asked to do.
 * - `ziggs_open` is how it opens a returned artifact/chat/task/agreement id.
 *   The inbox returns references, never content; `readPlan` names this tool
 *   with the ordinary id. `ziggs_context_read` remains the paged/via listing.
 * - `ziggs_chat_open` starts or reuses contact; an absent room is not a refusal.
 * - `ziggs_chat_send` and `ziggs_task_set_result` are the two ways to answer:
 *   conversation, and finished work. An agent that can read its mail and
 *   cannot reply is worse off than one that pays for a schema it never used.
 * - the catalog tools themselves, or none of the above matters.
 *
 * Deliberately NOT native: the agreement verbs, payments, artifacts, grants,
 * links, connections, tasks beyond the result. Every one of them is a real
 * capability an agent reaches for occasionally and pays for constantly.
 *
 * The names live in api-client (`EVERYDAY_MCP_TOOLS`) so the hosted brain
 * loads the same set and the two doors cannot drift.
 */
export const NATIVE_TOOLS: readonly string[] = EVERYDAY_MCP_TOOLS;

/**
 * Destructive hints follow the directories' definition, not MCP's "additive"
 * one: a write is destructive when it sends, commits, overwrites, cancels or
 * revokes, and being able to undo it does not make it additive. Most writes
 * are. So the write dispatcher is itself marked destructive: a host that asks
 * before destructive tools asks before any dispatched write, and no tool has to
 * be listed natively just to carry its hint (Ido, 2026-10-05).
 */

const TOOLS_CATALOG_NAME = 'ziggs_tools';
const TOOL_READ_NAME = 'ziggs_tool_read';
const TOOL_WRITE_NAME = 'ziggs_tool_write';

/**
 * The catalog and its two dispatchers. Always listed, whatever the tier.
 *
 * Two dispatchers rather than one, split by annotation. A host and a store
 * reviewer both read what a tool is from its annotation, and one dispatcher
 * that carried reads and writes was marked write for all of them: every read
 * through it asked the human to confirm, and a directory reviewer saw exactly
 * the one-tool-for-safe-and-unsafe-operations shape they reject. Each
 * dispatcher accepts only its own lane and names the other lane's dispatcher
 * when it refuses.
 */
export const CATALOG_TOOLS: readonly string[] = [
  TOOLS_CATALOG_NAME,
  TOOL_READ_NAME,
  TOOL_WRITE_NAME,
];
const CATALOG_TOOL_NAMES: ReadonlySet<string> = new Set(CATALOG_TOOLS);

/**
 * A tool that takes a freeform target and payload has to say which API it
 * reaches; a store reviewer cannot otherwise tell what it does.
 */
const ZIGGS_API =
  'the Ziggs API (https://api.ziggsai.com, reference at https://ziggsai.com/docs)';

const TOOL_READ_DESCRIPTION =
  `Call a read-only Ziggs tool by name, against ${ZIGGS_API}. ` +
  'This reaches every read-only tool ziggs_tools lists, native or not. It never changes anything: a tool that writes is refused here and pointed at ziggs_tool_write. ' +
  'Look the tool up with ziggs_tools describe=[<name>] first when you do not already know its parameters: `args` is validated against the real schema and a wrong key is refused, not silently dropped. ' +
  'The result is exactly what the tool itself returns.';

const TOOL_WRITE_DESCRIPTION =
  `Call a Ziggs tool that creates or changes something, by name, against ${ZIGGS_API}. ` +
  'This reaches every writing tool ziggs_tools lists, native or not. Read-only tools are refused here and pointed at ziggs_tool_read. Most writes cannot be taken back (a sent message, a taken decision, an overwritten plan), so a call through here may ask the human first. ' +
  'Look the tool up with ziggs_tools describe=[<name>] first when you do not already know its parameters: `args` is validated against the real schema and a wrong key is refused, not silently dropped. ' +
  'The result is exactly what the tool itself returns.';

function isNative(name: string): boolean {
  return (NATIVE_TOOLS as readonly string[]).includes(name);
}

/** Per-tool how-to-call, derived from NATIVE_TOOLS and the annotations. */
export function callLine(entry: CatalogEntry): string {
  const dispatcher = laneOf(entry);
  if (isNative(entry.name)) {
    return `call it by name: ${entry.name}; ${dispatcher} { tool: "${entry.name}", args } also works`;
  }
  return `call via ${dispatcher} { tool, args }`;
}

function withCall(entry: CatalogEntry, base: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    ...(isNative(entry.name) ? { native: true } : {}),
    call: callLine(entry),
  };
}

function sortRows(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

/** Which dispatcher a catalog entry is called through. */
function laneOf(entry: CatalogEntry): string {
  return entry.annotations.readOnlyHint ? TOOL_READ_NAME : TOOL_WRITE_NAME;
}

/**
 * Keep `tools/list` to `listed` (plus the catalog tools, registered after this
 * runs) by filtering the response the SDK's own handler builds.
 *
 * The handler is read back off the underlying `Server` so the SDK stays the
 * author of every entry. That map is internal, so this asserts rather than
 * degrades: if a future SDK stops keeping handlers there, the server refuses to
 * start and says why. A silent fallback would ship the whole 58-tool surface to
 * every caller — the regression this policy exists to prevent — and it would
 * look like it worked.
 */
function listOnly(server: McpServer, listed: ReadonlySet<string>): void {
  const inner = server.server as unknown as {
    _requestHandlers?: Map<
      string,
      (req: unknown, extra: unknown) => Promise<{ tools: Array<{ name: string }> }>
    >;
  };
  const built = inner._requestHandlers?.get('tools/list');
  if (!built) {
    throw new Error(
      'ziggs-mcp: the MCP SDK no longer exposes its tools/list handler at ' +
        "server._requestHandlers.get('tools/list'), so the surface cannot be " +
        'narrowed to the native set. Fix surface.ts before shipping: without ' +
        'this filter every tool is listed and a cold connection pays for the ' +
        'whole catalog.',
    );
  }

  server.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    const all = await built(req, extra);
    return {
      ...all,
      tools: all.tools.filter(
        (t) => listed.has(t.name) || CATALOG_TOOL_NAMES.has(t.name),
      ),
    };
  });
}

interface Lane {
  name: string;
  description: string;
  annotations: TitledAnnotations;
  /** True when this lane carries the read-only tools. */
  readOnly: boolean;
  /** A real tool of this lane, for the parameter description. */
  example: string;
}

/**
 * One dispatcher: reaches every catalog tool of its lane by name, validates the
 * arguments against that tool's own strict schema, and runs its stored handler.
 */
function registerDispatcher(server: McpServer, lane: Lane): void {
  registerStrictTool(
    server,
    lane.name,
    {
      tool: z
        .string()
        .describe(`Tool name from ${TOOLS_CATALOG_NAME}, e.g. ${lane.example}.`),
      args: z
        .record(z.unknown())
        .optional()
        .describe("Arguments for that tool, as its own schema defines them."),
    },
    lane.annotations,
    async ({ tool, args }) => {
      const entry = catalogEntry(server, tool);
      if (!entry) {
        return toolError(
          `No such tool: ${tool}. Call ${TOOLS_CATALOG_NAME} for the full list of names.`,
        );
      }
      // Each lane carries one kind of tool, so its annotation is true of every
      // call through it. The other lane is named, not guessed at.
      const entryReadOnly = entry.annotations.readOnlyHint === true;
      if (entryReadOnly !== lane.readOnly) {
        return toolError(
          entryReadOnly
            ? `${entry.name} is read-only: call it with ${TOOL_READ_NAME} { tool, args }, not ${lane.name}.`
            : `${entry.name} changes state: call it with ${TOOL_WRITE_NAME} { tool, args }, not ${lane.name}.`,
        );
      }
      // Validate here rather than letting the handler read undefined fields:
      // the strict schema is what turns a misspelled key into a named refusal
      // instead of a call that runs and reports success for the wrong thing.
      // It is the object registration already built — the catalog carries it,
      // so a dispatch does not rebuild a schema that cannot have changed.
      const parsed = entry.params.safeParse(args ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
          .join('; ');
        // The unknown-key refusal already names the tool and lists what it
        // accepts; don't say the name twice.
        return toolError(
          detail.includes(entry.name) ? detail : `${entry.name} did not run: ${detail}`,
        );
      }
      try {
        return (await entry.call(parsed.data as Record<string, unknown>)) as ReturnType<
          typeof textResult
        >;
      } catch (e) {
        return toolError(e);
      }
    },
  );
}

/**
 * Narrow `tools/list` to the native set, then register the tools that make the
 * rest reachable: the catalog, and one dispatcher per annotation lane.
 *
 * Narrowing by `.disable()` would be the shorter way to do this, and it is the
 * wrong one: disabling takes a tool out of `tools/list` AND out of
 * `tools/call`. The SDK answers a direct call on a disabled tool with
 * `Tool <name> disabled`, thrown from inside its own handler where we cannot
 * reword it — so a caller holding a name (a saved config, a script, a model
 * that learned the name in an earlier session) hits a wall that does not say
 * the tool exists, where it went, or how to reach it.
 *
 * So every tool stays ENABLED, and the listing is narrowed instead. A name is
 * always callable; the list is still the native set plus the catalog tools.
 *
 * The listing delegates to the handler the SDK installed rather than rebuilding
 * one: the SDK owns how a registered tool becomes a `tools/list` entry, and
 * hand-building that response would risk a schema-shape difference on exactly
 * the tools every caller loads. We filter its output and change nothing else.
 */
export function applySurfacePolicy(
  server: McpServer,
  opts: {
    /** Answers `ziggs_tools need=`. Absent: `need` falls back to the full list. */
    pickTool?: PickTool;
  } = {},
): void {
  const native = new Set(NATIVE_TOOLS);
  listOnly(server, native);

  registerStrictTool(
    server,
    TOOLS_CATALOG_NAME,
    {
      describe: z
        .array(z.string())
        .optional()
        .describe(
          'Tool names to describe in full (description + input schema). Omit for the name-and-title listing.',
        ),
      search: z
        .string()
        .optional()
        .describe('Filter tools by name, title, or common intent such as contact, teammate, permission, or grant. Omit to list every tool.'),
      need: z
        .string()
        .optional()
        .describe('What you want done, in a plain sentence. Answers with the one tool that does it, or "nothing fits"; falls back to the full list when unsure.'),
    },
    readOnly('List every Ziggs tool'),
    async ({ describe, search, need }) => {
      try {
        if (describe?.length) {
          // Sorted rows are the listing's business — a describe answers by name
          // and never reads them, so building them here copied and sorted the
          // whole catalog on the call the surface asks a caller to make before
          // every unfamiliar dispatch.
          const found: CatalogEntry[] = [];
          const unknown: string[] = [];
          for (const name of describe) {
            const entry = catalogEntry(server, name);
            if (entry) found.push(entry);
            else unknown.push(name);
          }
          if (!found.length) {
            return toolError(
              `No such tool: ${unknown.join(', ')}. Call ${TOOLS_CATALOG_NAME} with no arguments for the full list of names.`,
            );
          }
          return textResult({
            tools: found.map((entry) => withCall(entry, describeEntry(entry))),
            ...(unknown.length ? { unknown } : {}),
          });
        }
        const all = sortRows(catalogFor(server));
        const wanted = need?.trim();
        if (wanted && opts.pickTool && !search?.trim()) {
          const answer = await opts.pickTool(
            wanted,
            all.map((e) => ({ name: e.name, line: pickLine(e.title, e.description) })),
          );
          const picked = answer?.how === 'pick' && answer.tool ? catalogEntry(server, answer.tool) : undefined;
          if (picked) {
            return textResult({
              need: wanted,
              tools: [withCall(picked, describeEntry(picked))],
              next: `This is the one tool for that need. Call it as its call line says. If it is not what you meant, call ${TOOLS_CATALOG_NAME} with no arguments for every tool.`,
            });
          }
          if (answer?.how === 'nothing_fits') {
            return textResult({
              need: wanted,
              tools: [],
              nothingFits: `No Ziggs tool does this. Call ${TOOLS_CATALOG_NAME} with no arguments to check the full list yourself.`,
            });
          }
          // Unsure, off or unreachable: the list, exactly as without `need`.
        }
        const needle = search?.trim().toLowerCase();
        const rows = (
          needle
            ? all.filter(
                (e) =>
                  e.name.toLowerCase().includes(needle) ||
                  e.title.toLowerCase().includes(needle) ||
                  aliasMatches(e.name, needle),
              )
            : all
        ).map((entry) => withCall(entry, catalogRow(entry)));
        return textResult({
          count: rows.length,
          ...(needle ? { search: needle, total: all.length } : {}),
          tools: rows,
          next: `Get full schemas with ${TOOLS_CATALOG_NAME} { describe: ["<name>"] }, then call read-only rows with ${TOOL_READ_NAME} { tool, args } and the rest with ${TOOL_WRITE_NAME} { tool, args }.`,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerDispatcher(server, {
    name: TOOL_READ_NAME,
    description: TOOL_READ_DESCRIPTION,
    annotations: readOnly('Call a read-only Ziggs tool'),
    readOnly: true,
    example: 'ziggs_agreement_list',
  });
  registerDispatcher(server, {
    name: TOOL_WRITE_NAME,
    description: TOOL_WRITE_DESCRIPTION,
    annotations: destructive('Call a Ziggs tool that changes something'),
    readOnly: false,
    example: 'ziggs_task_create',
  });

  // The catalog tools registered through the same path as everything else, so
  // they are in the catalog too. Take them out: listing ziggs_tools inside its
  // own listing is noise, and a dispatcher calling a dispatcher is a loop.
  for (const name of CATALOG_TOOLS) removeCatalogEntry(server, name);
}
