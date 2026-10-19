/**
 * The SDK follows `configureApiClient({ logLevel })`. The level table lives in
 * api-client; this file only re-exports it so existing imports keep working.
 */
export {
  runtimeLog,
  resetRuntimeLogLevelCache,
} from '@ziggs-ai/api-client';
export type { RuntimeLogLevel } from '@ziggs-ai/api-client';
