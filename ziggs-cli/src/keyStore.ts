import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

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
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
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
