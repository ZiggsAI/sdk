/**
 * Read a vendored skill folder off disk and validate it.
 *
 * Split from parseSkill so the validator itself stays pure (no fs) and testable
 * against in-memory packages. The walk is deliberately shallow-ish and total: it
 * collects EVERY file under the folder, including the ones the validator will
 * reject. Filtering here instead would defeat the point — a `scripts/` folder
 * has to be seen to be refused, and silently skipping it would import a skill
 * whose author believes their script runs.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseSkill, type ParsedSkill, type SkillFile } from './parseSkill.js';

/** Collect every file under `dir` as a skill-relative (path, bytes) pair. */
export async function readSkillFiles(dir: string): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        out.push({
          path: relative(dir, full).split(sep).join('/'),
          bytes: await readFile(full),
        });
      }
    }
  };
  await walk(dir);
  return out;
}

/**
 * Load + validate a skill folder.
 *
 * `expectedHash` is the pin. Skills never auto-update: if the folder's content
 * no longer hashes to what was recorded, that is a hard failure, not a refresh.
 * Re-importing changed content is an explicit act that produces a new version.
 */
export async function loadSkill(
  dir: string,
  opts: { expectedHash?: string; maxChars?: number } = {},
): Promise<ParsedSkill> {
  const files = await readSkillFiles(dir);
  const skill = parseSkill(files, opts.maxChars != null ? { maxChars: opts.maxChars } : {});
  assertSkillHash(skill, opts.expectedHash, dir);
  return skill;
}

/** Throw unless the parsed skill matches its recorded pin. No-op when unpinned. */
export function assertSkillHash(
  skill: ParsedSkill,
  expectedHash: string | undefined,
  source: string,
): void {
  if (!expectedHash || expectedHash === skill.hash) return;
  throw new Error(
    `skill "${skill.name}" at ${source} does not match its pinned hash ` +
      `(expected ${expectedHash}, found ${skill.hash}). Skills never auto-update — ` +
      're-import the skill deliberately and record the new hash.',
  );
}
