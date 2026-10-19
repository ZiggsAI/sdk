import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantSession, assistantCredentials } from '../src/assistant.js';
import { readArguments } from '../src/commands/assistant.js';

test('a chat reuses its identity across commands and different windows stay distinct', () => {
  const a = assistantSession({ session: 'a'.repeat(127) + '1', app: 'Codex' }, {});
  const again = assistantSession({}, { ZIGGS_SESSION_ID: a.clientSessionId, ZIGGS_APP: 'Codex' });
  const b = assistantSession({ session: 'a'.repeat(127) + '2', app: 'Claude Code' }, {});
  assert.deepEqual(a, again);
  assert.notEqual(a.instanceId, b.instanceId);
  assert.equal(a.instanceId.length, 64);
  assert.throws(() => assistantSession({}, {}), /once per assistant chat/);
  assert.throws(() => assistantSession({ session: 'a'.repeat(129) }, {}), /128/);
  assert.throws(() => assistantSession({ session: 'x', app: 'x\nInjected: value' }, {}), /printable ASCII/);
  assert.throws(() => assistantSession({ session: 'x', workspaces: 'a,,b' }, {}), /nonempty/);
});

test('a connection credential needs no forced agent ID and keeps its session metadata', () => {
  const key = `e30.${Buffer.from(JSON.stringify({ type: 'operator', connectionClientId: 'connection', issuedVia: 'mcp_oauth' })).toString('base64url')}.signature`;
  const creds = assistantCredentials({ session: 'window', workspaces: 'org-a', app: 'Codex' }, { ZIGGS_OPERATOR_KEY: key });
  assert.equal(creds.agentId, '');
  assert.equal(creds.clientSessionId, 'window');
  assert.equal(creds.workspaceIds, 'org-a');
  assert.equal(creds.app, 'Codex');
});

test('JSON file input preserves literal shell syntax and rejects ambiguous or non-object input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ziggs-cli-args-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const args = { text: 'literal $(not-a-command) `backticks`\nnext line', idempotencyKey: 'stable-retry-id' };
  const path = join(dir, 'args.json');
  await writeFile(path, JSON.stringify(args));
  assert.deepEqual(await readArguments({ argsFile: path }), args);
  await assert.rejects(readArguments({ args: '[]' }), /JSON object/);
  await assert.rejects(readArguments({ args: 'null' }), /JSON object/);
  await assert.rejects(readArguments({ args: '{bad}' }), /valid JSON/);
  await assert.rejects(readArguments({ args: '{}', argsFile: path }), /not both/);
});

function cli(args: string[], input?: string, preload?: string) {
  return spawnSync(process.execPath, [...(preload ? ['--import', preload] : []), 'dist/index.js', ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', input, timeout: 10_000,
    env: { PATH: process.env.PATH, ZIGGS_OPERATOR_KEY: 'test-key', ZIGGS_AGENT_ID: 'test-agent', DOTENV_CONFIG_PATH: '/nonexistent/ziggs-test-env' },
  });
}

test('CLI prints only JSON and retains one session across separate processes', () => {
  const start = cli(['--json', 'session', 'new']);
  assert.equal(start.status, 0, start.stderr);
  const id = JSON.parse(start.stdout).sessionId;
  const args = ['--json', '--session', id, '--app', 'Codex', 'session', 'status'];
  const first = cli(args);
  const second = cli(args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(JSON.parse(first.stdout).clientSessionId, id);
  assert.doesNotMatch(first.stdout, /test-key/);
});

test('CLI refuses missing sessions, ignored legacy flags, schema mistakes, and writes in read-only mode', () => {
  for (const args of [
    ['tools'],
    ['--session', 'x', 'inbox'],
    ['--session', 'x', 'call', 'ziggs_chat_open', '--args', '{"typo":true}'],
    ['--session', 'x', 'call', 'ziggs_chat_open', '--read-only', '--args', '{"participantId":"someone"}'],
  ]) {
    const result = cli(['--json', ...args]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(typeof JSON.parse(result.stderr).error, 'string');
  }
});

test('CLI discovers task operations and validates stdin JSON before making requests', () => {
  const result = cli(['--json', '--session', 'x', 'tools', 'task']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).tools.some((t: {name: string}) => t.name === 'ziggs_task_set_result'));
  const invalid = cli(['--json', '--session', 'x', 'call', 'ziggs_inbox_ack', '--args-file', '-'], '{"madeUp":"cursor"}');
  assert.equal(invalid.status, 1);
  assert.match(JSON.parse(invalid.stderr).error, /did not run/);
});

test('CLI preserves backend errors and exits nonzero without printing credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ziggs-cli-refusal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preload = join(dir, 'fetch.mjs');
  await writeFile(preload, 'globalThis.fetch = async () => new Response(JSON.stringify({code:"TEST_REFUSAL",message:"Refused"}), {status:403});');
  const result = cli(['--json', '--session', 'x', 'call', 'ziggs_chat_open', '--args-file', '-'], '{"participantId":"person"}', preload);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).isError, true);
  assert.doesNotMatch(result.stdout + result.stderr, /test-key/);
});
