/**
 * @ziggs-ai/agent-sdk public surface.
 *
 * Foundation:
 *   • Outcome union — discriminated, hybrid (closed core + extension)
 *   • Workflow shape — explicit kind: 'parked' | 'thinking' | 'mechanical'
 *   • Visible defaults — thinkingDefaults({ initial }) spread by author
 *   • Validation at load — defineAgent throws on hard problems, warns on soft
 */

export { defineAgent } from './defineAgent.js';
export { createMcpAgent, resolveZiggsGatewayTarget, wrapGatewayFetch, ZiggsGatewayError } from './mcp/createMcpAgent.js';
export type { CreateMcpAgentOptions, McpAgentHandle, McpTransportConfig } from './mcp/createMcpAgent.js';
// Skills: packaged instructions (SKILL.md + optional references/*.md) that
// become an agent's systemPrompt. Parse-validate-pin is the whole machinery;
// wiring one into an agent is a spread into claudeSdkAgentBase/createMcpAgent.
// Prompt-baked — never the SDK's native skill loader.
export {
  parseSkill, skillHash, skillRolePrompt, skillReferenceName, skillReferenceOneLine,
  splitFrontmatter, SkillValidationError, SKILL_MAX_CHARS,
} from './skills/parseSkill.js';
export type { ParsedSkill, SkillFile, SkillReference } from './skills/parseSkill.js';
export { loadSkill, readSkillFiles, assertSkillHash } from './skills/loadSkill.js';
export { skillReadReferenceTool } from './skills/skillReadReference.js';
export { Agent, createAgent, createAgentPool, DEFAULT_MODEL, resolveFleetModel } from './Agent.js';
export { ZiggsBrain } from './brain/ZiggsBrain.js';
export { ClaudeBrain } from './brain/ClaudeBrain.js';
export type { CognitionKind, ClaudeBrainOptions } from './brain/ClaudeBrain.js';
// The exact strings a Claude-brain wake sends: the shared protocol block, the
// role-independent event prompt, and the one-line context digest. Exported so a
// caller can answer "what does this agent actually put in front of the model,
// and what does it cost?" without re-deriving it — a second copy of the prompt
// is a second answer to that question, and only one of them would be true.
export { CLAUDE_SDK_PROTOCOL } from './brain/claudeSdkProtocol.js';
export { buildClaudeEventPrompt, summarizeContext } from './brain/claudeCognition.js';
export { handlerBrain, ziggsBrain, claudeBrain, isBrainSelection, isClaudeCognition } from './brain/index.js';
export type {
  Brain,
  BrainSelection,
  ZiggsBrainConfig,
  ClaudeBrainConfig,
} from './brain/index.js';
export type { TickInput, TickOutput, ZiggsBrainOptions } from './brain/ZiggsBrain.js';
export type { SessionResolver, AgentOptions, WakeRecord } from './Agent.js';
export { createZiggsEffectHandler } from './platform/ZiggsEffectHandler.js';
export type { ZiggsEffectDeps } from './platform/ZiggsEffectHandler.js';
export { EventQueue } from './platform/EventQueue.js';
export type { EventQueueBusyLane, WaitForIdleResult } from './platform/EventQueue.js';
export { StateTimers, MAX_WAKE_DELAY_MS } from './platform/StateTimers.js';
export type { StateTimeoutEvent, WakeAtEvent, TimerEvent } from './platform/StateTimers.js';
export { laneKeyFor } from './platform/laneKey.js';
// "wake me at", for both brains.
export { wakeAtTool, WAKE_TOOLS } from './platform/tools/tier1/wakeTools.js';
export type { WakeSchedulerPort } from './platform/tools/tier1/wakeTools.js';
export { OutboxBuffer } from './platform/OutboxBuffer.js';
export { normalizeIncomingEvent } from './ingress/normalizeIncoming.js';

