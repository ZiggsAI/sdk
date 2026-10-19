import { PARTY_CAPABILITIES, partyNoteCapability } from '@ziggs-ai/api-client';
import { toolFromCapability, toolsFromCapabilities } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// A person who is not on Ziggs yet: someone your workspace reaches by mail or
// Slack. What your workspace knows about them rides in every room snapshot
// they are in. Defined once in api-client's capability layer.

export const partyNoteTool: ToolDefinition = toolFromCapability(partyNoteCapability);

export const PARTY_TOOLS: ToolDefinition[] = toolsFromCapabilities(PARTY_CAPABILITIES);
