/**
 * Fails when internal material appears in this repo.
 *
 * Two scopes. The repo is public, so every tracked file is read by strangers
 * and gets the repo-wide rules. The four published packages ship `dist/`
 * (which carries source comments, and JSDoc into `.d.ts` IntelliSense), their
 * README, and for two of them `skills/` and `examples/`; those paths also get
 * the stricter surface rules. This check is here because a hand sweep does not
 * hold: the last one was undone by 47 new ticket refs within three days.
 *
 *   node scripts/check-published-surface.mjs          # fail on any hit
 *   node scripts/check-published-surface.mjs --list   # print hits, exit 0
 *
 * Internal rationale, runbooks and maintainer notes do not belong in this repo
 * at all; they live in the private repo.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Paths that end up in a published tarball, per package. */
const SURFACES = [
  'agent-sdk/src', 'agent-sdk/README.md', 'agent-sdk/CHANGELOG.md',
  'api-client/src', 'api-client/README.md', 'api-client/CHANGELOG.md',
  'ziggs-mcp/src', 'ziggs-mcp/README.md', 'ziggs-mcp/CHANGELOG.md', 'ziggs-mcp/examples', 'ziggs-mcp/skills',
  'ziggs-cli/src', 'ziggs-cli/skills',
];
// Generators under scripts/ are not scanned: they do not ship. A template that
// reintroduces internal text is caught in the `.gen.ts` it writes, which lives
// under a scanned src/ — at the moment it becomes shippable rather than before.

/** Every tracked file: nothing private, wherever it sits. */
const REPO_RULES = [
  { name: 'dogfood / incident framing', re: /\bdogfood\b|\bpostmortem\b|\bincident\b/i,
    fix: 'state the failure mode, not the run we found it on' },
  { name: 'backend repo path', re: /backend\s+src\/|\bSYNC:\s*backend\b|\.\.\/backend\/|\bbackend\/docs\//i,
    fix: 'say the server is authoritative; the server-side map stays private' },
  { name: 'maintainer doc pointer', re: /MAINTAINERS\.md|\brunbook\b/i,
    fix: 'maintainer notes and runbooks stay in the private repo' },
  // `ziggs[_]lab` rather than the bare token: the MCP tool-crossref test asserts
  // every ziggs_* string under scripts/ is a registered tool, and this is not one.
  { name: 'local path or private host', re: /\/Users\/|idoziggsai|ziggs[_]lab|MONGODB_DB/i,
    fix: 'no local machine paths or lab infrastructure in a public repo' },
  // Lowercase only: `DEBUG_AGENTPLUS` is a public env var name.
  { name: 'private repo', re: /\bagentplus\b/,
    fix: 'the private repo is not a place a reader can go; describe it from here' },
  { name: 'issue tracker link', re: /linear\.app\//i,
    fix: 'explain the change on its own terms' },
];

/** Paths that reach a tarball: the repo rules plus these. */
const SURFACE_RULES = [
  { name: 'ticket ref', re: /\bZIG-\d+\b/i,
    fix: 'explain the change on its own terms' },
  { name: 'internal codegen pointer', re: /npm run gen:protocol|edit src\/protocol\//i,
    fix: 'generated files say "do not edit by hand"; the workflow is not a consumer concern' },
  // "verified on <date>" is a support claim and stays; "measured/fired on
  // <date>" is us reporting our own run.
  { name: 'dated internal observation',
    re: /\b(measured|fired|observed|reproduced|happened|it ran|we ran)\b[a-z ,]*\b20\d\d-\d\d-\d\d\b/i,
    fix: 'keep the conclusion, drop the run it came from' },
];

/** Comments that are legitimately about a consumer-facing concept. */
const ALLOW = [
  /operator multiplex covers/,      // fleet-key error message, public concept
];

function walk(path, out) {
  const abs = join(root, path);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isDirectory()) {
    for (const entry of readdirSync(abs)) walk(join(path, entry), out);
  } else if (/\.(ts|mts|js|mjs|json|md|cursorrules)$|cursorrules$/.test(path)) {
    out.push(abs);
  }
  return out;
}

const TEXT = /\.(ts|mts|cts|js|mjs|cjs|json|md|ya?ml|txt|sh|toml|cursorrules)$|cursorrules$|^\.[a-z]+ignore$|(^|\/)\.env\.example$/;
const SELF = relative(root, fileURLToPath(import.meta.url));

const surfaceFiles = new Set(
  SURFACES.reduce((acc, s) => walk(s, acc), []).map((f) => relative(root, f)),
);
const repoFiles = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && f !== SELF && f !== 'package-lock.json' && TEXT.test(f.split('/').pop()))
  .filter((f) => existsSync(join(root, f)));

const hits = [];
for (const file of repoFiles) {
  if (/(^|\/)internal\//.test(file)) {
    hits.push({ file, line: 0, rule: { name: 'internal notes',
      fix: 'internal/ directories stay in the private repo' }, text: file });
  }
}
for (const file of new Set([...repoFiles, ...surfaceFiles])) {
  const rules = surfaceFiles.has(file) ? [...REPO_RULES, ...SURFACE_RULES] : REPO_RULES;
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (ALLOW.some((a) => a.test(line))) return;
    for (const rule of rules) {
      if (rule.re.test(line)) {
        hits.push({ file, line: i + 1, rule, text: line.trim().slice(0, 120) });
      }
    }
  });
}

if (!hits.length) {
  process.stdout.write(`repo clean (${repoFiles.length} tracked files, ${surfaceFiles.size} on the published surface)\n`);
  process.exit(0);
}

const listOnly = process.argv.includes('--list');
process.stderr.write(
  `internal material in the repo (${hits.length} hit${hits.length === 1 ? '' : 's'}):\n\n`,
);
for (const h of hits) {
  process.stderr.write(`  ${h.file}:${h.line}  [${h.rule.name}]\n    ${h.text}\n    → ${h.rule.fix}\n\n`);
}
process.exit(listOnly ? 0 : 1);
