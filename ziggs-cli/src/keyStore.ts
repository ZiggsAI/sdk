import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { decodeOperatorKeyClaims } from '@ziggs-ai/api-client';

/**
 * Where `ziggs join` keeps the key it received. One entry per API base so a
 * lab URL never hands a production key (and the reverse). Environment
 * variables still win when set; deleting this file returns the CLI to
 * environment-only behaviour.
 */

export interface StoredKey {
  operatorKey: string;
  refreshToken?: string;
  clientId?: string;
  agentId?: string;
  storedAt: string;
}

type StoreFile = { [apiBase: string]: StoredKey };

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, 'ziggs');
  return join(homedir(), '.config', 'ziggs');
}

export function credentialsPath(): string {
  return join(configDir(), 'credentials.json');
}

/** Normalize so `https://api.x/` and `https://api.x` share one slot. */
export function normalizeApiBase(url: string): string {
  return url.replace(/\/+$/, '') || url;
}

function readStore(): StoreFile {
  const path = credentialsPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as StoreFile;
  } catch {
    return {};
  }
}

function writeStore(store: StoreFile): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Write beside it and rename, so a command reading at the same moment
  // sees the old key or the new one, never half a file.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function readStoredKey(apiBase: string): StoredKey | undefined {
  const entry = readStore()[normalizeApiBase(apiBase)];
  if (!entry?.operatorKey?.trim()) return undefined;
  return entry;
}

export function writeStoredKey(apiBase: string, key: Omit<StoredKey, 'storedAt'>): void {
  const store = readStore();
  store[normalizeApiBase(apiBase)] = {
    ...key,
    storedAt: new Date().toISOString(),
  };
  writeStore(store);
}

/** Drop the slot for this API base. Returns true when something was removed. */
export function clearStoredKey(apiBase: string): boolean {
  const store = readStore();
  const base = normalizeApiBase(apiBase);
  if (!(base in store)) return false;
  delete store[base];
  if (Object.keys(store).length === 0) {
    const path = credentialsPath();
    if (existsSync(path)) unlinkSync(path);
    return true;
  }
  writeStore(store);
  return true;
}

/** Renew this long before the key's own expiry, so no command starts on a key about to lapse. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;
/** A lock this old was left by a process that died; the next process takes over. */
const STALE_LOCK_MS = 30 * 1000;
/** How long a process waits for another one's renewal before giving up. */
const LOCK_WAIT_MS = 15 * 1000;

type Renewable = StoredKey & { refreshToken: string; clientId: string };

function expiresAtMs(operatorKey: string): number | null {
  const exp = decodeOperatorKeyClaims(operatorKey)?.exp;
  return typeof exp === 'number' ? exp * 1000 : null;
}

function needsRenewal(entry: StoredKey | undefined, now: number): entry is Renewable {
  if (!entry?.refreshToken || !entry.clientId) return false;
  const expiry = expiresAtMs(entry.operatorKey);
  return expiry !== null && expiry - now <= RENEW_BEFORE_MS;
}

/** True when the saved key for this API base carries an expiry that has passed. */
export function storedKeyExpired(apiBase: string, now: number = Date.now()): boolean {
  const entry = readStoredKey(apiBase);
  const expiry = entry ? expiresAtMs(entry.operatorKey) : null;
  return expiry !== null && expiry <= now;
}

/** Take the lock beside the key file. Returns its release, or null while another process holds it. */
function tryLock(retry = true): (() => void) | null {
  const path = `${credentialsPath()}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    try {
      if (!retry || Date.now() - statSync(path).mtimeMs < STALE_LOCK_MS) return null;
      unlinkSync(path);
    } catch {
      return null;
    }
    return tryLock(false);
  }
  return () => {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  };
}

export type RenewOutcome = 'not-needed' | 'renewed' | 'failed';

/**
 * Renew the key `ziggs join` saved for this API base before it expires, with
 * the refresh token saved beside it. A refresh token works once, and sending
 * a spent one ends the whole connection, so one process renews under a lock
 * while the others wait and read its result. A key from the environment is
 * never touched.
 */
export async function renewStoredKey(
  apiBase: string,
  deps: { fetch?: typeof fetch; now?: () => number; env?: NodeJS.ProcessEnv } = {},
): Promise<RenewOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const send = deps.fetch ?? fetch;
  if (env.ZIGGS_OPERATOR_KEY?.trim()) return 'not-needed';
  if (!needsRenewal(readStoredKey(apiBase), now())) return 'not-needed';

  const giveUpAt = Date.now() + LOCK_WAIT_MS;
  let unlock = tryLock();
  while (!unlock) {
    if (Date.now() > giveUpAt) return 'failed';
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!needsRenewal(readStoredKey(apiBase), now())) return 'not-needed';
    unlock = tryLock();
  }
  try {
    // Read again under the lock: the process that held it before may have renewed.
    const entry = readStoredKey(apiBase);
    if (!needsRenewal(entry, now())) return 'not-needed';
    const res = await send(`${normalizeApiBase(apiBase)}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: entry.refreshToken,
        client_id: entry.clientId,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return 'failed';
    const minted = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (!minted.access_token) return 'failed';
    writeStoredKey(apiBase, {
      operatorKey: minted.access_token,
      refreshToken: minted.refresh_token ?? entry.refreshToken,
      clientId: entry.clientId,
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
    });
    return 'renewed';
  } catch {
    return 'failed';
  } finally {
    unlock();
  }
}
