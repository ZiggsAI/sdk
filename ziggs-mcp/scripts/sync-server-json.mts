/**
 * ZIG-1224 — server.json's version is the one the MCP registry publishes, and
 * package.json's is the one npm publishes. Nothing kept them equal, so
 * server.json sat at 0.9.0 through three npm releases and every
 * `ziggs-mcp-v*` tag re-submitted an already-registered version:
 *
 *   400 invalid version: cannot publish duplicate version
 *
 * The failure is invisible — the registry listing just stops moving, npm and
 * the hosted MCP are unaffected, and the workflow only runs on a tag. So the
 * version is derived here rather than typed twice.
 *
 *   npm run sync:server-json     # write package.json's version into server.json
 *   npm run check:server-json    # exit 1 if they disagree (CI / test)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

interface ServerJson {
  version: string;
  packages?: Array<{ version: string; identifier?: string }>;
  [key: string]: unknown;
}

/**
 * Both the server-level version and each package entry's version have to move:
 * the registry verifies npm ownership by resolving `packages[].identifier` at
 * `packages[].version`, so a stale entry would point the listing at an old
 * tarball even once the top-level version was correct.
 */
export function syncedServerJson(serverJson: string, version: string): string {
  const parsed = JSON.parse(serverJson) as ServerJson;
  parsed.version = version;
  for (const pkg of parsed.packages ?? []) pkg.version = version;
  // Trailing newline: the file is committed, and rewriting it without one puts
  // a spurious diff on every sync.
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export async function readVersions(): Promise<{
  packageVersion: string;
  serverJson: string;
  serverPath: string;
}> {
  const serverPath = join(root, 'server.json');
  const [pkg, serverJson] = await Promise.all([
    readFile(join(root, 'package.json'), 'utf8'),
    readFile(serverPath, 'utf8'),
  ]);
  const packageVersion = (JSON.parse(pkg) as { version: string }).version;
  return { packageVersion, serverJson, serverPath };
}

async function run(check: boolean): Promise<void> {
  const { packageVersion, serverJson, serverPath } = await readVersions();
  const next = syncedServerJson(serverJson, packageVersion);
  if (next === serverJson) {
    if (!check) process.stdout.write(`server.json already at ${packageVersion}\n`);
    return;
  }
  if (check) {
    const current = (JSON.parse(serverJson) as ServerJson).version;
    process.stderr.write(
      `server.json is at ${current} but package.json is at ${packageVersion} — ` +
        'run `npm run sync:server-json`. Publishing as-is fails the MCP registry ' +
        'with "cannot publish duplicate version".\n',
    );
    process.exit(1);
  }
  await writeFile(serverPath, next);
  process.stdout.write(`updated ${serverPath} to ${packageVersion}\n`);
}

// Importing this module from the drift test must not run the CLI.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void run(process.argv.includes('--check'));
}
