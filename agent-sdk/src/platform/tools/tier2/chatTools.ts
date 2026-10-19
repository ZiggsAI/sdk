import { CHAT_CAPABILITIES, openConversationCapability } from '@ziggs-ai/api-client';
import { toolFromCapability, toolsFromCapabilities } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// chat_open only (chat listing stays a
// context-rail read, rule); defined once in api-client's shared
// capability layer.

export const openConversationTool: ToolDefinition = toolFromCapability(openConversationCapability);

export const CHAT_TOOLS: ToolDefinition[] = toolsFromCapabilities(CHAT_CAPABILITIES);
