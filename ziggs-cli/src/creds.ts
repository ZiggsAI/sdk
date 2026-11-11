import 'dotenv/config';
import { createRequire } from 'node:module';
import {
  cliHostIdentity,
  configureApiClient,
  getBackendUrl,
  resolveDelegateCreds,
  resolveDelegateHttpUrl,
  type Creds,
  type DelegateEnv,
} from '@ziggs-ai/api-client';
import { readStoredKey } from './keyStore.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

function delegateEnv() {
  return {
    ZIGGS_API_URL: process.env.ZIGGS_API_URL,
    HTTP_URL: process.env.HTTP_URL,
    ZIGGS_OPERATOR_KEY: process.env.ZIGGS_OPERATOR_KEY,
    ZIGGS_AGENT_ID: process.env.ZIGGS_AGENT_ID,
  };
}

/** API base this process talks to (env override, else package default). */
export function resolveApiBase(): string {
  return resolveDelegateHttpUrl(delegateEnv()) || getBackendUrl();
}

// api-client never reads the environment. Point it at the URL this process
// was given before any command builds a client. ZIGGS_API_URL wins over a
// checkout's HTTP_URL.
const httpUrl = resolveDelegateHttpUrl(delegateEnv());
if (httpUrl) configureApiClient({ httpUrl });

function credsFromResolved(resolved: {
  operatorKey: string;
  agentId: string;
}): Creds {
  return {
    operatorKey: resolved.operatorKey,
    agentId: resolved.agentId,
    instanceId: cliHostIdentity(),
  };
}

/**
 * The key every command runs with. Env key wins. Otherwise the key
 * `ziggs join` wrote for this API base, so `call` and the shorthand commands
 * read the same one. Returns `env` unchanged when neither is present.
 */
export function withStoredKey<T extends DelegateEnv>(env: T): T {
  if (env.ZIGGS_OPERATOR_KEY?.trim()) return env;
  const stored = readStoredKey(resolveDelegateHttpUrl(env) || getBackendUrl());
  if (!stored?.operatorKey) return env;
  return {
    ...env,
    ZIGGS_OPERATOR_KEY: stored.operatorKey,
    ...(stored.agentId ? { ZIGGS_AGENT_ID: stored.agentId } : {}),
  };
}

/**
 * Env key wins. Otherwise the key `ziggs join` wrote for this API base.
 * Returns null when neither is present (so `join` can board).
 */
export function tryLoadCreds(): Creds | null {
  const env = withStoredKey(delegateEnv());
  if (!env.ZIGGS_OPERATOR_KEY?.trim()) return null;
  return credsFromResolved(resolveDelegateCreds(env));
}

export function loadCreds(): Creds {
  try {
    const loaded = tryLoadCreds();
    if (loaded) return loaded;
    // No env key and no file: same refusal as before join existed.
    return credsFromResolved(resolveDelegateCreds(delegateEnv()));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

export const cliVersion = version;
