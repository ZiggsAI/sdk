/**
 * The box: one throwaway unit per checkout wake.
 *
 * Runs inside the box (a container the host started, or a confined local
 * process in a lab) and nowhere else. It depends on nothing but Node and git,
 * so it can run from the stock Node image: the host registers it as the task's
 * command and starts the task with a per-box secret.
 *
 * What it exposes, on the channel port, to a caller holding the secret:
 *   POST /setup   clone the task's repository and check out the task's branch
 *   POST /read    one file, as the box user
 *   POST /write   one whole file, as the box user
 *   POST /run     one shell command in the checkout, as the box user, with caps
 *   POST /push    commit everything and push the task's branch
 *   GET  /relay/next, POST /relay/:id   the git relay (below)
 *   POST /stop    exit
 *
 * The box holds no credential. Its git remote is a relay on the loopback
 * interface, served here: every git request is queued, the host long-polls
 * it, performs it against the backend's git door under the hire's grant, and
 * posts the answer back. Nothing in the box can reach the host's services.
 *
 * Commands run as an unprivileged user when BOX_RUN_AS is set (a container),
 * or through BOX_EXEC_PREFIX (a confined local process), never as this server.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const SECRET = process.env.BOX_SECRET ?? '';
if (!SECRET) {
  console.error('BOX_SECRET is required');
  process.exit(2);
}
const PORT = Number(process.env.BOX_PORT ?? 7777);
const BIND = process.env.BOX_BIND ?? '0.0.0.0';
const WORK = resolve(process.env.BOX_WORK ?? '/work');
const REPO = join(WORK, 'repo');
const HOME = process.env.BOX_HOME ?? join(WORK, 'home');
const TTL_SECONDS = Math.max(60, Number(process.env.BOX_TTL_SECONDS ?? 3600));
const RUN_AS = /^(\d+):(\d+)$/.exec(process.env.BOX_RUN_AS ?? '');
const EXEC_PREFIX: string[] = (() => {
  try { return JSON.parse(process.env.BOX_EXEC_PREFIX ?? '[]'); } catch { return []; }
})();
const AUTHOR_NAME = process.env.BOX_GIT_AUTHOR_NAME ?? 'Ziggs agent';
const AUTHOR_EMAIL = process.env.BOX_GIT_AUTHOR_EMAIL ?? 'agents@ziggsai.com';
const SHELL = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
const STARTED_AT = Date.now();
const OUTPUT_CAP = 48 * 1024;
const READ_CAP = 256 * 1024;

mkdirSync(WORK, { recursive: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(join(WORK, '.npm'), { recursive: true });

/** Hard time cap: the box ends with or without the host. */
setTimeout(() => {
  console.error(`box: time cap of ${TTL_SECONDS}s reached, exiting`);
  process.exit(3);
}, TTL_SECONDS * 1000);

let state: { repository: string; baseBranch: string; branch: string } | null = null;
const ran: Array<{ command: string; exitCode: number | null }> = [];

// ── helpers ────────────────────────────────────────────────────────────────

function authorized(req: IncomingMessage): boolean {
  const header = String(req.headers['authorization'] ?? '');
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(SECRET);
  return given.length === want.length && timingSafeEqual(given, want);
}

