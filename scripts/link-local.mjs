#!/usr/bin/env node
// Explicit development mode: use sibling source packages without publishing or
// changing manifests/lockfiles. npm ci restores registry dependencies.
import { readFile, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  contracts: { type: 'string' },
  consumer: { type: 'string', multiple: true, default: [] },
} });
if (!values.contracts) throw new Error('Pass --contracts <path> to the local contracts package');
const contracts = resolve(root, values.contracts);
const consumers = values.consumer.map(path => resolve(root, path));
const workspaces = ['api-client', 'agent-sdk', 'ziggs-mcp', 'ziggs-cli'];
const packages = [contracts, ...workspaces.map((name) => join(root, name))];
const manifests = await Promise.all(packages.map(async (path) => ({
  path: await realpath(path),
  ...JSON.parse(await readFile(join(path, 'package.json'), 'utf8')),
})));
if (manifests[0].name !== '@ziggs-ai/contracts') throw new Error('Expected the contracts package');
const consumerManifests = await Promise.all(consumers.map(async path => ({path, ...JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))})));

async function link(into, pkg) {
  if (!pkg.name.startsWith('@ziggs-ai/')) throw new Error('Only Ziggs packages may be linked');
  const target = join(into, 'node_modules', pkg.name);
  await mkdir(dirname(target), { recursive: true });
  // rm removes the directory entry, never the contents of an existing symlink.
  await rm(target, { recursive: true, force: true });
  await symlink(pkg.path, target, 'dir');
}
function run(cwd, args) {
  const result = spawnSync('npm', args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed in ${cwd}`);
}

// Explicit links in each workspace also replace any previously nested npm
// installation, which would otherwise silently shadow the local contracts.
for (const pkg of manifests) await link(root, pkg);
for (const consumer of manifests.slice(1)) {
  const dependencies = {...consumer.dependencies, ...consumer.devDependencies};
  for (const pkg of manifests) {
    if (dependencies[pkg.name]) await link(consumer.path, pkg);
  }
}
run(contracts, ['run', 'build']);
for (const name of workspaces) run(join(root, name), ['run', 'build']);
for (const consumer of consumerManifests) {
  const dependencies = {...consumer.dependencies, ...consumer.devDependencies};
  for (const pkg of manifests) if (dependencies[pkg.name]) await link(consumer.path, pkg);
}
console.log('Local packages linked and built. Re-run after npm ci; no registry publication or lockfile changes.');
for (const pkg of manifests) console.log(`${pkg.name}@${pkg.version} → ${pkg.path}`);
