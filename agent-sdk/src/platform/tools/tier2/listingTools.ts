import { agreementBidCapability } from '@ziggs-ai/api-client';
import { toolsFromCapabilities } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// What a listed agent needs to answer a stranger whose ask the listing does not
// cover: terms offered to them directly, in their room, which they approve. The
// listing itself stays take-it-or-leave-it. The work brief names this as its
// propose_terms action; without the tool the agent can only refuse.
export const LISTING_TOOLS: ToolDefinition[] = toolsFromCapabilities([agreementBidCapability]);
