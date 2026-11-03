#!/usr/bin/env node
// Build the current packages into local, integrity-pinned development archives.
// This command never publishes or changes registry credentials.
//
// Archives are built only from committed source, and each carries that commit
// in its version: api-client 0.39.0-next.0 at b03aa86 packs as
// 0.39.0-next.0.dev.gb03aa86, ziggs-mcp 0.38.3 as 0.38.3-dev.gb03aa86. A
// development archive therefore never shares a version with a different npm
// release, and the archives from one run pin each other at those versions.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK_PACKAGES = ['api-client', 'agent-sdk', 'ziggs-mcp', 'ziggs-cli'];
// Everything a package build reads besides its own folder.
const SHARED_INPUTS = ['package.json', 'package-lock.json', 'tsconfig.json', 'vendor'];
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

const { values } = parseArgs({ options: {
  out: { type: 'string' },
  contracts: { type: 'string' },
} });
if (!values.out) throw new Error('Pass --out <directory> for development archives');
const out = resolve(values.out);
const npm = (cwd, args) => execFileSync('npm', args, { cwd, stdio: 'inherit' });
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const entries = [];
/** Package name -> the version its archive in this run carries. */
const versions = new Map();

function requireCommitted(cwd, paths) {
  const changed = git(cwd, ['status', '--porcelain', '--', ...paths]);
  if (changed) {
    throw new Error(
      `An archive must match a commit. Commit or stash these changes in ${cwd} first:\n${changed}\n`
      + 'To try uncommitted SDK code in another checkout, use npm run dev:link.',
    );
  }
}

function devVersion(version, commit) {
  const id = `dev.g${commit.slice(0, 7)}`;
  return version.includes('-') ? `${version}.${id}` : `${version}-${id}`;
}

function record(name, version, filename, source) {
  const bytes = readFileSync(join(out, filename));
  versions.set(name, version);
  entries.push({ name, version, filename, source, sha256: createHash('sha256').update(bytes).digest('hex') });
}

function pack(path, filename) {
  const commit = git(path, ['rev-parse', 'HEAD']);
  // TypeScript does not remove outputs for deleted source files. Archives must
  // contain only the current implementation, including after runtime removal.
  rmSync(join(path, 'dist'), { recursive: true, force: true });
  npm(path, ['run', 'build']);
  const staging = mkdtempSync(join(tmpdir(), 'ziggs-pack-'));
  try {
    const built = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', staging], { cwd: path, encoding: 'utf8' }))[0];
    execFileSync('tar', ['-xzf', join(staging, built.filename), '-C', staging]);
    const dir = join(staging, 'package');
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    manifest.version = devVersion(manifest.version, commit);
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (versions.has(name)) manifest[field][name] = versions.get(name);
      }
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], { cwd: dir, encoding: 'utf8' }))[0];
    renameSync(join(out, packed.filename), join(out, filename));
    record(manifest.name, manifest.version, filename, { commit });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const contractsPath = values.contracts && resolve(values.contracts);
if (contractsPath) requireCommitted(contractsPath, ['.']);
requireCommitted(root, [...SHARED_INPUTS, ...SDK_PACKAGES]);
mkdirSync(out, { recursive: true });
if (contractsPath) {
  pack(contractsPath, 'contracts.tgz');
} else {
  const vendor = join(root, 'vendor', 'ziggs');
  const manifest = JSON.parse(readFileSync(join(vendor, 'manifest.json'), 'utf8'));
  const contracts = manifest.packages.find(p => p.name === '@ziggs-ai/contracts');
  if (contracts.source.dirty) throw new Error(`vendor/ziggs/contracts.tgz was built from uncommitted source; refresh it with --contracts`);
  copyFileSync(join(vendor, contracts.filename), join(out, 'contracts.tgz'));
  record(contracts.name, contracts.version, 'contracts.tgz', { commit: contracts.source.commit });
}
for (const name of SDK_PACKAGES) pack(join(root, name), `${name}.tgz`);
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ purpose: 'Unpublished development packages', packages: entries }, null, 2) + '\n');
console.log(`Development archives written to ${out}. Nothing was published.`);
