import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, '.github/workflows/publish-npm-packages.yml'), 'utf8');
const job = (name) => src.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:\\n|(?![\\s\\S]))`, 'm'))?.[1] ?? '';

describe('one release tag publishes every package in one run', () => {
  it('runs on a release-* tag, after the one test job', () => {
    assert.match(src, /^      - 'release-\*'$/m);
    const release = job('publish-release');
    assert.match(release, /if: startsWith\(github\.ref_name, 'release-'\)/);
    assert.match(release, /needs: test/);
  });

  it('publishes in dependency order: api-client, agent-sdk, ziggs-mcp, then the CLI', () => {
    const order = ['api-client', 'agent-sdk', 'ziggs-mcp', 'ziggs-cli'].map((p) =>
      job('publish-release').indexOf(`"${p} @ziggs-ai/${p}"`),
    );
    assert.ok(order.every((i) => i > 0), 'every package is listed');
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  it('skips a version already on npm, and lets a failed publish fail the job', () => {
    const release = job('publish-release');
    assert.match(release, /set -euo pipefail/);
    assert.match(release, /if npm view "\$name@\$version" version >\/dev\/null 2>&1; then/);
    assert.doesNotMatch(release, /npm publish[^\n]*\|\| true/);
  });

  it('runs the MCP registry only when ziggs-mcp was published', () => {
    const registry = job('publish-release-mcp-registry');
    assert.match(registry, /needs: publish-release/);
    assert.match(registry, /if: needs\.publish-release\.outputs\.mcp == 'true'/);
    assert.match(registry, /uses: \.\/\.github\/workflows\/publish-mcp-registry\.yml/);
  });
});
