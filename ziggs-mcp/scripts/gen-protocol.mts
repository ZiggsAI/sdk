/**
 * Protocol codegen. Regenerates every static surface from the shared
 * source (src/protocol/delegateProtocol.ts):
 *   - the managed block in SKILL.md (the references point at it rather
 *     than repeating it: ZIG-2116 step 5)
 *   - skills/ziggs/.cursorrules
 *
 * Runtime surfaces (the ziggs_inbox description, the server instructions string)
 * import the fragments directly and can't drift, so they aren't written here.
 *
 *   npm run gen:protocol         # write the surfaces
 *   npm run check:protocol       # exit 1 if any surface is stale (CI / test)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  injectProtocolBlock,
  renderCursorRules,
} from '../src/protocol/delegateProtocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const skillsDir = join(root, 'skills', 'ziggs');

interface Surface {
  path: string;
  render: (current: string) => string;
}

const surfaces: Surface[] = [
  {
    path: join(skillsDir, 'SKILL.md'),
    render: (current) => injectProtocolBlock(current),
  },
  {
    path: join(skillsDir, '.cursorrules'),
    render: () => renderCursorRules(),
  },
];

async function run(check: boolean): Promise<void> {
  const stale: string[] = [];
  for (const surface of surfaces) {
    const current = await readFile(surface.path, 'utf8').catch(() => '');
    const next = surface.render(current);
    if (current === next) continue;
    if (check) {
      stale.push(surface.path);
    } else {
      await writeFile(surface.path, next);
      process.stdout.write(`updated ${surface.path}\n`);
    }
  }
  if (check && stale.length) {
    process.stderr.write(
      `protocol surfaces are stale — run \`npm run gen:protocol\`:\n${stale
        .map((p) => `  - ${p}`)
        .join('\n')}\n`,
    );
    process.exit(1);
  }
  if (!check) process.stdout.write('protocol surfaces generated\n');
}

void run(process.argv.includes('--check'));