// Runtime primitives
export { AgentMachine, type TransitionEvent } from './runtime/AgentMachine.js';
export { runTurn } from './runtime/runTurn.js';
export { runMechanical } from './runtime/runMechanical.js';
export { PromptBuilder } from './runtime/PromptBuilder.js';
export { thinkingDefaults, defineThinkingState, defineMechanicalState, DEFAULT_WAIT_PROMPT } from './runtime/defaults.js';
export {
  KICKOFF_STATE,
  CLAIM_KICKOFF_STATE,
  injectKickoffDefault,
  buildKickoffState,
  buildClaimKickoffState,
  handlesClaimWake,
} from './runtime/kickoff.js';
export { validateWorkflow, WorkflowValidationError, PROBE_CTX } from './runtime/validateWorkflow.js';
export { outcomeFromEvent, outcomeFromActionResult, applyOutcomeToCtx } from './runtime/buildOutcome.js';
export {
  LANE_BOOK_KEY,
  allCollectedResults,
  allDelegatedAgreementIds,
  allPendingSubtasks,
} from './runtime/taskBookkeeping.js';
export { createDeliveryWriteKeys } from './runtime/deliveryWriteKeys.js';

// Types
export type {
  Outcome, OutcomeKind,
  Ctx, Identity, HistoryEntry, ToolResultEntry,
  PendingSubtask, CollectedSubtaskResult, TaskBookkeeping,
  Workflow, State, ParkedState, ThinkingState, MechanicalState,
  Action, Transition, PromptDef, ActionPrompt, Produces, ProducesFn,
  AgreementRef, TaskRef, ProposalRef,
  AgentConfig, DefineAgentInput, ServicesConfig,
  // Effects — Brain↔Agent boundary
  Effect, EffectKind, EffectResult, EffectResultMap, EffectHandler,
  LlmMessage, LlmToolCall, LlmToolSchema, LlmResponse,
  ContextSnapshot, SnapshotParticipant, ReadContextOpts, ToolCallResult, RecordedEntry, DeliveryWriteKeys,
} from './types.js';

export { default } from './Agent.js';

// ── Supporting modules ──────────────────────────────────────────────────────

