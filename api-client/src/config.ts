/**
 * Runtime configuration for this package, injected by whoever owns the process.
 *
 * This package used to read `process.env` directly, which is why every http
 * client began with `import 'dotenv/config'`. Metro (React Native's bundler)
 * cannot resolve dotenv, so a mobile consumer could not import api-client at
 * all. The environment is now read by the host — `env-init.ts` in this repo,
 * the MCP server's config loader, a mobile app's bootstrap — and handed here.
 *
 * Configure before constructing clients: `getBackendUrl()` is called in their
 * constructors, so a client built first keeps the URL that was current then.
 */

/** Threshold names accepted by {@link ApiClientConfig.logLevel}. */
export type ApiClientLogLevel =
  | 'debug'
  | 'trace'
  | 'info'
  | 'warn'
  | 'error'
  | 'silent'
  | 'none';

export interface ApiClientConfig {
  /** Backend base URL. Falls back to production when nothing sets it. */
  httpUrl?: string;
  /** `runtimeLog` threshold. Falls back to `info`. */
  logLevel?: ApiClientLogLevel;
}

const config: ApiClientConfig = {};

/**
 * Bumped on every configure so derived caches (the log threshold) know to
 * recompute. A version counter rather than a reset callback because
 * `runtimeLog` reads config — a callback the other way would be a cycle.
 */
let version = 0;

/**
 * Merge settings into the package config. Partial: passing only `logLevel`
 * leaves a previously configured `httpUrl` alone. Explicit `undefined` is
 * ignored rather than treated as a clear, so a host can spread a half-filled
 * options object without wiping what it already set.
 */
export function configureApiClient(next: ApiClientConfig): void {
  if (next.httpUrl !== undefined) config.httpUrl = next.httpUrl;
  if (next.logLevel !== undefined) config.logLevel = next.logLevel;
  version += 1;
}

/** Current config. Read-only — mutate through {@link configureApiClient}. */
export function apiClientConfig(): Readonly<ApiClientConfig> {
  return config;
}

/** Generation counter for cache invalidation. */
export function apiClientConfigVersion(): number {
  return version;
}
