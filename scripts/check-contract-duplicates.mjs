/**
 * ZIG-1778 — fail when a client re-declares a shape the contract already owns.
 *
 * `@ziggs-ai/contracts` is generated from the server's OpenAPI spec, so a type
 * with the same name written by hand here is a second opinion about what the
 * wire carries — and the hand-written one loses quietly. Every instance found
 * when this was written had drifted: `UnreadableRail` named three rails where
 * the server has five, `WalletRef` was all-optional with no `orgId`,
 * `GrantView` existed in three versions, `ChatSummary` declared a field the
 * wire never sends and omitted seven it does.
 *
 * The rule is narrow on purpose: only a NAME the contract exports counts, and
 * only where a client declares it as its own type. Importing it, re-exporting
 * it, aliasing it (`export type X = ContractX`) or deriving from a type is the
 * fix, not the offence; `export type X = 'a' | 'b'` or `= { a: string }` is a
 * copy.
 *
 *   node scripts/check-contract-duplicates.mjs
 *   node scripts/check-contract-duplicates.mjs --list   # report, exit 0
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIST_ONLY = process.argv.includes('--list');

/** Packages that talk to the API and therefore must not restate its shapes. */
const SURFACES = ['api-client/src', 'ziggs-mcp/src', 'agent-sdk/src'];

/**
 * The contract the packages actually build against. npm may nest it under each
 * package instead of hoisting it, and a stale copy at the root is not the one
 * they use, so look where api-client resolves it first.
 */
function contractsDir() {
  const candidates = [
    'api-client/node_modules/@ziggs-ai/contracts',
    'agent-sdk/node_modules/@ziggs-ai/contracts',
    'node_modules/@ziggs-ai/contracts',
  ].map((p) => join(ROOT, p));
  return candidates.find((dir) => existsSync(join(dir, 'dist'))) ?? candidates[candidates.length - 1];
}

/** Every type, value, and function the contract exports, read off its typings. */
function contractExports() {
  const dts = join(contractsDir(), 'dist');
  const types = new Set();
  const values = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.d.ts')) {
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(
          /^export (?:declare )?(?:type|interface) (\w+)/gm,
        )) {
          types.add(m[1]);
        }
        for (const m of src.matchAll(
          /^export declare (?:const|function) (\w+)/gm,
        )) {
          values.add(m[1]);
        }
      }
    }
  };
  walk(dts);
  return { types, values };
}

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (
        full.endsWith('.ts') &&
        !full.endsWith('.test.ts') &&
        !full.endsWith('.spec.ts')
      ) {
        out.push(full);
      }
    }
  };
  for (const s of SURFACES) {
    const dir = join(ROOT, s);
    try {
      walk(dir);
    } catch {
      /* a package that is not checked out is not a failure */
    }
  }
  return out;
}

const { types: owned, values: ownedValues } = contractExports();
if (owned.size === 0 && ownedValues.size === 0) {
  console.error(
    'check-contract-duplicates: read no type names from @ziggs-ai/contracts — is it installed?',
  );
  process.exit(1);
}

const hits = [];
for (const file of sources()) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // A declaration of its own, not an import, a re-export, or an alias onto
    // the contract's type.
    const m = /^export (?:type|interface) (\w+)(?:\s*=\s*(.*))?/.exec(lines[i]);
    if (!m) continue;
    const [, name, rhs] = m;
    if (!owned.has(name)) continue;
    // Importing, re-exporting, aliasing (`export type X = ContractX`) or
    // deriving from a type (`Omit<WireX, 'f'> & { … }`) is the fix. A right-hand
    // side made only of literals and primitives — `'read' | 'write'`,
    // `{ provider: string }` — restates the wire by hand (ZIG-2024: that is how
    // `GrantAccessKind` and `InboxPartyKind` were copied without this noticing).
    // A right-hand side that starts on the next line is judged by that line.
    if (rhs !== undefined) {
      const body = rhs.trim() || (lines[i + 1] ?? '');
      if (/(?:^|[^\w'"$])[A-Z][\w$]*/.test(body)) continue;
    }
    hits.push({ file: relative(ROOT, file), line: i + 1, name });
  }
  for (let i = 0; i < lines.length; i++) {
    // A value or function written out again. A re-export, or an alias onto a
    // contract value (`export const ContentTypes = MESSAGE_CONTENT_TYPE`), is
    // the one list. An array, object, or function body is a second copy.
    const value = /^export (?:const|function) (\w+)(?:\s*=\s*(.*))?/.exec(
      lines[i],
    );
    if (!value) continue;
    const [, name, rhs] = value;
    if (!ownedValues.has(name)) continue;
    if (rhs !== undefined) {
      const body = rhs.trim() || (lines[i + 1] ?? '');
      if (/^[A-Z_][\w$]*\b/.test(body)) continue;
    }
    hits.push({ file: relative(ROOT, file), line: i + 1, name });
  }
}

if (hits.length === 0) {
  console.log(
    `check-contract-duplicates: OK — ${owned.size} type(s), ${ownedValues.size} value(s), no client re-declares one.`,
  );
  process.exit(0);
}

for (const hit of hits) {
  console.error(`  ${hit.file}:${hit.line} re-declares ${hit.name}`);
}
if (LIST_ONLY) process.exit(0);
console.error(
  `\ncheck-contract-duplicates: ${hits.length} shape(s) the contract already owns are declared by hand.\n` +
    'The server generates these from its own spec, so a copy here is a second\n' +
    'opinion about what the wire carries — and the copy is the one that goes\n' +
    "stale. Import it from '@ziggs-ai/contracts' instead:\n" +
    "    import type { X } from '@ziggs-ai/contracts';\n" +
    '    export type { X };\n' +
    'If this package genuinely means a DIFFERENT thing by that name, give it a\n' +
    'different name — sharing one is how the two got confused.',
);
process.exit(1);
