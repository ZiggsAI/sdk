import {
  CONTEXT_CAPABILITIES,
  contextReadCapability,
  openCapability,
  accessExplainCapability,
  contextDelegateCapability,
  contextExpandReachCapability,
  contextDiscoverGrantableCapability,
  accessRequestCapability,
} from '@ziggs-ai/api-client';
import { toolFromCapability, toolsFromCapabilities } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// context grant tools ride the same api-client
// clients as ziggs-mcp; the whole definition (schema + handler) is now shared
// via the capability layer, so the two surfaces cannot fork.

export const contextReadTool: ToolDefinition = toolFromCapability(contextReadCapability);
export const openTool: ToolDefinition = toolFromCapability(openCapability);
export const accessExplainTool: ToolDefinition = toolFromCapability(accessExplainCapability);
export const accessRequestTool: ToolDefinition = toolFromCapability(accessRequestCapability);
export const contextDelegateTool: ToolDefinition = toolFromCapability(contextDelegateCapability);
export const contextExpandReachTool: ToolDefinition = toolFromCapability(
  contextExpandReachCapability,
);
export const contextDiscoverGrantableTool: ToolDefinition = toolFromCapability(
  contextDiscoverGrantableCapability,
);

export const CONTEXT_TOOLS = toolsFromCapabilities(CONTEXT_CAPABILITIES);
