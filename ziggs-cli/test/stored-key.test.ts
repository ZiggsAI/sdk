import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  credentialsPath,
  readStoredKey,
  renewStoredKey,
  writeStoredKey,
} from '../src/keyStore.js';

// Nothing listens here, so a request to it fails at once.
const API = 'http://127.0.0.1:9';

function key(expSeconds: number): string {
  const claims = Buffer.from(JSON.stringify({ type: 'operator', exp: expSeconds })).toString('base64url');
  return `e30.${claims}.signature`;
}

async function keyDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ziggs-cli-stored-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}

function cli(args: string[], dir: string) {
  return spawnSync(process.execPath, ['dist/index.js', ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: dir, ZIGGS_API_URL: API, DOTENV_CONFIG_PATH: '/nonexistent/ziggs-test-env' },
  });
}

test('tools and call use the key ziggs join saved when the environment has none', async t => {
  const dir = await keyDir(t);
  const before = cli(['--json', '--session', 'x', 'tools', 'task'], dir);
  assert.equal(before.status, 1);
  assert.match(JSON.parse(before.stderr).error, /ZIGGS_OPERATOR_KEY is required/);

  writeStoredKey(API, { operatorKey: 'saved-key', agentId: 'saved-agent' });
  const after = cli(['--json', '--session', 'x', 'tools', 'task'], dir);
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /ziggs_task_get/);
  assert.doesNotMatch(after.stdout, /saved-key/);
});

test('a saved key near expiry is renewed once, and the new refresh token replaces the spent one', async t => {
  await keyDir(t);
  const now = Date.now();
  writeStoredKey(API, { operatorKey: key(now / 1000 + 60), refreshToken: 'oar_old', clientId: 'mcp_client', agentId: 'agent' });
  const fresh = key(now / 1000 + 3600);
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ access_token: fresh, refresh_token: 'oar_new' }), { status: 200 });
  }) as typeof globalThis.fetch;

  assert.equal(await renewStoredKey(API, { fetch, env: {} }), 'renewed');
  assert.deepEqual(calls, [{
    url: `${API}/oauth/token`,
    body: { grant_type: 'refresh_token', refresh_token: 'oar_old', client_id: 'mcp_client' },
  }]);
  const stored = readStoredKey(API);
  assert.equal(stored?.operatorKey, fresh);
  assert.equal(stored?.refreshToken, 'oar_new');
  assert.equal(stored?.clientId, 'mcp_client');
  assert.equal(stored?.agentId, 'agent');

  assert.equal(await renewStoredKey(API, { fetch, env: {} }), 'not-needed');
  assert.equal(calls.length, 1);
});

test('nothing is renewed for an environment key, a key with time left, or a key with no refresh token', async t => {
  await keyDir(t);
  const fetch = (async () => {
    throw new Error('no request expected');
  }) as typeof globalThis.fetch;
  const soon = key(Date.now() / 1000 + 60);

  writeStoredKey(API, { operatorKey: soon, refreshToken: 'oar_1', clientId: 'mcp_client' });
  assert.equal(await renewStoredKey(API, { fetch, env: { ZIGGS_OPERATOR_KEY: 'env-key' } }), 'not-needed');

  writeStoredKey(API, { operatorKey: key(Date.now() / 1000 + 3600), refreshToken: 'oar_1', clientId: 'mcp_client' });
  assert.equal(await renewStoredKey(API, { fetch, env: {} }), 'not-needed');

  writeStoredKey(API, { operatorKey: soon });
  assert.equal(await renewStoredKey(API, { fetch, env: {} }), 'not-needed');
});

test('a command waiting on the lock takes the key another command renewed instead of spending the token again', async t => {
  await keyDir(t);
  writeStoredKey(API, { operatorKey: key(Date.now() / 1000 + 60), refreshToken: 'oar_old', clientId: 'mcp_client' });
  const lock = `${credentialsPath()}.lock`;
  await writeFile(lock, '');
  const fresh = key(Date.now() / 1000 + 3600);
  setTimeout(() => {
    writeStoredKey(API, { operatorKey: fresh, refreshToken: 'oar_new', clientId: 'mcp_client' });
    void rm(lock, { force: true });
  }, 300);
  const fetch = (async () => {
    throw new Error('the token must not be spent twice');
  }) as typeof globalThis.fetch;

  assert.equal(await renewStoredKey(API, { fetch, env: {} }), 'not-needed');
  assert.equal(readStoredKey(API)?.operatorKey, fresh);
});

test('an expired saved key that cannot be renewed stops the command with what to do', async t => {
  const dir = await keyDir(t);
  writeStoredKey(API, { operatorKey: key(Date.now() / 1000 - 60), refreshToken: 'oar_old', clientId: 'mcp_client' });
  const result = cli(['--json', '--session', 'x', 'tools'], dir);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stderr).error, /could not be renewed.*ziggs join/);

  const join = cli(['--json', 'join', '--forget-key'], dir);
  assert.equal(join.status, 0, join.stderr);
  assert.equal(JSON.parse(join.stdout).cleared, true);
});
