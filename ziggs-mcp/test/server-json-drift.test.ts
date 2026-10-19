import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readVersions, syncedServerJson } from '../scripts/sync-server-json.mts';

/**
 * ZIG-1224: server.json's version is what the MCP registry publishes and
 * package.json's is what npm publishes. They drifted for three releases and
 * every tag push failed with "cannot publish duplicate version" — invisibly,
 * because the registry is a listing nothing depends on at runtime and the
 * workflow only runs on a tag.
 *
 * This fails the moment a version bump forgets `npm run sync:server-json`,
 * which is the same guarantee `check:server-json` gives CI.
 */
describe('server.json tracks package.json (ZIG-1224)', () => {
  it('is in sync with the published package version', async () => {
    const { packageVersion, serverJson } = await readVersions();
    assert.equal(
      syncedServerJson(serverJson, packageVersion),
      serverJson,
      'server.json is stale — run `npm run sync:server-json`',
    );
  });

  it('moves the package entry too, not just the top-level version', () => {
    const stale = JSON.stringify(
      {
        name: 'io.github.ZiggsAI/ziggs',
        version: '0.9.0',
        packages: [{ registryType: 'npm', identifier: '@ziggs-ai/ziggs-mcp', version: '0.9.0' }],
      },
      null,
      2,
    );
    const synced = JSON.parse(syncedServerJson(stale, '1.2.3')) as {
      version: string;
      packages: Array<{ version: string; identifier: string }>;
    };
    assert.equal(synced.version, '1.2.3');
    // The registry resolves the npm tarball from this entry, so leaving it
    // behind would point the listing at an old package under a new version.
    assert.equal(synced.packages[0]?.version, '1.2.3');
    assert.equal(synced.packages[0]?.identifier, '@ziggs-ai/ziggs-mcp');
  });
});
