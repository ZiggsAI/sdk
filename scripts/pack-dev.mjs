#!/usr/bin/env node
// Build the current packages into local, integrity-pinned development archives.
// This command never publishes or changes registry credentials.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  out: { type: 'string' },
  contracts: { type: 'string' },
} });
if (!values.out) throw new Error('Pass --out <directory> for development archives');
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const npm = (cwd, args) => execFileSync('npm', args, { cwd, stdio: 'inherit' });
const entries = [];
function record(name, version, filename, source) {
  const bytes = readFileSync(join(out, filename));
  entries.push({ name, version, filename, source, sha256: createHash('sha256').update(bytes).digest('hex') });
}
function pack(path, filename) {
  const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  // TypeScript does not remove outputs for deleted source files. Archives must
  // contain only the current implementation, including after runtime removal.
  rmSync(join(path, 'dist'), { recursive: true, force: true });
  npm(path, ['run', 'build']);
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], { cwd: path, encoding: 'utf8' }))[0];
  copyFileSync(join(out, packed.filename), join(out, filename));
  // The archive hash identifies the exact bytes even while developing a change.
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: path, encoding: 'utf8' }).trim());
  record(manifest.name, manifest.version, filename, { commit, dirty });
}
if (values.contracts) {
  pack(resolve(values.contracts), 'contracts.tgz');
} else {
  const vendor = join(root, 'vendor', 'ziggs');
  const manifest = JSON.parse(readFileSync(join(vendor, 'manifest.json'), 'utf8'));
  const contracts = manifest.packages.find(p => p.name === '@ziggs-ai/contracts');
  copyFileSync(join(vendor, contracts.filename), join(out, 'contracts.tgz'));
  record(contracts.name, contracts.version, 'contracts.tgz', contracts.source);
}
for (const name of ['api-client', 'agent-sdk', 'ziggs-mcp', 'ziggs-cli']) pack(join(root, name), `${name}.tgz`);
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ purpose: 'Unpublished development packages', packages: entries }, null, 2) + '\n');
console.log(`Development archives written to ${out}. Nothing was published.`);
