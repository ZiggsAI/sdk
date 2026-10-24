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
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { chownSync, existsSync, mkdirSync } from 'node:fs';
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
const CHECKPOINT_CAP = 64 * 1024 * 1024;
const TEMP = join(WORK, 'tmp');

mkdirSync(WORK, { recursive: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(join(WORK, '.npm'), { recursive: true });
mkdirSync(TEMP, { recursive: true });
// Do this before any repository-controlled command runs. Never recursively chown
// a tree that the box user can populate with symlinks.
if (RUN_AS) {
  for (const path of [WORK, HOME, TEMP, join(WORK, '.npm')]) {
    chownSync(path, Number(RUN_AS[1]), Number(RUN_AS[2]));
  }
}

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

/** Bounded as bytes arrive, rather than retaining an entire build log in RAM. */
function capture(cap: number, mode: 'head' | 'tail' = 'tail') {
  const chunks: Buffer[] = [];
  let kept = 0;
  let bytes = 0;
  return {
    append(chunk: Buffer) {
      bytes += chunk.length;
      if (mode === 'head') {
        const part = chunk.subarray(0, Math.max(0, cap - kept));
        if (part.length) { chunks.push(Buffer.from(part)); kept += part.length; }
      } else {
        chunks.push(Buffer.from(chunk.subarray(Math.max(0, chunk.length - cap))));
        kept += chunks[chunks.length - 1].length;
        while (kept > cap) {
          const first = chunks[0];
          const excess = kept - cap;
          if (first.length <= excess) { chunks.shift(); kept -= first.length; }
          else { chunks[0] = first.subarray(excess); kept -= excess; }
        }
      }
    },
    get data() { return Buffer.concat(chunks, kept); },
    get bytes() { return bytes; },
    get truncated() { return bytes > cap; },
  };
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
  TMPDIR: TEMP, TMP: TEMP, TEMP,
  ...(process.env.BOX_PROXY_URL ? {
    HTTP_PROXY: process.env.BOX_PROXY_URL, HTTPS_PROXY: process.env.BOX_PROXY_URL,
    http_proxy: process.env.BOX_PROXY_URL, https_proxy: process.env.BOX_PROXY_URL,
    npm_config_proxy: process.env.BOX_PROXY_URL, npm_config_https_proxy: process.env.BOX_PROXY_URL,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  } : {}),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
});

interface Spawned {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
  data?: Buffer;
}

let cancellationEpoch = 0;
const operationEpoch = new AsyncLocalStorage<number>();
function withOperation<T>(operation: () => Promise<T>): Promise<T> {
  return operationEpoch.run(cancellationEpoch, operation);
}

/** Every subprocess, including Git and archive extraction, has the same boundary. */
function runAsBoxUser(argv: string[], opts: {
  cwd?: string; stdin?: string | Buffer; timeoutMs?: number;
  outputCap?: number; outputMode?: 'head' | 'tail'; binary?: boolean;
} = {}): Promise<Spawned> {
  const epoch = operationEpoch.getStore();
  if (epoch !== undefined && epoch !== cancellationEpoch) {
    return Promise.reject(new Error('checkout operation cancelled'));
  }
  const started = Date.now();
  const prefix = EXEC_PREFIX.map((arg) => arg.replaceAll('__BOX_RELAY_PORT__', String(relayPort)));
  const full = [...prefix, ...argv];
  return new Promise((resolveRun) => {
    const child = spawn(full[0], full.slice(1), {
      cwd: opts.cwd ?? REPO,
      env: boxEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      ...(RUN_AS ? { uid: Number(RUN_AS[1]), gid: Number(RUN_AS[2]) } : {}),
    });
    if (child.pid) activeChildren.set(child.pid, child);
    const out = capture(opts.outputCap ?? OUTPUT_CAP, opts.outputMode);
    const err = capture(OUTPUT_CAP);
    let timedOut = false;
    const kill = () => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs ?? 600_000);
    child.stdout.on('data', (c: Buffer) => {
      out.append(c);
      if (opts.binary && out.truncated) kill();
    });
    child.stderr.on('data', (c: Buffer) => err.append(c));
    child.stdin.on('error', () => { /* child exited before consuming stdin */ });
    child.on('error', (e) => err.append(Buffer.from(e.message)));
    child.on('close', (code) => {
      clearTimeout(timer);
      // Background children must not mutate a snapshot after the command ends.
      kill();
      activeChildren.delete(child.pid!);
      resolveRun({
        exitCode: timedOut ? null : code,
        stdout: opts.binary ? '' : out.data.toString('utf8'),
        stderr: err.data.toString('utf8'),
        stdoutBytes: out.bytes,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        timedOut,
        durationMs: Date.now() - started,
        ...(opts.binary ? { data: out.data } : {}),
      });
    });
    child.stdin.end(opts.stdin);
  });
}

