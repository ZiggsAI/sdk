import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createZiggsMcpServer } from '../src/server.js';

/**
 * Rewrite test/registered-tools.snapshot.json from the tools both doors list
 * today. Run it when a tool is ADDED; a tool that is REMOVED needs a row in
 * src/retiredTools.ts instead, and the test says so.
 */
const names = new Set<string>();
for (const cfg of [{}, { directConnection: false }]) {
  const server = createZiggsMcpServer({ operatorKey: 'op', agentId: 'a' } as never, cfg as never);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'snapshot', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  for (const tool of (await client.listTools()).tools) names.add(tool.name);
  await client.close();
}
writeFileSync(
  new URL('../test/registered-tools.snapshot.json', import.meta.url),
  `${JSON.stringify([...names].sort(), null, 2)}\n`,
);
console.log(`${names.size} tools`);
