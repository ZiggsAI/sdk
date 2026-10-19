import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ZiggsMcpConfig } from '../../src/config.js';
import { createZiggsMcpServer } from '../../src/server.js';
import { catalogFor, describeEntry } from '../../src/toolCatalog.js';

/** Captures the registered contract without credentials, HTTP calls, or executing tools. */
export async function captureSurface(config: Pick<ZiggsMcpConfig, 'directConnection' | 'coreOnly' | 'debugTools'>) {
  const connectionKey = `test.${Buffer.from(JSON.stringify({ connectionClientId: 'surface-capture', issuedVia: 'mcp_oauth' })).toString('base64url')}.test`;
  const server = createZiggsMcpServer({
    operatorKey: config.directConnection ? 'surface-capture' : connectionKey,
    agentId: 'surface-capture',
  }, config as ZiggsMcpConfig);
  const client = new Client({ name: 'surface-capture', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return {
      instructions: client.getInstructions() ?? '',
      tools,
      catalog: catalogFor(server).map((entry) => describeEntry(entry) as unknown as Tool),
    };
  } finally {
    await client.close();
    await server.close();
  }
}
