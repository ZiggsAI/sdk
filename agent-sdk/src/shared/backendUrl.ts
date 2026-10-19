import { getBackendUrl } from '@ziggs-ai/api-client';

/**
 * The backend address, read one way everywhere in the SDK.
 *
 * Explicit config wins, then the runner's overrides (`ZIGGS_BACKEND_URL`,
 * `BACKEND_URL`), then `getBackendUrl()` — what `configureApiClient` set, else
 * production. There were five copies with three different orders, and the one
 * in the per-user connect path fell back to `http://localhost:3000`, so an
 * outside developer who configured the client and nothing else had connection
 * requests posted to their own machine.
 */
export function resolveBackendUrl(explicit?: string | null): string {
  return (
    explicit ||
    process.env.ZIGGS_BACKEND_URL ||
    process.env.BACKEND_URL ||
    getBackendUrl()
  ).replace(/\/$/, '');
}
