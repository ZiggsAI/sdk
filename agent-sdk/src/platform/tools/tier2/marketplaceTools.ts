import { MARKETPLACE_CAPABILITIES, marketplaceViewCapability } from '@ziggs-ai/api-client';
import { toolFromCapability, toolsFromCapabilities } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// the marketplace read (requests AND standing offers),
// defined once in api-client's shared capability layer. Publishing is NOT
// here: it is the tier-1 verb agreement_propose with proposedTo
// "everyone" | "org" | "company" (providerId = own id for an offer, omitted for a request);
// claiming is agreement_claim.

export const marketplaceViewTool: ToolDefinition = toolFromCapability(marketplaceViewCapability);

export const MARKETPLACE_TOOLS: ToolDefinition[] = toolsFromCapabilities(MARKETPLACE_CAPABILITIES);
