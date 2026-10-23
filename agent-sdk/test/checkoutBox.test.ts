/**
 * The box, end to end, with a stand-in door: a bare repository served by
 * `git http-backend`, so a clone, an edit, a command and a push all happen
 * through the relay the way they do against the backend, without GitHub.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheckoutBoxClient, type GitDoorTarget } from '../src/checkout/boxClient.js';

const SERVER = fileURLToPath(new URL('../src/checkout/box/server.ts', import.meta.url));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** A door that serves one repository the way the backend's does, over CGI. */
function fakeDoor(root: string): Promise<{ server: Server; url: string; seen: Array<{ path: string; headers: Record<string, string> }> }> {
  const seen: Array<{ path: string; headers: Record<string, string> }> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://door');
    const m = /^\/connections\/([^/]+)\/git\/([^/]+)\/([^/]+)\/(.*)$/.exec(url.pathname);
    seen.push({ path: url.pathname + url.search, headers: req.headers as Record<string, string> });
    if (!m || req.headers.authorization !== 'Bearer op') {
      res.writeHead(403);
      res.end('refused');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const cgi = spawn('git', ['http-backend'], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: `/${m[2]}/${m[3]}.git/${m[4]}`,
          QUERY_STRING: url.search.replace(/^\?/, ''),
          REQUEST_METHOD: req.method ?? 'GET',
          CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
          CONTENT_LENGTH: String(body.length),
          REMOTE_USER: 'agent',
          REMOTE_ADDR: '127.0.0.1',
          ...(req.headers['git-protocol'] ? { HTTP_GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
          ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
        },
      });
      const out: Buffer[] = [];
      cgi.stdout.on('data', (c: Buffer) => out.push(c));
      cgi.on('close', () => {
        const all = Buffer.concat(out);
        const split = all.indexOf('\r\n\r\n');
        const headText = all.subarray(0, split).toString();
        const bodyBuf = all.subarray(split + 4);
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of headText.split('\r\n')) {
          const i = line.indexOf(':');
          if (i < 0) continue;
          const k = line.slice(0, i).trim().toLowerCase();
          const v = line.slice(i + 1).trim();
          if (k === 'status') status = Number(v.split(' ')[0]);
          else headers[k] = v;
        }
        res.writeHead(status, headers);
        res.end(bodyBuf);
      });
      cgi.stdin.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, seen });
    });
  });
}

function startBox(work: string, secret: string): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', SERVER], {
      env: {
        PATH: process.env.PATH,
        BOX_SECRET: secret,
        BOX_PORT: '0',
        BOX_BIND: '127.0.0.1',
        BOX_WORK: work,
        BOX_TTL_SECONDS: '120',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
      const m = /BOX_READY (\{.*\})/.exec(out);
      if (m) resolve({ child, url: `http://127.0.0.1:${(JSON.parse(m[1]) as { port: number }).port}` });
    });
    child.stderr.on('data', (c: Buffer) => process.stderr.write(`[box] ${c}`));
    child.on('exit', (code) => reject(new Error(`box exited early with ${code}: ${out}`)));
  });
}

