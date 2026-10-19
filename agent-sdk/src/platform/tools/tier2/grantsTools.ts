import { GRANTS_CAPABILITIES, listGrantsCapability } from '@ziggs-ai/api-client';
import { toolFromCapability, toolsFromCapabilities } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// the single "what authority do I hold?" tool, defined
// once in api-client's shared capability layer.

export const listGrantsTool: ToolDefinition = toolFromCapability(listGrantsCapability);

export const GRANTS_TOOLS: ToolDefinition[] = toolsFromCapabilities(GRANTS_CAPABILITIES);
