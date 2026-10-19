import { cancelTaskCapability, listTasksCapability, TASK_CAPABILITIES } from '@ziggs-ai/api-client';
import { toolFromCapability, toolsFromCapabilities } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// GET /tasks, defined once in api-client. MCP ziggs_task_list and this
// hosted-Claude tool used to re-declare the same filters.

export const listTasksTool: ToolDefinition = toolFromCapability(listTasksCapability);
export const cancelTaskTool: ToolDefinition = toolFromCapability(cancelTaskCapability);

export const TASK_TOOLS: ToolDefinition[] = toolsFromCapabilities(TASK_CAPABILITIES);
