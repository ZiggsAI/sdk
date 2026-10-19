/**
 * Skill parser + validator — instructions-only, hard reject.
 *
 * A skill is a folder holding `SKILL.md` (frontmatter `name`/`description` +
 * markdown body) and, optionally, `references/*.md`. That is the whole accepted
 * surface. Anything else — `scripts/`, `assets/`, a stray `.json` — is rejected,
 * not warned about: a skill's body is installed into the system prompt and runs
 * with the agent's full authority, so "instructions-only" has to be a structural
 * property of what we accept, not a convention authors are trusted to follow.
 *
 * This module is deliberately free of Agent / LLM / MCP imports so it stays
 * unit-testable standalone (same rule as scripts/lib/mcp-provision.ts).
 */
import { createHash } from 'node:crypto';

/** One file in a skill package: repo-relative path → raw bytes. */
export interface SkillFile {
  /** Path relative to the skill folder, POSIX separators (`references/x.md`). */
  path: string;
  /** Raw file bytes. Hashed as-is; decoded as UTF-8 for content. */
  bytes: Buffer;
}

export interface SkillReference {
  /** Path relative to the skill folder (`references/style.md`). */
  path: string;
  /** Markdown body. */
  content: string;
}

export interface ParsedSkill {
  /** Frontmatter `name`. Required. */
  name: string;
  /**
   * Frontmatter `description`. Required. This is the buyer-facing store card —
   * the body never is.
   */
  description: string;
  /** SKILL.md body (everything after the frontmatter block). */
  body: string;
  /** `references/*.md`, sorted by path. */
  references: SkillReference[];
  /** sha256 pin over the sorted (path, bytes) of every accepted file. */
  hash: string;
}

/**
 * Combined content ceiling. The body is prompt-baked, so it rides EVERY LLM turn
 * of every wake — there is no progressive disclosure to amortize it. The cap is
 * therefore cost control, not a formality. Env-overridable for a genuinely large
 * skill someone has decided to pay for.
 */
export const SKILL_MAX_CHARS = Number(process.env.SKILL_MAX_CHARS ?? 64_000);

/** The one required file. */
const SKILL_FILE = 'SKILL.md';
/** The one optional subtree, markdown only. */
const REFERENCE_RE = /^references\/[^/]+\.md$/;

export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillValidationError';
  }
}

const reject = (msg: string): never => {
  throw new SkillValidationError(msg);
};

/**
 * Split a `---`-fenced YAML frontmatter block off the top of a markdown file.
 *
 * Scalar `key: value` pairs only — that is the entire frontmatter surface a
 * skill uses (`name`, `description`), so a general YAML parser would be a
 * dependency bought for nothing. Nested/sequence values are not silently
 * flattened: they land as raw text and fail the required-field checks below,
 * which is the loud outcome we want.
 */
export function splitFrontmatter(source: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  // Tolerate a UTF-8 BOM and leading blank lines before the opening fence.
  const text = source.replace(/^﻿/, '');
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return { frontmatter: {}, body: text.trim() };
  }
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    // Strip one layer of matching quotes; YAML's other quoting rules do not
    // apply to the two scalar keys a skill actually carries.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    frontmatter[kv[1]] = value;
  }
  return { frontmatter, body: text.slice(match[0].length).trim() };
}

/** sha256 over sorted (path, bytes) — the pin the factory verifies at boot. */
export function skillHash(files: SkillFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    // Length-delimit the path so `a/bc` + `d` can't hash the same as `a/b` + `cd`.
    hash.update(`${file.path.length}:${file.path}\n`);
    hash.update(file.bytes);
  }
  return hash.digest('hex');
}

/**
 * Validate a skill package and turn it into agent material.
 *
 * Every failure throws. There is no warn-and-continue path: a skill that is half
 * accepted is a skill whose author does not know what the agent is actually
 * running.
 */
export function parseSkill(files: SkillFile[], opts: { maxChars?: number } = {}): ParsedSkill {
  const maxChars = opts.maxChars ?? SKILL_MAX_CHARS;

  if (files.length === 0) reject('skill package is empty (expected SKILL.md)');

  // ── structure: SKILL.md + references/*.md, and nothing else ────────────────
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) reject(`duplicate file in skill package: ${file.path}`);
    seen.add(file.path);
    if (file.path === SKILL_FILE) continue;
    if (REFERENCE_RE.test(file.path)) continue;
    reject(
      `skill packages are instructions-only: ${file.path} is not allowed. ` +
        'Accepted layout is SKILL.md plus optional references/*.md — no scripts, no assets, no non-markdown files.',
    );
  }

  const skillFile = files.find((f) => f.path === SKILL_FILE);
  if (!skillFile) reject(`skill package has no ${SKILL_FILE}`);

  // ── frontmatter + body ─────────────────────────────────────────────────────
  const { frontmatter, body } = splitFrontmatter(skillFile!.bytes.toString('utf-8'));
  const name = frontmatter['name']?.trim();
  const description = frontmatter['description']?.trim();
  if (!name) reject(`${SKILL_FILE} frontmatter is missing a "name"`);
  if (!description) reject(`${SKILL_FILE} frontmatter is missing a "description"`);
  if (!body) reject(`${SKILL_FILE} has no body — frontmatter alone is not instructions`);

  const references: SkillReference[] = files
    .filter((f) => f.path !== SKILL_FILE)
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((f) => ({ path: f.path, content: f.bytes.toString('utf-8').trim() }));

  // ── size ───────────────────────────────────────────────────────────────────
  const totalChars = body.length + references.reduce((sum, r) => sum + r.content.length, 0);
  if (totalChars > maxChars) {
    reject(
      `skill content is ${totalChars} chars, over the ${maxChars} limit. ` +
        'The body rides every LLM turn, so this is a cost ceiling — trim it or raise SKILL_MAX_CHARS deliberately.',
    );
  }

  return { name: name!, description: description!, body, references, hash: skillHash(files) };
}

/** Catalog name for a reference path (`references/tone.md` → `tone`). */
export function skillReferenceName(path: string): string {
  return path.replace(/^references\//, '').replace(/\.md$/, '');
}

/** First prose line of a reference, for the on-prompt catalog. */
export function skillReferenceOneLine(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
  }
  return '(empty)';
}

/**
 * Assemble the skill's role prompt: the body, then a catalog of references.
 * Full reference text is fetched with `skill_read_reference` — it does not
 * ride every turn.
 *
 * This is only the ROLE block. The Ziggs protocol is prepended separately, by
 * the one place that builds a Claude-brain system prompt — a skill is never in a
 * position to sit above it.
 */
export function skillRolePrompt(skill: ParsedSkill): string {
  const parts = [skill.body];
  if (skill.references.length > 0) {
    parts.push(
      '## Skill references',
      'These files are not in this prompt. Call skill_read_reference with the name when you need one. Do not invent their contents.',
      skill.references
        .map(
          (ref) =>
            `- ${skillReferenceName(ref.path)}: ${skillReferenceOneLine(ref.content)}`,
        )
        .join('\n'),
    );
  }
  return parts.join('\n\n');
}
