/**
 * Agent tool bundles, in two tiers. Single home for everything an agent can
 * "speak" or "do" over the wire.
 *
 * Tier 1 — protocol grammar (tier1/). The verbs every agent uses to participate
 * in the agreement/task system. Framework-managed: attached via the `taskTools`
 * config (default 'all'), dispatched to in-process services (taskService /
 * agreementService) injected into tool context — NOT passed in the user `tools:`
 * array. Publishing open work is part of this grammar:
 * agreement_propose({ proposedTo: "everyone" }) for a public broadcast, or
 * proposedTo: "org" to scope it to your org, or "company" to every team in your
 * company — there is no separate publish tool.
 *
 * Tier 2 — capability bundles (tier2/). Opt-in, HTTP-backed tool bundles an agent
 * chooses to have. Off by default; an agent gains a bundle by spreading it into
 * its `tools:` array. Each tool reads operatorKey/agentId from tool context and
 * wraps a backend HTTP client — no per-agent plumbing.
 */

// ── Tier 1: protocol grammar ────────────────────────────────────────────────
export {
  PROTOCOL_TOOLS,
  agreementProposeTool, agreementSubcontractTool, agreementRespondTool,
  agreementClaimTool, agreementCounterTool, agreementGetTool, agreementRevokeTool,
  agreementFulfillTool,
  taskCreateTool, taskSetResultTool, taskUpdatePlanStepTool,
} from './tier1/protocolTools.js';
export { dispatchProtocolOp } from './tier1/protocolRunner.js';

// ── Tier 2: capability bundles ──────────────────────────────────────────────
export { DISCOVERY_TOOLS, agentSearchTool, agentGetTool } from './tier2/discoveryTools.js';
export { MARKETPLACE_TOOLS, marketplaceViewTool } from './tier2/marketplaceTools.js';
export { PAYMENT_TOOLS, paymentBalanceTool } from './tier2/paymentTools.js';
export {
  CONNECTION_TOOLS,
  connectionProxyTool,
  connectionListGrantsTool,
  requestConnectionTool,
} from './tier2/connectionTools.js';
export {
  CONTEXT_TOOLS,
  contextReadTool,
  accessRequestTool,
  contextDelegateTool,
  contextExpandReachTool,
  contextDiscoverGrantableTool,
} from './tier2/contextTools.js';
// one grant lister across every rail (retires context_discover +
// payment_list_grants). Always-available on the hosted agent — see CLAUDE_SDK_TOOLS.
export { GRANTS_TOOLS, listGrantsTool } from './tier2/grantsTools.js';
export { TASK_TOOLS, listTasksTool, cancelTaskTool, delegateTaskTool } from './tier2/taskTools.js';
export { PLAN_TOOLS, taskReplacePlanTool } from './tier2/planTools.js';
// links (agreements with engagementKind 'link') — cross-org reach.
///1022: the rail is two tools; propose/claim/revoke ride the
// agreement grammar.
export {
  LINK_TOOLS,
  linkProposeTool, linkListTool,
} from './tier2/linkTools.js';
// introduction tokens — a meeting somewhere else turned into a link here.
export {
  INTRODUCTION_TOOLS,
  introductionMintTool, introductionRedeemTool,
  introductionListTool, introductionRevokeTool,
} from './tier2/introductionTools.js';
// a person not on Ziggs yet — what your workspace knows about them.
export { PARTY_TOOLS, partyNoteTool } from './tier2/partyTools.js';
// deliberate artifact recording (the model decides "record this").
export { ARTIFACT_TOOLS, recordArtifactTool } from './tier2/artifactTools.js';
export { LISTING_TOOLS } from './tier2/listingTools.js';
export {
  MCP_CONNECTION_TOOLS,
  mcpToolCallTool,
  mcpToolsListTool,
} from './tier2/mcpConnectionTools.js';
// Decision: chat_open only — chat listing stays a context-rail read
// (grant_list scopeKind=chat), so there is no duplicate lister.
export { CHAT_TOOLS, openConversationTool } from './tier2/chatTools.js';