export { validateContext, ContextWarning } from './cognition/validateContext.js';
export { ConnectionPool } from './platform/ConnectionPool.js';
export { decodeOperatorKeyClaims, boundKeyFleetWarning } from './shared/operatorKeyClaims.js';
export { TaskService } from './platform/tasks/TaskService.js';
export { AgreementService } from './platform/agreements/AgreementService.js';
export { ToolManager } from './tools/ToolManager.js';
export { ToolProvider } from './tools/ToolProvider.js';
export { defineTool } from './tools/defineTool.js';
export type { ToolDefinition } from './tools/defineTool.js';
export { recordReport } from './tools/recordReport.js';
export { credsFromToolContext, laneFromToolContext } from './tools/toolCreds.js';
export type { RecordReportInput, RecordReportResult, TaskReport } from './tools/recordReport.js';
// An agent declares the access it cannot work without, and the declaration
// produces the tools for it.
export {
  MCP_PROVIDER,
  describeNeed,
  normalizeNeeds,
  toolsForNeed,
  toolsForNeeds,
  unmetNeeds,
  unmetNeedsMessage,
} from './tools/needs.js';
export type { AgentNeed, ConnectionNeed } from './tools/needs.js';
export { OpenAIAdapter } from './adapters/OpenAIAdapter.js';
export { extractJSON, safeParseJSON } from './utils/jsonExtractor.js';
export { HistoryFormatter, historyFormatter, AgreementFormatter, agreementFormatter } from './formatters/index.js';
export { ProactiveTrigger } from './platform/proactive/ProactiveTrigger.js';
export {
  PollRegistry,
  declaredPolls,
  type PollBinding,
  type PollContext,
  type PollKind,
  type PollResult,
} from './platform/polls/PollKind.js';
export { PollRunner, type PollRunnerOptions, type WakeTarget } from './platform/polls/PollRunner.js';
// the hand-rolled ZiggsPayClient / ZiggsConnectClient were deleted;
// payment and connection tools now use @ziggs-ai/api-client's PaymentsClient /
// ConnectionsClient, the same clients ziggs-mcp uses.
// the hand-rolled ZiggsContextClient was deleted; context tools now
// use the same @ziggs-ai/api-client clients as ziggs-mcp (GrantsClient /
// ContextGrantsClient / ContextReadClient). Grant/reach types live there.
// All agent tool bundles live under platform/tools/ (tier1 = protocol grammar,
// tier2 = opt-in HTTP capability bundles). Single home: platform/tools/index.ts.
export {
  // Tier 1 — protocol grammar (framework-managed via taskTools).
  PROTOCOL_TOOLS, agreementProposeTool, agreementSubcontractTool,
  agreementRespondTool, agreementClaimTool, agreementCounterTool, agreementGetTool,
  agreementRevokeTool, agreementFulfillTool,
  taskCreateTool, taskSetResultTool, taskUpdatePlanStepTool,
  dispatchProtocolOp,
  // Tier 2 — opt-in capability bundles (spread into `tools:`).
  PAYMENT_TOOLS, paymentBalanceTool,
  CONNECTION_TOOLS, connectionProxyTool, connectionListGrantsTool, requestConnectionTool,
  MCP_CONNECTION_TOOLS, mcpToolCallTool, mcpToolsListTool,
  DISCOVERY_TOOLS, agentSearchTool, agentGetTool,
  MARKETPLACE_TOOLS, marketplaceViewTool,
  CONTEXT_TOOLS, contextReadTool, accessRequestTool, contextDelegateTool, contextExpandReachTool, contextDiscoverGrantableTool,
  GRANTS_TOOLS, listGrantsTool,
  PLAN_TOOLS, taskReplacePlanTool,
  LINK_TOOLS, linkProposeTool, linkListTool,
  INTRODUCTION_TOOLS, introductionMintTool, introductionRedeemTool,
  introductionListTool, introductionRevokeTool,
  PARTY_TOOLS, partyNoteTool,
  ARTIFACT_TOOLS, recordArtifactTool,
  CHAT_TOOLS, openConversationTool,
  LISTING_TOOLS,
} from './platform/tools/index.js';
// The always-on toolset for the hosted Claude cognition (parity guard
// reads this as part of the real SDK registry).
export { CLAUDE_SDK_TOOLS } from './brain/claudeSdkTools.js';
export { hostedModelTools, isHostedDeferred, hostedToolLane } from './brain/hostedToolSurface.js';
export { PROTOCOL_TOOL_NAMES, PROTOCOL_TOOL_TO_OPERATION, mapProtocolToolToOperation, isProtocolToolName } from './tasks/protocolRegistry.js';
export { InMemoryStore, FileMemoryStore } from './memory/MemoryStore.js';
export { ArtifactMemoryStore, memoryStoreFor } from './memory/ArtifactMemoryStore.js';
export type { MemoryStore } from './memory/MemoryStore.js';
export type { SessionStore } from './Agent.js';
export { classifyIncomingEvent } from './context/classifyEnvelope.js';
export { buildContextUpdates, CONTEXT_RESET } from './context/applyEffects.js';
export { getBatchEvents, isTaskResultRelevantToAgent } from './context/batch.js';
export { classifyWorkflowEvent, findTaskResult, unwrapBatchEvent, findIncomingTaskResult } from './context/routingLabels.js';
export {
  MessagesClient,
  ArtifactsClient,
  AgentSearchClient,
  getBackendUrl,
  // self-hosted / non-default backend: consumers of agent-sdk alone
  // must be able to point the shared HTTP client without a direct api-client dep.
  configureApiClient,
} from '@ziggs-ai/api-client';
export type { ApiClientConfig } from '@ziggs-ai/api-client';

export { SeenMessages } from './platform/SeenMessages.js';
export { runtimeLog, resetRuntimeLogLevelCache } from './shared/runtimeLog.js';
export type { RuntimeLogLevel } from './shared/runtimeLog.js';
export { runAgents } from './launcher/runAgents.js';
export type { RunnerOptions, SingleAgentRun, FleetRun } from './launcher/runAgents.js';
export { createHealthServer, inboxHealth } from './launcher/createHealthServer.js';
export type { AgentLiveness, HealthRequest, HealthRequestHandler } from './launcher/createHealthServer.js';