function readJson(req: IncomingMessage, cap = 8 * 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        reject(new Error(`body over ${cap} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolveBody(text ? JSON.parse(text) : {}); } catch (err) { reject(err as Error); }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function tail(buf: Buffer[], cap: number): { text: string; truncated: boolean } {
  const all = Buffer.concat(buf);
  if (all.length <= cap) return { text: all.toString('utf8'), truncated: false };
  return { text: all.subarray(all.length - cap).toString('utf8'), truncated: true };
}

/** A path inside the checkout, or an error. */
function insideRepo(p: unknown): string {
  const rel = String(p ?? '').trim();
  if (!rel) throw new Error('path is required');
  const abs = resolve(REPO, rel);
  if (abs !== REPO && !abs.startsWith(REPO + sep)) throw new Error(`path ${rel} is outside the checkout`);
  return abs;
}

const boxEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME,
  LANG: 'C.UTF-8',
  TERM: 'dumb',
  CI: '1',
  npm_config_cache: join(WORK, '.npm'),
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
});

interface Spawned {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Run argv as the box user, with the output and time caps. */
function runAsBoxUser(argv: string[], opts: { cwd?: string; stdin?: string; timeoutMs?: number } = {}): Promise<Spawned> {
  const started = Date.now();
  const full = [...EXEC_PREFIX, ...argv];
  return new Promise((resolveRun) => {
    const child = spawn(full[0], full.slice(1), {
      cwd: opts.cwd ?? REPO,
      env: boxEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      ...(RUN_AS ? { uid: Number(RUN_AS[1]), gid: Number(RUN_AS[2]) } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, opts.timeoutMs ?? 600_000);
    child.stdout.on('data', (c: Buffer) => { out.push(c); });
    child.stderr.on('data', (c: Buffer) => { err.push(c); });
    child.on('error', (e) => { err.push(Buffer.from(String(e.message))); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({
        exitCode: timedOut ? null : code,
        stdout: tail(out, OUTPUT_CAP).text,
        stderr: tail(err, OUTPUT_CAP).text,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/** git, as this server (the clone and the push), never as the box user. */
async function git(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<Spawned & { ok: boolean }> {
  const started = Date.now();
  return new Promise((resolveGit) => {
    const child = spawn('git', [
      '-c', `user.name=${AUTHOR_NAME}`,
      '-c', `user.email=${AUTHOR_EMAIL}`,
      '-c', 'safe.directory=*',
      '-c', 'credential.helper=',
      '-c', 'core.hooksPath=/dev/null',
      ...args,
    ], {
      cwd: opts.cwd ?? WORK,
      env: boxEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs ?? 600_000);
    child.stdout.on('data', (c: Buffer) => { out.push(c); });
    child.stderr.on('data', (c: Buffer) => { err.push(c); });
    child.on('error', (e) => { err.push(Buffer.from(String(e.message))); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveGit({
        ok: code === 0 && !timedOut,
        exitCode: timedOut ? null : code,
        stdout: tail(out, OUTPUT_CAP).text,
        stderr: tail(err, OUTPUT_CAP).text,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

// ── the git relay ──────────────────────────────────────────────────────────

interface Queued { id: string; req: IncomingMessage; res: ServerResponse; }
const queued: Queued[] = [];
const inflight = new Map<string, Queued>();
let waiter: ((q: Queued | null) => void) | null = null;
let relayPort = 0;
let relaySeq = 0;

const relay = createServer((req, res) => {
  const item: Queued = { id: String(++relaySeq), req, res };
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(item);
  } else {
    queued.push(item);
  }
});

function nextQueued(timeoutMs: number): Promise<Queued | null> {
  const ready = queued.shift();
  if (ready) return Promise.resolve(ready);
  return new Promise((resolveNext) => {
    const timer = setTimeout(() => {
      if (waiter === take) waiter = null;
      resolveNext(null);
    }, timeoutMs);
    const take = (q: Queued | null) => {
      clearTimeout(timer);
      resolveNext(q);
    };
    waiter = take;
  });
}

async function relayNext(res: ServerResponse): Promise<void> {
  const item = await nextQueued(20_000);
  if (!item) {
    res.writeHead(204);
    res.end();
    return;
  }
  inflight.set(item.id, item);
  const headers: Record<string, string> = {};
  for (const name of ['content-type', 'content-encoding', 'accept', 'git-protocol']) {
    const v = item.req.headers[name];
    if (typeof v === 'string') headers[name] = v;
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'x-relay-id': item.id,
    'x-relay-method': item.req.method ?? 'GET',
    'x-relay-path': item.req.url ?? '/',
    'x-relay-headers': JSON.stringify(headers),
  });
  item.req.pipe(res);
  item.req.on('error', () => res.end());
}

function relayReply(id: string, req: IncomingMessage, res: ServerResponse): void {
  const item = inflight.get(id);
  if (!item) {
    json(res, 404, { error: `no relayed request ${id}` });
    req.resume();
    return;
  }
  inflight.delete(id);
  let headers: Record<string, string> = {};
  try { headers = JSON.parse(String(req.headers['x-relay-headers'] ?? '{}')); } catch { headers = {}; }
  const status = Number(req.headers['x-relay-status'] ?? 502);
  item.res.writeHead(Number.isFinite(status) ? status : 502, headers);
  req.pipe(item.res);
  req.on('end', () => json(res, 200, { ok: true }));
  req.on('error', () => { item.res.end(); json(res, 500, { error: 'reply stream failed' }); });
}

// ── routes ─────────────────────────────────────────────────────────────────

async function setup(body: Record<string, unknown>): Promise<unknown> {
  if (state) throw new Error('already set up');
  const repository = String(body['repository'] ?? '');
  const [owner, name] = repository.split('/');
  if (!owner || !name) throw new Error('repository must be owner/name');
  const requestedBase = body['baseBranch'] ? String(body['baseBranch']) : null;
  const branch = String(body['branch'] ?? '');
  if (!/^agent\/[a-z0-9._-]+$/.test(branch)) throw new Error('branch must be agent/<task id>');
  const remote = `http://127.0.0.1:${relayPort}/${owner}/${name}.git`;

  const clone = await git(
    ['clone', '--no-tags', '--single-branch', ...(requestedBase ? ['--branch', requestedBase] : []), remote, REPO],
    { timeoutMs: 10 * 60_000 },
  );
  if (!clone.ok) throw new Error(`clone of ${repository}${requestedBase ? ` at ${requestedBase}` : ''} failed: ${clone.stderr.trim() || clone.stdout.trim()}`);

  let baseBranch = requestedBase;
  if (!baseBranch) {
    const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: REPO });
    baseBranch = head.ok ? head.stdout.trim().replace(/^origin\//, '') : null;
    if (!baseBranch) {
      const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO });
      baseBranch = current.ok ? current.stdout.trim() : null;
    }
    if (!baseBranch) throw new Error('could not tell the default branch');
  }

  // An earlier wake may have pushed this task's branch already: continue it.
  const fetched = await git(['fetch', '--no-tags', 'origin', `${branch}:refs/remotes/origin/${branch}`], { cwd: REPO, timeoutMs: 5 * 60_000 });
  const resumed = fetched.ok;
  const checkout = resumed
    ? await git(['checkout', '-B', branch, `origin/${branch}`], { cwd: REPO })
    : await git(['checkout', '-b', branch], { cwd: REPO });
  if (!checkout.ok) throw new Error(`checkout of ${branch} failed: ${checkout.stderr.trim()}`);

  if (RUN_AS) {
    const chown = await new Promise<number | null>((r) => {
      const c = spawn('chown', ['-R', `${RUN_AS[1]}:${RUN_AS[2]}`, REPO, HOME, join(WORK, '.npm')], { stdio: 'ignore' });
      c.on('close', (code) => r(code));
      c.on('error', () => r(1));
    });
    if (chown !== 0) throw new Error('could not hand the checkout to the box user');
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: REPO });
  state = { repository, baseBranch, branch };
  return { repository, baseBranch, branch, head: head.stdout.trim(), resumed };
}

