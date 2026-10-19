#!/usr/bin/env node
import { createRequire } from 'node:module';
import { startStdioServer } from './server.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const USAGE = `ziggs-mcp ${version}

Usage:
  ziggs-mcp              start the stdio server
  ziggs-mcp --help       print this help
  ziggs-mcp --version    print the version

Requires Node 20 or newer.
Set ZIGGS_OPERATOR_KEY to an operator key, or connect with OAuth at https://mcp.ziggsai.com/mcp.
`;

const arg = process.argv[2];
if (arg === '--help' || arg === '-h') {
  console.log(USAGE);
  process.exit(0);
}
if (arg === '--version' || arg === '-v') {
  console.log(version);
  process.exit(0);
}

startStdioServer().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
