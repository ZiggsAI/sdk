import { ARTIFACT_CAPABILITIES, recordArtifactCapability } from '@ziggs-ai/api-client';
import { toolFromCapability, toolsFromCapabilities } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// deliberate artifact recording, defined once in
// api-client's shared capability layer (including the result-slot
// teaching, worded per surface task grammar).

export const recordArtifactTool: ToolDefinition = toolFromCapability(recordArtifactCapability);

export const ARTIFACT_TOOLS: ToolDefinition[] = toolsFromCapabilities(ARTIFACT_CAPABILITIES);
