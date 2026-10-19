/**
 * needs.ts — what an agent cannot work without, declared once.
 *
 * An agent is otherwise two hand-written lists — instructions and tools — with
 * nothing checking they agree, so a prompt can promise work the toolset has no
 * way to do and the mismatch only surfaces on a real hire. A third list to
 * compare against the other two would drift the same way, so the declaration
 * DERIVES the tools instead. The author never writes that part of the list, so
 * the mismatch cannot be written.
 *
 * Scope is agents built on this SDK.
 */

import { toolName, type ToolDefinition } from './defineTool.js';
import { connectionListGrantsTool, connectionProxyTool } from '../platform/tools/tier2/connectionTools.js';
import { MCP_CONNECTION_TOOLS } from '../platform/tools/tier2/mcpConnectionTools.js';

/**
 * A remote MCP server is stored as `provider: 'mcp'` and goes through the
 * gateway. `connection_proxy` resolves a NAMED connector and refuses it with
 * "Unknown provider: mcp" — the second wall linear-janitor hit.
 */
export const MCP_PROVIDER = 'mcp';

/**
 * One shape for now, the one we have actually hit. A second kind means a case in
 * {@link toolsForNeed}: a need nothing derives tools from is a need nothing
 * enforces.
 */
export interface ConnectionNeed {
  /** Provider, e.g. 'mcp' or a named connector like 'github'. */
  connection: string;
}

export type AgentNeed = ConnectionNeed;

/** Reads a manifest's `needs` field defensively — it crosses a package edge. */
export function normalizeNeeds(input: unknown): AgentNeed[] {
  if (!Array.isArray(input)) return [];
  const out: AgentNeed[] = [];
  for (const raw of input) {
    const connection = (raw as ConnectionNeed | undefined)?.connection;
    if (typeof connection === 'string' && connection.trim()) {
      out.push({ connection: connection.trim() });
    }
  }
  return out;
}

/**
 * The tools a stated need implies. `connection_list_grants` rides every need
 * because seeing the grant is half of using it: the janitor's first failure was
 * an agent that held a Linear grant and had no way to notice.
 */
export function toolsForNeed(need: AgentNeed): ToolDefinition[] {
  return need.connection === MCP_PROVIDER
    ? [connectionListGrantsTool, ...MCP_CONNECTION_TOOLS]
    : [connectionListGrantsTool, connectionProxyTool];
}

/** Deduped by tool name, so overlapping needs (and a hand-listed tool) merge. */
export function toolsForNeeds(needs: AgentNeed[]): ToolDefinition[] {
  const byName = new Map<string, ToolDefinition>();
  for (const need of needs) {
    for (const tool of toolsForNeed(need)) {
      const name = toolName(tool);
      if (name) byName.set(name, tool);
    }
  }
  return [...byName.values()];
}

/** One line naming what is missing, for a refusal a human can act on. */
export function describeNeed(need: AgentNeed): string {
  return need.connection === MCP_PROVIDER
    ? 'a connection to an MCP server'
    : `a ${need.connection} connection`;
}

/**
 * Which declared needs have no live grant behind them.
 *
 * `providers` are the providers of the agent's live connection grants. The label
 * a grant carries is the provider, sometimes suffixed with the owner's account
 * ("github — acme/infra"), so the provider is the part before the separator.
 */
export function unmetNeeds(needs: AgentNeed[], providers: Array<string | null | undefined>): AgentNeed[] {
  const held = new Set(
    providers
      .map((p) => String(p ?? '').split('—')[0].trim().toLowerCase())
      .filter(Boolean),
  );
  return needs.filter((n) => !held.has(n.connection.toLowerCase()));
}

/**
 * The refusal itself. Names the missing access and who can fix it, because the
 * agent cannot: issuing a connection grant is the connection owner's act.
 */
export function unmetNeedsMessage(unmet: AgentNeed[]): string {
  const list = unmet.map(describeNeed).join(', ');
  return (
    `Cannot start this task: no live grant for ${list}. ` +
    'Ask the connection owner to issue one for this agent, then re-assign the task.'
  );
}
