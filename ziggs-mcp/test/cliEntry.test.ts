import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', 'src/index.ts', ...args],
    { cwd: root, encoding: 'utf8', env, timeout: 8_000 },
  );
}

describe('ziggs-mcp entry', () => {
  it('prints help and exits 0', () => {
    const result = run(['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /Node 20/);
    assert.equal(result.stderr, '');
  });

  it('prints the package version and exits 0', () => {
    const result = run(['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), pkg.version);
  });

  it('prints one line and no stack when the key is missing', () => {
    const env = { ...process.env };
    delete env.ZIGGS_OPERATOR_KEY;
    delete env.ZIGGS_AGENT_ID;
    const result = run([], env);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ZIGGS_OPERATOR_KEY/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.equal(result.stderr.trim().split('\n').length, 1);
  });
});