async function read(body: Record<string, unknown>): Promise<unknown> {
  if (!state) throw new Error('not set up');
  const abs = insideRepo(body['path']);
  const r = await runAsBoxUser(['cat', abs], { timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `cannot read ${String(body['path'])}`);
  const truncated = Buffer.byteLength(r.stdout) > READ_CAP;
  return {
    path: String(body['path']),
    content: truncated ? r.stdout.slice(0, READ_CAP) : r.stdout,
    bytes: Buffer.byteLength(r.stdout),
    truncated,
  };
}

async function write(body: Record<string, unknown>): Promise<unknown> {
  if (!state) throw new Error('not set up');
  const abs = insideRepo(body['path']);
  const content = String(body['content'] ?? '');
  const r = await runAsBoxUser(
    [SHELL, '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'write', abs],
    { stdin: content, timeoutMs: 30_000 },
  );
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `cannot write ${String(body['path'])}`);
  return { path: String(body['path']), bytes: Buffer.byteLength(content) };
}

async function run(body: Record<string, unknown>): Promise<unknown> {
  if (!state) throw new Error('not set up');
  const command = String(body['command'] ?? '').trim();
  if (!command) throw new Error('command is required');
  const remainingMs = TTL_SECONDS * 1000 - (Date.now() - STARTED_AT) - 5_000;
  const askedMs = Math.max(1, Math.min(Number(body['timeoutSeconds'] ?? 600), 1800)) * 1000;
  const r = await runAsBoxUser([SHELL, '-c', command], { timeoutMs: Math.max(1_000, Math.min(askedMs, remainingMs)) });
  ran.push({ command, exitCode: r.exitCode });
  return { command, ...r };
}

async function push(body: Record<string, unknown>): Promise<unknown> {
  if (!state) throw new Error('not set up');
  const message = String(body['message'] ?? '').trim() || `Change for task ${state.branch.replace(/^agent\//, '')}`;
  const add = await git(['add', '-A'], { cwd: REPO });
  if (!add.ok) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const staged = await git(['diff', '--cached', '--quiet'], { cwd: REPO });
  let commit: string | null = null;
  if (!staged.ok) {
    const c = await git(['commit', '-q', '-m', message], { cwd: REPO });
    if (!c.ok) throw new Error(`git commit failed: ${c.stderr.trim() || c.stdout.trim()}`);
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: REPO });
  commit = head.ok ? head.stdout.trim() : null;
  const changed = await git(['diff', '--name-only', `origin/${state.baseBranch}...HEAD`], { cwd: REPO });
  const filesChanged = changed.ok ? changed.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  if (!filesChanged.length) {
    return { branch: state.branch, commit, filesChanged, pushed: false, ran, note: 'nothing changed against the base branch; nothing pushed' };
  }
  // A branch an earlier wake pushed, with nothing new on it, needs no push.
  const remote = await git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${state.branch}`], { cwd: REPO });
  if (staged.ok && remote.ok && remote.stdout.trim() === commit) {
    return { branch: state.branch, commit, filesChanged, pushed: false, ran, note: 'nothing new since the branch was last pushed' };
  }
  const pushed = await git(['push', '-q', 'origin', `HEAD:refs/heads/${state.branch}`], { cwd: REPO, timeoutMs: 10 * 60_000 });
  if (!pushed.ok) throw new Error(`git push failed: ${pushed.stderr.trim() || pushed.stdout.trim()}`);
  return { branch: state.branch, commit, filesChanged, pushed: true, ran };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://box');
  if (!authorized(req)) {
    req.resume();
    json(res, 401, { error: 'box: missing or wrong secret' });
    return;
  }
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, ready: !!state, uptimeMs: Date.now() - STARTED_AT, ttlSeconds: TTL_SECONDS });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/relay/next') {
      await relayNext(res);
      return;
    }
    const reply = /^\/relay\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'POST' && reply) {
      relayReply(decodeURIComponent(reply[1]), req, res);
      return;
    }
    if (req.method !== 'POST') {
      json(res, 404, { error: 'not found' });
      return;
    }
    const body = await readJson(req);
    switch (url.pathname) {
      case '/setup': json(res, 200, await setup(body)); return;
      case '/read': json(res, 200, await read(body)); return;
      case '/write': json(res, 200, await write(body)); return;
      case '/run': json(res, 200, await run(body)); return;
      case '/push': json(res, 200, await push(body)); return;
      case '/stop':
        json(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 100);
        return;
      default:
        json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

relay.listen(0, '127.0.0.1', () => {
  relayPort = (relay.address() as { port: number }).port;
  server.listen(PORT, BIND, () => {
    const port = (server.address() as { port: number }).port;
    console.log(`BOX_READY ${JSON.stringify({ port, relayPort })}`);
  });
});
