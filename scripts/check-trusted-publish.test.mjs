/**
 * ZIG-2257 — the tag publish workflow must use npm trusted publishing
 * (OIDC), not a long-lived npm auth secret. A regression here would put a
 * stealable secret back on every release.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github/workflows/publish-npm-packages.yml');

describe('publish-npm-packages trusted publishing (ZIG-2257)', () => {
  const src = readFileSync(WORKFLOW, 'utf8');
  const publishRuns = [...src.matchAll(/^\s+run:\s*(.+)$/gm)]
    .map((m) => m[1])
    .filter((line) => /\bnpm publish\b/.test(line));

  it('does not pass a stored npm token into publish', () => {
    assert.equal(
      /NODE_AUTH_TOKEN\s*:/.test(src),
      false,
      'publish jobs must not set NODE_AUTH_TOKEN',
    );
    assert.equal(
      /secrets\.NPM_TOKEN/.test(src),
      false,
      'publish jobs must not read secrets.NPM_TOKEN',
    );
  });

  it('requests the OIDC token and publishes with provenance', () => {
    assert.match(src, /id-token:\s*write/);
    assert.match(src, /npm install -g npm@11\.5\.1/);
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
