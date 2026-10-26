/**
 * ZIG-2104 — check the directory packages in `plugins/ziggs/` and build the
 * ChatGPT ZIP from them.
 *
 *   npx tsx scripts/directory-packages.mts            # check, exit 1 on a problem
 *   npx tsx scripts/directory-packages.mts --zip      # check, then write the ZIP
 *
 * One folder carries all three packages, so a change to the server URL or the
 * listing lands in each at once:
 *
 *   plugin.json + mcp.json        Agent Plugins, with OpenAI's listing and
 *                                 review block (the ChatGPT ZIP)
 *   .cursor-plugin/plugin.json    Cursor Marketplace
 *   .claude-plugin/plugin.json    Claude Code plugin
 *
 * The Cursor Marketplace takes a repository link. Because the plugin sits in a
 * subfolder, the repo root carries `.cursor-plugin/marketplace.json` pointing
 * at it; checkMarketplace() holds that file to Cursor's rules.
 *
 * Each declares the same remote OAuth server and nothing else: no command, no
 * header, no environment variable, so no package can carry a key. The limits
 * below are OpenAI's published ones (developers.openai.com/plugins/deploy/submission,
 * read 2026-10-08); a listing that breaks one is refused at upload, so it
 * fails here first.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DIRECTORY_TOOLS } from '../src/directorySurface.js';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../plugins/ziggs');
export const REPO_ROOT = resolve(PLUGIN_ROOT, '../..');
export const MCP_URL = 'https://mcp.ziggsai.com/mcp';

/** What a ChatGPT ZIP holds. The Cursor and Claude manifests stay out of it. */
export const ZIP_FILES = ['plugin.json', 'mcp.json', 'README.md', 'assets/logo.png'];

/** The Add to Cursor link: Cursor's deeplink with the server config, base64. */
export function cursorInstallLink(): string {
  const config = Buffer.from(JSON.stringify({ url: MCP_URL })).toString('base64');
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=ziggs&config=${config}`;
}

/**
 * The Install in VS Code link. VS Code's own scheme is `vscode:mcp/install`;
 * this is the https form vscode.dev redirects to it, so it is clickable on
 * GitHub and in a browser, where a `vscode:` link is not.
 */
export function vscodeInstallLink(): string {
  const config = encodeURIComponent(JSON.stringify({ type: 'http', url: MCP_URL }));
  return `https://vscode.dev/redirect/mcp/install?name=ziggs&config=${config}`;
}

type Json = Record<string, unknown>;

function readJson(root: string, path: string, problems: string[]): Json {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8')) as Json;
  } catch (err) {
    problems.push(`${path}: ${(err as Error).message}`);
    return {};
  }
}

