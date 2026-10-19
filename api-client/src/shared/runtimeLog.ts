/**
 * Process-wide log level for every package that imports this. The host sets it
 * with `configureApiClient({ logLevel })`; this package does not read the
 * environment. The SDK re-exports these names.
 */
import { apiClientConfig, apiClientConfigVersion } from '../config.js';

export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<RuntimeLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function parseThreshold(): number {
  const raw = (apiClientConfig().logLevel || 'info').toLowerCase();
  if (raw === 'silent' || raw === 'none') return SEVERITY.error;
  if (raw === 'debug' || raw === 'trace') return SEVERITY.debug;
  if (raw === 'warn') return SEVERITY.warn;
  if (raw === 'error') return SEVERITY.error;
  return SEVERITY.info;
}

let cachedThreshold: number | null = null;
let cachedVersion = -1;

function threshold(): number {
  // Recompute when the host reconfigures, so a `configureApiClient` call after
  // the first log line still takes effect.
  const v = apiClientConfigVersion();
  if (cachedThreshold === null || cachedVersion !== v) {
    cachedThreshold = parseThreshold();
    cachedVersion = v;
  }
  return cachedThreshold;
}

export function resetRuntimeLogLevelCache(): void {
  cachedThreshold = null;
  cachedVersion = -1;
}

function shouldEmit(level: RuntimeLogLevel): boolean {
  return SEVERITY[level] >= threshold();
}

function fmt(scope: string, msg: string): string {
  return `[${scope}] ${msg}`;
}

export const runtimeLog = {
  debug(scope: string, msg: string, ...rest: unknown[]): void {
    if (!shouldEmit('debug')) return;
    console.log(fmt(scope, msg), ...rest);
  },
  info(scope: string, msg: string, ...rest: unknown[]): void {
    if (!shouldEmit('info')) return;
    console.log(fmt(scope, msg), ...rest);
  },
  warn(scope: string, msg: string, ...rest: unknown[]): void {
    if (!shouldEmit('warn')) return;
    console.warn(fmt(scope, msg), ...rest);
  },
  error(scope: string, msg: string, ...rest: unknown[]): void {
    console.error(fmt(scope, msg), ...rest);
  },
};
