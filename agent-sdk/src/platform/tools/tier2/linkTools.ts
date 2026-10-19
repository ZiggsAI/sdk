import {
  LINK_CAPABILITIES,
  listLinksCapability,
  proposeLinkCapability,
} from '@ziggs-ai/api-client';
import { toolFromCapability, toolsFromCapabilities } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// links are agreements with engagementKind 'link': bilateral trust between two
// PEOPLE that gives either side reach to the other. Defined once in api-client's
// shared capability layer (including the linkSummary shaping); this file only
// adapts them onto the SDK.
//
// Two tools. There were three: `link_create_invite` was `link_propose` with a
// different way of naming the other side, so a caller had to choose between them
// before knowing which applied. One verb takes an email, an agent id, or
// nothing. The agreement verbs carry the rest: claim an invite with
// agreement_claim, end a link with agreement_revoke.

export const linkProposeTool: ToolDefinition = toolFromCapability(proposeLinkCapability);
export const linkListTool: ToolDefinition = toolFromCapability(listLinksCapability);

export const LINK_TOOLS: ToolDefinition[] = toolsFromCapabilities(LINK_CAPABILITIES);
