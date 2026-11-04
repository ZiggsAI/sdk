import { BUCKET_CAPABILITIES } from '@ziggs-ai/api-client';
import { toolsFromCapabilities } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// Buckets: working sets whose whole audience can read every item in them.
// Opt-in: a run uses the bucket its message was sent in without these; an
// agent adds them to change buckets itself.
export const BUCKET_TOOLS: ToolDefinition[] = toolsFromCapabilities(BUCKET_CAPABILITIES);
