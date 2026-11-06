import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { doorContext, retiredTool, retiredToolResult, type Door } from './retiredTools.js';

type Handler = (req: { params: { name: string } }, extra: unknown) => Promise<unknown>;

/**
 * Answer a direct call to a removed tool with the removed-tool message, before
 * the MCP SDK can say only that the tool was not found. Wraps whatever
 * `tools/call` handler is installed, so call it after every other one.
 *
 * On a session that keeps an open stream, the tool-list-changed signal goes out
 * as well, so an app that acts on it reloads its list without its person doing
 * anything. A session with no stream has nobody to tell; that is not an error.
 */
export function answerRetiredCalls(server: McpServer, door: Door): void {
  const inner = server.server as unknown as { _requestHandlers?: Map<string, Handler> };
  const built = inner._requestHandlers?.get('tools/call');
  if (!built) return;
  server.server.setRequestHandler(CallToolRequestSchema, (async (req: { params: { name: string } }, extra: unknown) => {
    const retired = retiredTool(req.params.name);
    if (!retired) return built(req, extra);
    try {
      server.sendToolListChanged();
    } catch {
      // No open stream on this session.
    }
    return retiredToolResult(req.params.name, retired, doorContext(server, door));
  }) as never);
}
