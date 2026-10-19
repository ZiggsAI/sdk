import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleDir = join(__dirname, '../../examples/claude-agent');

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? listSourceFiles(p) : /\.(ts|js|mjs)$/.test(e.name) ? [p] : [];
  });
}

/** Patterns that mean the example wires inbound ziggs-mcp (forbidden for hosted agents). */
const FORBIDDEN_WIRING = [
  /from\s+['"].*ziggs-mcp/,
  /import\s+['"].*ziggs-mcp/,
  /type:\s*['"]stdio['"]/,
  /runClaudeZiggsAgent/,
  /DEFAULT_MCP_ENTRY/,
  /mcpServers:\s*\{[^}]*stdio/,
];

describe('examples/claude-agent (ZIG-781)', () => {
  it('does not wire inbound ziggs-mcp stdio', () => {
    const files = listSourceFiles(exampleDir);
    assert.ok(files.length > 0, 'expected example source files');
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const pat of FORBIDDEN_WIRING) {
        assert.doesNotMatch(text, pat, `${file} must not wire ziggs-mcp: ${pat}`);
      }
    }
  });

  it('uses Agent / createAgent', () => {
    const agentTs = readFileSync(join(exampleDir, 'agent.ts'), 'utf8');
    assert.match(agentTs, /createAgent/);
    assert.match(agentTs, /connectAsync/);
  });
});
