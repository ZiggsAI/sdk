/**
 * ZIG-2257 — every tag publish must mint provenance on this public repo.
 * Auth may still use NPM_TOKEN until the package owner runs `npm trust`
 * (bypass-2FA granular tokens cannot call the trust API).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github/workflows/publish-npm-packages.yml');

describe('publish-npm-packages provenance (ZIG-2257)', () => {
  const src = readFileSync(WORKFLOW, 'utf8');
  const publishRuns = [...src.matchAll(/^\s+(?:run:\s*)?(npm publish.+|\(cd .+npm publish.+)$/gm)]
    .map((m) => m[1]);

  it('requests an OIDC id-token so provenance can be signed', () => {
    assert.match(src, /id-token:\s*write/);
  });

  it('keeps every one-line run free of ": ", which YAML reads as a mapping', () => {
    // A plain scalar with ": " made the whole file invalid, and every push
    // failed the workflow in 0s before any job ran.
    for (const m of src.matchAll(/^\s+run:\s*([^|>\n].*)$/gm))
      assert.equal(m[1].includes(': '), false, `unquoted ": " in run: ${m[1]}`);
  });

  it('publishes with --provenance on every package', () => {
    assert.ok(
      publishRuns.length >= 4,
      `expected four npm publish runs, got ${publishRuns.length}`,
    );
    for (const line of publishRuns) {
      assert.match(line, /--provenance/, `missing --provenance: ${line}`);
    }
  });

  it('sends a prerelease of api-client and agent-sdk to the next dist-tag, never latest', () => {
    for (const pkg of ['api-client', 'agent-sdk']) {
      const line = publishRuns.find((l) => l.includes(`@ziggs-ai/${pkg} `));
      assert.ok(line, `no publish run for ${pkg}`);
      assert.match(line, /--tag "\$tag"/);
      assert.ok(
        src.includes(`require('./${pkg}/package.json').version")" in *-*) tag=next`),
        `${pkg} prerelease does not select the next tag`,
      );
    }
  });

  it('does not claim the source repo is private (provenance needs public)', () => {
    assert.equal(
      /this repo is private|visibility:\s*private/i.test(src),
      false,
    );
  });
});
