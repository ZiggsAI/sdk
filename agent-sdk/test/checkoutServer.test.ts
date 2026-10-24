/** Exercise the real subprocess helpers without opening a socket. The harness
 * removes only listener startup, exports helpers, and unreferences the TTL. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const root = mkdtempSync(join(tmpdir(), 'checkout-server-test-'));
const repo = join(root, 'work/repo');
let box: any;
before(async () => {
  const prefix = join(root, 'confined.sh');
  writeFileSync(prefix, '#!/bin/sh\nexport CHECKOUT_TEST_CONFINED=yes\nexec "$@"\n', { mode: 0o700 });
  const previous = { ...process.env };
  process.env.BOX_SECRET = 'test-channel';
  process.env.BOX_WORK = join(root, 'work');
  process.env.BOX_EXEC_PREFIX = JSON.stringify([prefix]);
  let source = readFileSync(new URL('../src/checkout/box/server.ts', import.meta.url), 'utf8');
  source = source.slice(0, source.lastIndexOf("relay.listen(0, '127.0.0.1'"));
  source = source.replace('}, TTL_SECONDS * 1000);', '}, TTL_SECONDS * 1000).unref();');
  source += '\nexport {git, read, write, run, checkpoint, restore, withOperation, cancelChildren}; export function activeCount() { return activeChildren.size; }\nexport function initialize() { state = {repository:"acme/demo",baseBranch:"main",branch:"agent/test"}; }';
  const path = join(root, 'server.mjs');
  writeFileSync(path, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  box = await import(path);
  process.env = previous;
  mkdirSync(repo);
  assert.equal((await box.git(['init', '-q', '--initial-branch=main', repo])).ok, true);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  assert.equal((await box.git(['add', '-A'], { cwd: repo })).ok, true);
  assert.equal((await box.git(['commit', '-qm', 'base'], { cwd: repo })).ok, true);
  assert.equal((await box.git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repo })).ok, true);
  box.initialize();
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('checkout subprocess boundary and checkpoints', () => {
  it('confines Git filters as well as shell commands', async () => {
    writeFileSync(join(repo, '.gitattributes'), 'filter.txt filter=proof\n');
    writeFileSync(join(repo, 'filter.txt'), 'data\n');
    const marker = join(root, 'filter-proof');
    const configured = await box.git(['config', 'filter.proof.clean', `cat; printf %s "$CHECKOUT_TEST_CONFINED" > '${marker}'`], { cwd: repo });
    assert.equal(configured.ok, true);
    assert.equal((await box.git(['add', '-A'], { cwd: repo })).ok, true);
    assert.equal(readFileSync(marker, 'utf8'), 'yes');
  });
  it('preserves complete reads above the old 48 KiB cap and reports larger truncation', async () => {
    writeFileSync(join(repo, 'large.txt'), 'HEAD\n' + 'x'.repeat(70 * 1024) + '\nTAIL');
    const complete = await box.read({ path: 'large.txt' });
    assert.equal(complete.truncated, false);
    assert.equal(complete.content, readFileSync(join(repo, 'large.txt'), 'utf8'));
    writeFileSync(join(repo, 'large.txt'), 'HEAD\n' + 'x'.repeat(300 * 1024) + '\nTAIL');
    const partial = await box.read({ path: 'large.txt' });
    assert.equal(partial.truncated, true);
    assert.equal(partial.bytes, 300 * 1024 + 10);
    assert.ok(partial.content.startsWith('HEAD'));
    assert.equal(Buffer.byteLength(partial.content), 256 * 1024);
  });
  it('checkpoints staged, unstaged and untracked work without making a commit', async () => {
    await box.git(['config', '--unset', 'filter.proof.clean'], { cwd: repo });
    writeFileSync(join(repo, 'draft.txt'), 'first\n');
    await box.git(['add', 'draft.txt'], { cwd: repo });
    writeFileSync(join(repo, 'draft.txt'), 'second\n');
    writeFileSync(join(repo, 'untracked.txt'), 'private\n');
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'cache'), 'discardable');
    const head = (await box.git(['rev-parse', 'HEAD'], { cwd: repo })).stdout;
    writeFileSync(join(repo, '.git', 'index.lock'), 'interrupted git command');
    const archive = await box.checkpoint();
    await box.write({ path: 'draft.txt', content: 'lost' });
    await box.restore(archive);
    assert.equal((await box.read({ path: 'draft.txt' })).content, 'second\n');
    assert.equal((await box.git(['show', ':draft.txt'], { cwd: repo })).stdout, 'first\n');
    assert.equal((await box.read({ path: 'untracked.txt' })).content, 'private\n');
    assert.equal((await box.git(['rev-parse', 'HEAD'], { cwd: repo })).stdout, head);
    assert.equal(existsSync(join(repo, 'node_modules')), false);
    assert.equal(existsSync(join(repo, '.git', 'index.lock')), false);
    assert.match((await box.git(['config', 'remote.origin.url'], { cwd: repo })).stdout, /^http:\/\/127.0.0.1:/);
  });
  it('cancels the entire operation before a later subprocess can start', async () => {
    const operation = box.withOperation(async () => {
      await box.run({ command: 'sleep 30' });
      await box.write({ path: 'after-cancel.txt', content: 'must not happen' });
    });
    const rejected = assert.rejects(operation, /operation cancelled/);
    while (!box.activeCount()) await new Promise(resolve => setTimeout(resolve, 5));
    await box.cancelChildren();
    await rejected;
    assert.equal(existsSync(join(repo, 'after-cancel.txt')), false);
    assert.ok((await box.withOperation(() => box.checkpoint())).length > 0);
  });
  it('caps command output and terminates timed-out process groups', async () => {
    const large = await box.run({ command: `"${process.execPath}" -e 'process.stdout.write("x".repeat(2000000))'` });
    assert.equal(large.stdoutBytes, 2000000);
    assert.equal(large.stdout.length, 48 * 1024);
    assert.equal(large.stdoutTruncated, true);
    const slow = await box.run({ command: 'sleep 10', timeoutSeconds: 1 });
    assert.equal(slow.timedOut, true);
  });
});
