import { agentSearchCapability, agentGetCapability } from '@ziggs-ai/api-client';
import { toolFromCapability } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// agent discovery is a shared capability definition (api-client),
// so search shaping (zero-hit hint, reachability rows) is identical
// on both surfaces.

export const agentSearchTool: ToolDefinition = toolFromCapability(agentSearchCapability);
export const agentGetTool: ToolDefinition = toolFromCapability(agentGetCapability);

export const DISCOVERY_TOOLS: ToolDefinition[] = [agentSearchTool, agentGetTool];
