/**
 * Hosted fleet agents connect via api-client (Agent), never inbound ziggs-mcp.
 * @see
 */

export type McpServerSpec = {
  type?: string;
  command?: string;
  args?: string[];
};

export function looksLikeInboundZiggsMcp(command: string, args: string[] = []): boolean {
  const joined = `${command} ${args.join(' ')}`;
  return /ziggs-mcp|@ziggs-ai\/ziggs-mcp/i.test(joined);
}

/**
 * Reject wiring a hosted agent to the inbound Ziggs MCP stdio surface.
 * Claude SDK agents must use in-process ToolManager tools (createSdkMcpServer).
 */
export function assertHostedAgentZiggsTools(
  mcpServers: Record<string, McpServerSpec | unknown> | undefined,
): void {
  if (!mcpServers) return;
  for (const [name, raw] of Object.entries(mcpServers)) {
    if (!raw || typeof raw !== 'object') continue;
    const spec = raw as McpServerSpec;
    if (spec.type === 'stdio') {
      throw new Error(
        `Hosted Ziggs agents must not use stdio MCP (server "${name}"). ` +
          'Connect via api-client / Agent in-process tools.',
      );
    }
    if (looksLikeInboundZiggsMcp(String(spec.command ?? ''), spec.args ?? [])) {
      throw new Error(
        `Hosted Ziggs agents must not spawn ziggs-mcp (inbound MCP server "${name}"). ` +
          'Use Agent + in-process tools.',
      );
    }
  }
}
