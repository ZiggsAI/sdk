import type { CheckoutTarget } from './types.js';

/** `owner/name`, the way GitHub spells it. */
const REPOSITORY = /(?<![\w./-])([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?(?![\w/-])/g;

/** Words that look like `a/b` in prose but are never a repository. */
const NOT_REPOSITORIES = new Set(['and/or', 'yes/no', 'on/off', 'read/write', 'i/o', 'he/she', 'his/her', 'src/']);

const BASE_BRANCH = /\b(?:base|target|from|off|onto|against)\s+(?:the\s+)?branch\s+[`"']?([A-Za-z0-9._\/-]+)[`"']?|\bbranch\s*(?::|=)\s*[`"']?([A-Za-z0-9._\/-]+)[`"']?|\bbase\s*(?::|=)\s*[`"']?([A-Za-z0-9._\/-]+)[`"']?/i;

/**
 * What the task names. A task for a checkout agent names a repository as
 * `owner/name` (a GitHub URL counts) and may name a base branch; when it does
 * not, the repository's default branch is used. Nothing is guessed: a task
 * naming no repository is refused with that said, not pointed at a likely one.
 */
export function checkoutTargetFromText(text: string): CheckoutTarget | null {
  if (!text) return null;
  const fromUrl = /github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/\s)>,.]|$)/.exec(text);
  let owner: string | undefined;
  let name: string | undefined;
  if (fromUrl) {
    owner = fromUrl[1];
    name = fromUrl[2];
  } else {
    for (const match of text.matchAll(REPOSITORY)) {
      const candidate = `${match[1]}/${match[2]}`;
      if (NOT_REPOSITORIES.has(candidate.toLowerCase())) continue;
      // A path like `src/pages` reads as a repository to the regex; a repository
      // owner is an account, which never contains a dot, and the name never a
      // second slash. The first `owner/name` the task mentions wins.
      if (/^[a-z]+$/.test(match[1]) && /^(src|app|lib|pages|components|docs|test|tests|scripts|public|assets|dist|build|node_modules|packages|api|config|styles|utils|hooks|types)$/.test(match[1])) continue;
      owner = match[1];
      name = match[2];
      break;
    }
  }
  if (!owner || !name) return null;
  const base = BASE_BRANCH.exec(text);
  const baseBranch = (base?.[1] ?? base?.[2] ?? base?.[3] ?? null)?.replace(/[.,;:]+$/, "") || null;
  return {
    repository: `${owner}/${name}`,
    owner,
    name,
    baseBranch: baseBranch && baseBranch !== owner ? baseBranch : null,
  };
}

/** The task's own words: title first, then the description. */
export function checkoutTargetFromTask(task: { title?: string | null; description?: string | null }): CheckoutTarget | null {
  return (
    checkoutTargetFromText(String(task.title ?? '')) ??
    checkoutTargetFromText(String(task.description ?? ''))
  );
}

/** The branch a task's change lands on: one per task, never the default branch. */
export function checkoutBranchForTask(taskId: string): string {
  return `agent/${String(taskId).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
}
