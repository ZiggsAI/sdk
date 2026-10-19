import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  changelogHasVersion,
  missingChangelogHeadings,
  promoteUnreleased,
  writeChangelogHeadings,
} from './changelog-release.mjs';

test('files Unreleased notes under the package version', () => {
  const next = promoteUnreleased(
    '# Changelog\n\n## Unreleased\n\n- Callers can cancel an idle poll.\n\n## 0.10.0\n\n- Older.\n',
    '0.37.14',
  );
  assert.match(next, /^## Unreleased\n\n## 0\.37\.14\n\n- Callers can cancel an idle poll\.\n\n## 0\.10\.0/m);
  assert.equal(promoteUnreleased(next, '0.37.14'), next);
});

test('an empty Unreleased section still gets a heading', () => {
  const next = promoteUnreleased('# Changelog\n\n## Unreleased\n\n## 0.10.0\n\n- Older.\n', '0.37.14');
  assert.match(next, /## 0\.37\.14\n\n- No notes were written for this version\.\n\n## 0\.10\.0/);
});

test('the published packages name their current version', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(missingChangelogHeadings(root), []);
});

test('a version bump without a heading fails the check, and --write makes it pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'changelog-'));
  mkdirSync(join(root, 'api-client'));
  writeFileSync(join(root, 'api-client', 'package.json'), JSON.stringify({ version: '0.37.15' }));
  writeFileSync(
    join(root, 'api-client', 'CHANGELOG.md'),
    '# Changelog\n\n## Unreleased\n\n- The new call.\n\n## 0.37.14\n\n- Previous.\n',
  );
  assert.deepEqual(missingChangelogHeadings(root, ['api-client']), [
    { name: 'api-client', version: '0.37.15' },
  ]);
  assert.deepEqual(writeChangelogHeadings(root, ['api-client']), [
    { name: 'api-client', version: '0.37.15' },
  ]);
  assert.deepEqual(missingChangelogHeadings(root, ['api-client']), []);
  const filed = readFileSync(join(root, 'api-client', 'CHANGELOG.md'), 'utf8');
  assert.match(filed, /## 0\.37\.15\n\n- The new call\./);
  assert.equal(changelogHasVersion(filed, '0.37.14'), true);
});
