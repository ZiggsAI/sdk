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
  const publishRuns = [...src.matchAll(/^\s+run:\s*(.+)$/gm)]
    .map((m) => m[1])
    .filter((line) => /\bnpm publish\b/.test(line));

  it('requests an OIDC id-token so provenance can be signed', () => {
    assert.match(src, /id-token:\s*write/);
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

  it('does not claim the source repo is private (provenance needs public)', () => {
    assert.equal(
      /this repo is private|visibility:\s*private/i.test(src),
      false,
    );
  });
});
