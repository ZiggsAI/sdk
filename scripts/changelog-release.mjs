/**
 * A published package version must have its own changelog heading.
 *
 *   node scripts/changelog-release.mjs --check
 *   node scripts/changelog-release.mjs --write
 *
 * `--write` files whatever is under Unreleased onto the version in
 * package.json, then leaves Unreleased empty. Run it in the same change
 * as a version bump. `--check` fails the publish when that heading is
 * missing, so a bump cannot ship with the notes still unmarked.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHANGELOG_PACKAGES = ['api-client', 'ziggs-mcp'];

export function changelogHasVersion(markdown, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^## ${escaped}(?:\\s|$)`, 'm').test(markdown);
}

export function promoteUnreleased(markdown, version) {
  if (changelogHasVersion(markdown, version)) return markdown;
  const heading = markdown.match(/^## Unreleased[^\n]*\n/m);
  if (!heading) {
    throw new Error('CHANGELOG has no Unreleased section');
  }
  const bodyStart = heading.index + heading[0].length;
  const rest = markdown.slice(bodyStart);
  const nextAt = rest.search(/^## /m);
  const body = (nextAt === -1 ? rest : rest.slice(0, nextAt)).trim();
  const after = nextAt === -1 ? '' : rest.slice(nextAt);
  const entry = body
    ? `## ${version}\n\n${body}\n\n`
    : `## ${version}\n\n- No notes were written for this version.\n\n`;
  return `${markdown.slice(0, heading.index)}## Unreleased\n\n${entry}${after}`;
}

export function readPackageVersion(root, name) {
  const pkg = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error(`${name} has no version`);
  }
  return pkg.version;
}

export function missingChangelogHeadings(root, packages = CHANGELOG_PACKAGES) {
  const missing = [];
  for (const name of packages) {
    const version = readPackageVersion(root, name);
    const markdown = readFileSync(join(root, name, 'CHANGELOG.md'), 'utf8');
    if (!changelogHasVersion(markdown, version)) missing.push({ name, version });
  }
  return missing;
}

export function writeChangelogHeadings(root, packages = CHANGELOG_PACKAGES) {
  const wrote = [];
  for (const name of packages) {
    const version = readPackageVersion(root, name);
    const path = join(root, name, 'CHANGELOG.md');
    const markdown = readFileSync(path, 'utf8');
    const next = promoteUnreleased(markdown, version);
    if (next !== markdown) {
      writeFileSync(path, next);
      wrote.push({ name, version });
    }
  }
  return wrote;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check') || !write;
  if (write) {
    const wrote = writeChangelogHeadings(root);
    for (const row of wrote) {
      process.stdout.write(`${row.name}: filed Unreleased notes under ${row.version}\n`);
    }
    if (!wrote.length) process.stdout.write('changelog headings already match package versions\n');
  }
  if (!check) return;
  const missing = missingChangelogHeadings(root);
  if (!missing.length) {
    process.stdout.write('changelog headings match package versions\n');
    return;
  }
  for (const row of missing) {
    process.stderr.write(
      `${row.name} ${row.version} has no changelog heading. Run: node scripts/changelog-release.mjs --write\n`,
    );
  }
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
