import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package entry must load in a runtime that has no node builtins.
 *
 * A mobile bundler resolves every static specifier it can see, so one
 * `import ... from 'node:os'` anywhere in the entry's graph makes the whole
 * package unimportable there — the failure is at bundle time, far from the
 * file that caused it, and a type-only import hides it because those are
 * erased before the bundler ever looks.
 *
 * Dynamic `import('node:...')` inside a function is deliberately allowed: it
 * is reached only on the path that needs it.
 */

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const STATIC_NODE_IMPORT = /^\s*import\s[^;]*?\sfrom\s*['"]node:[^'"]+['"]/gm;

describe('entry portability', () => {
  it('no source file statically imports a node builtin', () => {
    const offenders = tsFiles(srcDir).flatMap((file) => {
      const hits = readFileSync(file, 'utf8').match(STATIC_NODE_IMPORT) ?? [];
      return hits.map((hit) => `${file.slice(srcDir.length + 1)}: ${hit.trim()}`);
    });
    assert.deepEqual(
      offenders,
      [],
      `static node builtin import(s) in the package graph:\n${offenders.join('\n')}`,
    );
  });

  it('every declared export subpath points at a file the build emits', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { exports: Record<string, { types: string; import: string }> };

    for (const [subpath, target] of Object.entries(pkg.exports)) {
      // dist/<name>/index.js is emitted from src/<name>/index.ts
      const source = target.import
        .replace(/^\.\/dist\//, '')
        .replace(/\.js$/, '.ts');
      assert.ok(
        tsFiles(srcDir).some((f) => f.slice(srcDir.length + 1) === source),
        `exports["${subpath}"] points at ${target.import}, which no source file emits`,
      );
    }
  });
});