describe('the checkout box', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ziggs-box-'));
  const root = join(tmp, 'repos');
  const bare = join(root, 'acme', 'demo.git');
  let door: Awaited<ReturnType<typeof fakeDoor>>;
  const boxes: ChildProcess[] = [];
  const SECRET = 'box-test-aaaaaaaa';

  before(async () => {
    mkdirSync(join(root, 'acme'), { recursive: true });
    git(tmp, 'init', '-q', '--bare', '--initial-branch=main', bare);
    git(bare, 'config', 'http.receivepack', 'true');
    const seed = join(tmp, 'seed');
    git(tmp, 'clone', '-q', bare, seed);
    writeFileSync(join(seed, 'README.md'), '# demo\n');
    mkdirSync(join(seed, 'src'));
    writeFileSync(join(seed, 'src', 'a.txt'), 'a\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    door = await fakeDoor(root);
  });

  after(async () => {
    for (const b of boxes) b.kill('SIGKILL');
    door.server.closeAllConnections();
    door.server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const doorTarget = (): GitDoorTarget => ({
    backendUrl: door.url,
    operatorKey: 'op',
    agentId: 'agent_1',
    laneId: 'chat_1',
    connectionId: 'con_1',
    grantId: 'cgr_1',
    taskId: 'task_1',
    repository: { owner: 'acme', name: 'demo' },
  });

  it('clones through the relay, works as asked, and pushes the task branch only', async () => {
    const work = join(tmp, 'box1');
    const box = await startBox(work, SECRET);
    boxes.push(box.child);
    const client = new CheckoutBoxClient({ url: box.url, secret: SECRET });
    await client.waitReady(10_000);

    // Nothing without the secret.
    const bad = await fetch(`${box.url}/health`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(bad.status, 401);
    await bad.text();

    client.startRelay(doorTarget());
    const ready = await client.setup({ repository: 'acme/demo', baseBranch: null, branch: 'agent/task_1' });
    assert.equal(ready.baseBranch, 'main');
    assert.equal(ready.branch, 'agent/task_1');
    assert.equal(ready.resumed, false);
    assert.match(ready.head, /^[0-9a-f]{40}$/);

    const readme = await client.read('README.md');
    assert.equal(readme.content, '# demo\n');
    await assert.rejects(client.read('../outside'), /outside the checkout/);

    await client.write('src/b.txt', 'b\n');
    const ls = await client.run('ls src && echo done');
    assert.equal(ls.exitCode, 0);
    assert.match(ls.stdout, /a\.txt\s+b\.txt\s+done/);

    // The commands run with the box's own environment, not the server's.
    const env = await client.run('env');
    assert.ok(!env.stdout.includes(SECRET), 'the channel secret is not in the command environment');

    const slow = await client.run('sleep 5', 1);
    assert.equal(slow.timedOut, true);

    const pushed = await client.push('Add b');
    assert.equal(pushed.pushed, true);
    assert.deepEqual(pushed.filesChanged, ['src/b.txt']);
    assert.ok(pushed.ran.some((r) => r.command === 'ls src && echo done' && r.exitCode === 0));
    assert.ok(pushed.ran.some((r) => r.command === 'sleep 5' && r.exitCode === null));

    assert.equal(git(bare, 'show', 'agent/task_1:src/b.txt'), 'b\n');
    assert.equal(git(bare, 'rev-parse', 'main'), git(bare, 'rev-parse', 'agent/task_1~1'));

    // Every git request reached the door under the host's grant, for this repository.
    assert.ok(door.seen.length >= 3, `expected a clone and a push through the door, saw ${door.seen.length}`);
    for (const s of door.seen) {
      assert.match(s.path, /^\/connections\/con_1\/git\/acme\/demo\//);
      assert.equal(s.headers['x-grant-id'], 'cgr_1');
      assert.equal(s.headers['x-agent-id'], 'agent_1');
      assert.equal(s.headers['x-ziggs-task-id'], 'task_1');
      assert.equal(s.headers['x-ziggs-lane'], 'chat_1');
    }
    assert.ok(door.seen.some((s) => s.path.endsWith('/git-receive-pack')));

    await client.stop();
    await client.stopRelay();
  });

  it('a later wake continues the branch the earlier one pushed', async () => {
    const work = join(tmp, 'box2');
    const box = await startBox(work, SECRET);
    boxes.push(box.child);
    const client = new CheckoutBoxClient({ url: box.url, secret: SECRET });
    await client.waitReady(10_000);
    client.startRelay(doorTarget());
    const ready = await client.setup({ repository: 'acme/demo', baseBranch: 'main', branch: 'agent/task_1' });
    assert.equal(ready.resumed, true);
    const b = await client.read('src/b.txt');
    assert.equal(b.content, 'b\n');
    const nothing = await client.push('no change');
    assert.equal(nothing.pushed, false);
    await client.stop();
    await client.stopRelay();
  });

  it('serves the task\'s repository and no other', async () => {
    const work = join(tmp, 'box3');
    const box = await startBox(work, SECRET);
    boxes.push(box.child);
    const client = new CheckoutBoxClient({ url: box.url, secret: SECRET });
    await client.waitReady(10_000);
    client.startRelay({ ...doorTarget(), repository: { owner: 'acme', name: 'other' } });
    await assert.rejects(
      client.setup({ repository: 'acme/demo', baseBranch: null, branch: 'agent/task_2' }),
      /clone of acme\/demo failed/,
    );
    await client.stop();
    await client.stopRelay();
  });
});