/** A relative path that stays inside the package and names a file that exists. */
function checkPath(root: string, from: string, path: unknown, problems: string[]): void {
  if (typeof path !== 'string' || path === '') {
    problems.push(`${from}: missing path`);
    return;
  }
  const clean = normalize(path.replace(/^\.\//, ''));
  if (path.startsWith('/') || clean.startsWith('..') || /^[a-z]+:/i.test(path)) {
    problems.push(`${from}: ${path} must be relative to the package root`);
    return;
  }
  if (!existsSync(join(root, clean))) problems.push(`${from}: ${path} does not exist`);
}

function checkLength(from: string, value: unknown, max: number, problems: string[]): void {
  if (typeof value !== 'string' || value.trim() === '') problems.push(`${from}: required`);
  else if (value.length > max) problems.push(`${from}: ${value.length} characters, over ${max}`);
}

/** The one server every manifest declares, and nothing that could carry a key. */
function checkServers(from: string, servers: unknown, expected: Json, problems: string[]): void {
  const entries = Object.entries((servers ?? {}) as Json);
  if (entries.length !== 1) {
    problems.push(`${from}: declares ${entries.length} MCP servers, needs exactly one`);
    return;
  }
  const [, server] = entries[0];
  if (JSON.stringify(server) !== JSON.stringify(expected)) {
    problems.push(`${from}: server is ${JSON.stringify(server)}, expected ${JSON.stringify(expected)}`);
  }
}

/** PNG width and height from the IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.subarray(1, 4).toString('ascii') !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function checkIcon(root: string, from: string, path: unknown, problems: string[]): void {
  if (typeof path !== 'string') return;
  const file = join(root, path.replace(/^\.\//, ''));
  if (!existsSync(file)) return; // checkPath reports it
  if (statSync(file).size > 5 * 1024 * 1024) problems.push(`${from}: ${path} is over 5 MiB`);
  if (file.endsWith('.png')) {
    const size = pngSize(readFileSync(file));
    if (!size) problems.push(`${from}: ${path} is not a PNG`);
    else if (size.width !== size.height || size.width < 48 || size.width > 4096) {
      problems.push(`${from}: ${path} is ${size.width}x${size.height}, needs a square of 48 to 4096`);
    }
  } else if (file.endsWith('.svg')) {
    const box = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(readFileSync(file, 'utf8'));
    if (!box || box[1] !== box[2] || Number(box[1]) < 48) {
      problems.push(`${from}: ${path} needs a square viewBox of at least 48`);
    }
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

export function checkPackages(root = PLUGIN_ROOT): string[] {
  const problems: string[] = [];

  // ── Agent Plugins + OpenAI (the ChatGPT ZIP) ──
  const plugin = readJson(root, 'plugin.json', problems);
  const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  if (typeof plugin.name !== 'string' || !kebab.test(plugin.name) || plugin.name.length > 64) {
    problems.push('plugin.json name: lowercase with hyphens, at most 64 characters');
  }
  checkLength('plugin.json description', plugin.description, 4000, problems);
  const mcp = readJson(root, 'mcp.json', problems);
  checkServers('mcp.json', mcp.mcpServers, { type: 'streamable-http', url: MCP_URL }, problems);

  const openai = ((plugin.extensions as Json | undefined)?.['com.openai'] ?? {}) as Json;
  const ui = (openai.interface ?? {}) as Json;
  checkLength('interface.displayName', ui.displayName, 30, problems);
  checkLength('interface.shortDescription', ui.shortDescription, 30, problems);
  checkLength('interface.longDescription', ui.longDescription, 4000, problems);
  checkLength('interface.developerName', ui.developerName, 80, problems);
  checkLength('interface.category', ui.category, 80, problems);
  for (const key of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    const url = ui[key];
    if (typeof url !== 'string' || !url.startsWith('https://') || url.length > 1024) {
      problems.push(`interface.${key}: an https URL of at most 1024 characters`);
    }
  }
  const capabilities = (ui.capabilities ?? []) as unknown[];
  if (capabilities.length > 20) problems.push('interface.capabilities: at most 20');
  capabilities.forEach((c, i) => checkLength(`interface.capabilities[${i}]`, c, 120, problems));
  const prompts = (ui.defaultPrompt ?? []) as unknown[];
  if (prompts.length > 3) problems.push('interface.defaultPrompt: at most 3');
  prompts.forEach((p, i) => checkLength(`interface.defaultPrompt[${i}]`, p, 128, problems));
  for (const key of ['logo', 'composerIcon']) {
    checkPath(root, `interface.${key}`, ui[key], problems);
    checkIcon(root, `interface.${key}`, ui[key], problems);
  }
  for (const key of ['brandColor', 'brandColorDark']) {
    if (ui[key] !== undefined && !/^#[0-9a-f]{6}$/i.test(String(ui[key]))) {
      problems.push(`interface.${key}: a hex colour like #302636`);
    }
  }

  const review = (openai.review ?? {}) as Json;
  const cases = (review.test_cases ?? {}) as { positive?: Json[]; negative?: Json[] };
  if (cases.positive?.length !== 5) problems.push('review: five positive test cases');
  if (cases.negative?.length !== 3) problems.push('review: three negative test cases');
  for (const [i, c] of (cases.positive ?? []).entries()) {
    for (const key of ['description', 'prompt', 'tools_triggered', 'expected_behavior']) {
      checkLength(`review.positive[${i}].${key}`, c[key], 4000, problems);
    }
    // A reviewer runs these against the live server: a name it does not list
    // is a failed case before anyone types the prompt.
    for (const tool of String(c.tools_triggered ?? '').split(',').map((t) => t.trim())) {
      if (tool && !DIRECTORY_TOOLS.has(tool)) {
        problems.push(`review.positive[${i}]: ${tool} is not a directory tool`);
      }
    }
  }
  for (const [i, c] of (cases.negative ?? []).entries()) {
    for (const key of ['description', 'prompt']) checkLength(`review.negative[${i}].${key}`, c[key], 4000, problems);
  }
  if (typeof review.commerce !== 'boolean') problems.push('review.commerce: true or false');

  // The portal imports these into the review form. Countries and the demo
  // recording are typed there at submit time, so only their shape is held here.
  const publication = (openai.publication ?? {}) as Json;
  checkLength('publication.release_notes', publication.release_notes, 4000, problems);
  if (publication.countries !== undefined) {
    const countries = publication.countries as unknown;
    if (!Array.isArray(countries) || !countries.every((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c))) {
      problems.push('publication.countries: uppercase two-letter country codes');
    }
  }
  if (review.demo_recording_url !== undefined) {
    const url = review.demo_recording_url;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      problems.push('review.demo_recording_url: an https URL');
    }
  }

  // ── Cursor ──
  const cursor = readJson(root, '.cursor-plugin/plugin.json', problems);
  if (typeof cursor.name !== 'string' || !kebab.test(cursor.name)) {
    problems.push('.cursor-plugin/plugin.json name: lowercase kebab-case');
  }
  checkPath(root, '.cursor-plugin logo', cursor.logo, problems);
  checkIcon(root, '.cursor-plugin logo', cursor.logo, problems);
  checkServers('.cursor-plugin/plugin.json', cursor.mcpServers, { url: MCP_URL }, problems);

  // ── Claude Code ──
  const claude = readJson(root, '.claude-plugin/plugin.json', problems);
  if (typeof claude.name !== 'string' || !kebab.test(claude.name)) {
    problems.push('.claude-plugin/plugin.json name: lowercase kebab-case');
  }
  checkServers('.claude-plugin/plugin.json', claude.mcpServers, { type: 'http', url: MCP_URL }, problems);

  // One name and one version across the three, so a release bumps them together.
  for (const key of ['name', 'version'] as const) {
    const values = new Set([plugin[key], cursor[key], claude[key]]);
    if (values.size !== 1) problems.push(`${key} differs across the manifests: ${[...values].join(', ')}`);
  }

  // ── README and secrets ──
  if (!existsSync(join(root, 'README.md'))) {
    problems.push('README.md: required by Cursor');
  } else {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    if (!readme.includes(cursorInstallLink())) problems.push('README.md: Add to Cursor link is not the current one');
    if (!readme.includes(vscodeInstallLink())) problems.push('README.md: Install in VS Code link is not the current one');
    if (!/^## Privacy Policy$/m.test(readme)) problems.push('README.md: needs a "## Privacy Policy" section');
    if (!readme.includes('https://ziggsai.com/privacy')) problems.push('README.md: privacy policy link is missing');
    if (!readme.includes('Delete my account, in Settings, ends the login.')) {
      problems.push('README.md: Delete my account, in Settings, ends the login.');
    }
  }
  for (const file of filesUnder(root)) {
    if (!/\.(json|md)$/.test(file)) continue;
    const body = readFileSync(file, 'utf8');
    if (/\$\{|ZIGGS_OPERATOR_KEY|Bearer |\bop_[A-Za-z0-9]|"(headers|env|command)"\s*:/.test(body)) {
      problems.push(`${relative(root, file)}: looks like it carries a credential or a local command`);
    }
  }

  return problems;
}

/**
 * The repo-root marketplace manifest Cursor reads to find a plugin in a
 * subfolder: kebab-case names, an owner, and each entry's source resolving,
 * by a relative path, to a folder with `.cursor-plugin/plugin.json` whose name
 * matches the entry.
 */
export function checkMarketplace(repoRoot = REPO_ROOT): string[] {
  const problems: string[] = [];
  const file = '.cursor-plugin/marketplace.json';
  const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const market = readJson(repoRoot, file, problems);
  if (problems.length) return problems;
  if (typeof market.name !== 'string' || !kebab.test(market.name)) problems.push(`${file} name: lowercase kebab-case`);
  const owner = market.owner as Json | undefined;
  if (typeof owner?.name !== 'string' || !owner.name) problems.push(`${file} owner.name: required`);
  const pluginRoot = (market.metadata as Json | undefined)?.pluginRoot;
  const entries = Array.isArray(market.plugins) ? (market.plugins as Json[]) : [];
  if (!entries.length) problems.push(`${file} plugins: at least one entry`);
  const names = new Set<string>();
  for (const [i, entry] of entries.entries()) {
    const name = entry.name;
    if (typeof name !== 'string' || !kebab.test(name)) problems.push(`${file} plugins[${i}].name: lowercase kebab-case`);
    else if (names.has(name)) problems.push(`${file} plugins[${i}].name: ${name} is listed twice`);
    else names.add(name);
    const source = join(typeof pluginRoot === 'string' ? pluginRoot : '', typeof entry.source === 'string' ? entry.source : '');
    if (!source || source.startsWith('..') || source.startsWith('/')) {
      problems.push(`${file} plugins[${i}].source: a relative path inside the repo`);
      continue;
    }
    const manifest = join(repoRoot, source, '.cursor-plugin/plugin.json');
    if (!existsSync(manifest)) {
      problems.push(`${file} plugins[${i}]: ${source}/.cursor-plugin/plugin.json not found`);
      continue;
    }
    const pluginName = (JSON.parse(readFileSync(manifest, 'utf8')) as Json).name;
    if (pluginName !== name) problems.push(`${file} plugins[${i}].name: ${String(name)} but the plugin is named ${String(pluginName)}`);
  }
  return problems;
}

/** Writes the ChatGPT ZIP and returns its path. Run checkPackages first. */
export function buildChatGptZip(root = PLUGIN_ROOT, outDir = join(root, '..', 'dist')): string {
  const { version } = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')) as { version: string };
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `ziggs-chatgpt-${version}.zip`);
  rmSync(out, { force: true });
  // -X drops extra file attributes, so the same files make the same ZIP.
  execFileSync('zip', ['-X', '-q', out, ...ZIP_FILES], { cwd: root });
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = [...checkPackages(), ...checkMarketplace()];
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log(`✓ ${relative(process.cwd(), PLUGIN_ROOT)}: ChatGPT, Cursor and Claude packages check out, and the Cursor marketplace manifest finds them`);
  console.log(`  Add to Cursor: ${cursorInstallLink()}`);
  console.log(`  Install in VS Code: ${vscodeInstallLink()}`);
  if (process.argv.includes('--zip')) console.log(`  ChatGPT ZIP: ${relative(process.cwd(), buildChatGptZip())}`);
}