const activeChildren = new Map<number, ReturnType<typeof spawn>>();
function stopChildren(): void {
  for (const pid of activeChildren.keys()) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
async function cancelChildren(): Promise<void> {
  ++cancellationEpoch;
  const exits = [...activeChildren.values()].map(child => new Promise<void>(resolve => child.once('close', () => resolve())));
  stopChildren();
  await Promise.all(exits);
}
process.on('exit', stopChildren);
process.on('SIGTERM', () => { stopChildren(); process.exit(0); });

async function git(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<Spawned & { ok: boolean }> {
  const result = await runAsBoxUser(['git',
    '-c', `user.name=${AUTHOR_NAME}`, '-c', `user.email=${AUTHOR_EMAIL}`,
    '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd: WORK, ...opts });
  return { ...result, ok: result.exitCode === 0 && !result.timedOut };
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

  const head = await git(['rev-parse', 'HEAD'], { cwd: REPO });
  state = { repository, baseBranch, branch };
  return { repository, baseBranch, branch, head: head.stdout.trim(), resumed };
}

async function read(body: Record<string, unknown>): Promise<unknown> {
  if (!state) throw new Error('not set up');
  const abs = insideRepo(body['path']);
  const r = await runAsBoxUser(['cat', abs], { timeoutMs: 30_000, outputCap: READ_CAP, outputMode: 'head' });
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `cannot read ${String(body['path'])}`);
  const truncated = r.stdoutTruncated;
  return {
    path: String(body['path']),
    content: r.stdout,
    bytes: r.stdoutBytes,
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

async function checkpoint(): Promise<Buffer> {
  if (activeChildren.size) throw new Error('cannot checkpoint while a command is active');
  if (!state) throw new Error('not set up');
  const archive = await runAsBoxUser(['tar', '-czf', '-',
    '--exclude=./node_modules', '--exclude=*/node_modules', '--exclude=./.npm',
    '--exclude=./.git/index.lock', '--exclude=./.git/config.lock',
    '--exclude=./.git/packed-refs.lock', '--exclude=./.git/shallow.lock', '--exclude=./.git/refs/*.lock',
    '-C', REPO, '.'], { binary: true, outputCap: CHECKPOINT_CAP, timeoutMs: 120_000 });
  if (archive.exitCode !== 0 || archive.stdoutTruncated || !archive.data) {
    throw new Error(`checkpoint failed (maximum ${CHECKPOINT_CAP} bytes): ${archive.stderr}`);
  }
  return archive.data;
}

async function restore(bytes: Buffer): Promise<void> {
  if (!state) throw new Error('not set up');
  const saved = state;
  const clear = await runAsBoxUser(['rm', '-rf', REPO], { cwd: WORK });
  if (clear.exitCode !== 0) throw new Error('could not clear the fresh checkout');
  const extract = await runAsBoxUser([SHELL, '-c',
    'mkdir -p "$1" && tar -xzf - --no-same-owner --no-same-permissions -C "$1"', 'restore', REPO],
    { cwd: WORK, stdin: bytes, timeoutMs: 120_000 });
  if (extract.exitCode !== 0) throw new Error(`could not restore checkpoint: ${extract.stderr}`);
  const remote = `http://127.0.0.1:${relayPort}/${saved.repository}.git`;
  const reset = await git(['config', '--local', '--replace-all', 'remote.origin.url', remote], { cwd: REPO });
  if (!reset.ok) throw new Error('checkpoint contains no usable Git checkout');
}

function readBytes(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) { reject(new Error('checkpoint too large')); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
    if (url.pathname === '/checkpoint') {
      req.resume();
      const data = await withOperation(checkpoint);
      res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': data.length });
      res.end(data);
      return;
    }
    if (url.pathname === '/restore') {
      const bytes = await readBytes(req, CHECKPOINT_CAP);
      await withOperation(() => restore(bytes));
      json(res, 200, { ok: true });
      return;
    }
    const body = await readJson(req);
    switch (url.pathname) {
      case '/cancel': await cancelChildren(); json(res, 200, { ok: true }); return;
      case '/setup': json(res, 200, await withOperation(() => setup(body))); return;
      case '/read': json(res, 200, await withOperation(() => read(body))); return;
      case '/write': json(res, 200, await withOperation(() => write(body))); return;
      case '/run': json(res, 200, await withOperation(() => run(body))); return;
      case '/push': json(res, 200, await withOperation(() => push(body))); return;
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
