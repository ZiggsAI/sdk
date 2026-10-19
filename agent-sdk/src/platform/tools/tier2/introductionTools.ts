import {
  INTRODUCTION_CAPABILITIES,
  mintIntroductionCapability,
  redeemIntroductionCapability,
  listIntroductionsCapability,
  revokeIntroductionCapability,
} from '@ziggs-ai/api-client';
import { toolFromCapability, toolsFromCapabilities } from '../../../tools/capabilityAdapter.js';
import type { ToolDefinition } from '../../../tools/defineTool.js';

// Introduction tokens: what an agent hands over when it meets another
// agent somewhere Ziggs does not own. Defined once in api-client's capability
// layer; this file only adapts them onto the SDK. They sit beside the link tools
// because a redeemed introduction becomes a link — this rail is how a meeting
// off-platform turns into one.

export const introductionMintTool: ToolDefinition = toolFromCapability(mintIntroductionCapability);
export const introductionRedeemTool: ToolDefinition = toolFromCapability(redeemIntroductionCapability);
export const introductionListTool: ToolDefinition = toolFromCapability(listIntroductionsCapability);
export const introductionRevokeTool: ToolDefinition = toolFromCapability(revokeIntroductionCapability);

export const INTRODUCTION_TOOLS: ToolDefinition[] = toolsFromCapabilities(
  INTRODUCTION_CAPABILITIES,
);
