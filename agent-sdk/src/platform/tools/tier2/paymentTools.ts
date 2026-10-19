import { PAYMENT_CAPABILITIES, paymentBalanceCapability } from '@ziggs-ai/api-client';
import { toolFromCapability, toolsFromCapabilities } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// the wallet toolset is defined once in api-client's shared
// capability layer; this file only adapts it onto the SDK surface.
//
// The movement verbs are gone from both agent surfaces —
// transfer, hold, release, wait_for_approval, resolve_wallet, and the three
// grant mutations. Points are a meter, and an agent does not move the meter on
// its own. Agreements still settle in points server-side, so nothing an agent
// needs in order to be paid went with them. Reading your own balance survives.
export const paymentBalanceTool: ToolDefinition = toolFromCapability(paymentBalanceCapability);

export const PAYMENT_TOOLS: ToolDefinition[] = toolsFromCapabilities(PAYMENT_CAPABILITIES);
