import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  extractIntroductionToken,
  parseAbout,
} from '../src/commands/invite.js';
import {
  clearStoredKey,
  credentialsPath,
  normalizeApiBase,
  readStoredKey,
  writeStoredKey,
} from '../src/keyStore.js';

test('extractIntroductionToken accepts bare tokens and intro URLs', () => {
  assert.equal(extractIntroductionToken('zint_abc-DEF_12'), 'zint_abc-DEF_12');
  assert.equal(
    extractIntroductionToken('https://ziggsai.com/intro/zint_abc123'),
    'zint_abc123',
  );
  assert.equal(
    extractIntroductionToken('https://app.example/i/zint_xyz?x=1'),
    'zint_xyz',
  );
  assert.throws(() => extractIntroductionToken('https://ziggsai.com/app'), /zint_/);
  assert.throws(() => extractIntroductionToken(''), /token/);
});

test('parseAbout requires kind:id', () => {
  assert.deepEqual(parseAbout('chat:room_1'), { kind: 'chat', id: 'room_1' });
  assert.deepEqual(parseAbout('task:t1'), { kind: 'task', id: 't1' });
  assert.deepEqual(parseAbout('agreement:agr_1'), {
    kind: 'agreement',
    id: 'agr_1',
  });
  assert.throws(() => parseAbout('room_1'), /about/);
  assert.throws(() => parseAbout('space:x'), /about/);
});

test('key store is per API base and clearing returns to empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ziggs-cli-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.XDG_CONFIG_HOME = dir;

  const a = 'https://api.example.test';
  const b = 'https://api.example.test/';
  writeStoredKey(a, { operatorKey: 'key-a' });
  assert.equal(readStoredKey(b)?.operatorKey, 'key-a');
  assert.equal(normalizeApiBase(b), normalizeApiBase(a));
  writeStoredKey('https://lab.example.test', { operatorKey: 'key-lab' });
  assert.equal(readStoredKey(a)?.operatorKey, 'key-a');
  assert.equal(readStoredKey('https://lab.example.test')?.operatorKey, 'key-lab');

  const raw = JSON.parse(await readFile(credentialsPath(), 'utf8')) as Record<
    string,
    { operatorKey: string }
  >;
  assert.equal(raw[normalizeApiBase(a)].operatorKey, 'key-a');

  assert.equal(clearStoredKey(a), true);
  assert.equal(readStoredKey(a), undefined);
  assert.equal(readStoredKey('https://lab.example.test')?.operatorKey, 'key-lab');
  assert.equal(clearStoredKey('https://lab.example.test'), true);
  assert.equal(clearStoredKey(a), false);
});

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['dist/index.js', ...args], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: '/nonexistent/ziggs-test-env',
      ...env,
    },
  });
}

test('invite and join appear in help; join without a key refuses a bad token before boarding', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\binvite\b/);
  assert.match(help.stdout, /\bjoin\b/);

  const bad = cli(['join', 'not-a-token']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /zint_/);
});

test('join --forget-key clears only the stored slot for this API', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ziggs-cli-forget-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  });

  const api = 'https://api.forget.test';
  writeStoredKey(api, { operatorKey: 'k' });
  assert.equal(readStoredKey(api)?.operatorKey, 'k');

  const result = cli(['--json', 'join', '--forget-key'], {
    XDG_CONFIG_HOME: dir,
    ZIGGS_API_URL: api,
  });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout) as { cleared: boolean; apiBase: string };
  assert.equal(body.cleared, true);
  assert.equal(body.apiBase.replace(/\/+$/, ''), api);
  assert.equal(readStoredKey(api), undefined);
});
