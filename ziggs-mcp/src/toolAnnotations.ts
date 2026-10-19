import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

// MCP annotation hints so connector UIs (Claude, Cursor, …) can bucket Ziggs
// tools into "Read only" vs "Actions" instead of one undefined group.
// `readOnlyHint` drives that split; `destructiveHint` flags the irreversible
// ones so hosts can warn before running them. `title` is the label the host
// shows in place of the raw `rail_verb` wire name.

/** Annotations with a title — the shape `registerStrictTool` demands. */
export type TitledAnnotations = ToolAnnotations & { title: string };

/** Reads state, never mutates. */
export function readOnly(title: string): TitledAnnotations {
  return { title, readOnlyHint: true, destructiveHint: false, openWorldHint: false };
}

/** Writes state, but additively/reversibly (create, send, grant). */
export function write(title: string): TitledAnnotations {
  return { title, readOnlyHint: false, destructiveHint: false, openWorldHint: false };
}

/** Mutates state irreversibly (revoke). */
export function destructive(title: string): TitledAnnotations {
  return { title, readOnlyHint: false, destructiveHint: true, openWorldHint: false };
}
