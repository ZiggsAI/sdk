export * from './TaskClient.js';
export * from './AgreementClient.js';
export * from './MarketplaceClient.js';
export * from './agreementFlows.js';
export * from './ChatClient.js';
export { MessagesClient, messagesListUrl } from './MessagesClient.js';
export type { ListMessagesOptions, ListMessagesResult } from './MessagesClient.js';
export {
  ArtifactsClient,
  // agreement lanes are not chats — callers scope artifact writes with this.
  artifactScopeForSession,
  AGREEMENT_LANE_PREFIX,
  ARTIFACT_INLINE_TEXT_MAX_CHARS,
  ARTIFACT_INLINE_TEXT_OVER_LIMIT_HINT,
} from './ArtifactsClient.js';
export type {
  ArtifactVisibility,
  ListArtifactsOptions,
  ListArtifactsQuery,
  ListArtifactsResult,
  WriteArtifactInput,
} from './ArtifactsClient.js';
export {
  ContextReadClient,
  CONTEXT_READ_TYPES,
  CONTEXT_READ_VIA,
  VIA_KINDS,
  parseVia,
  viaHint,
} from './ContextReadClient.js';
export type {
  ContextReadType,
  ContextReadQuery,
  ContextReadEnvelope,
  ContextSnapshotResult,
  ContextSnapshotParticipant,
  ViaKind,
} from './ContextReadClient.js';
export { ContextOpenClient, CONTEXT_OPEN_KINDS } from './ContextOpenClient.js';
export type {
  ContextOpenKind,
  ContextOpenOutcome,
  ContextOpenRef,
  ContextOpenBody,
  ResourceAction,
  ResourceActionCall,
  ContextOpenAccess,
  ContextOpenResult,
  ContextExplainResult,
} from './ContextOpenClient.js';
export { ContextDiscoveryClient } from './ContextDiscoveryClient.js';
export type { DiscoverableItem } from './ContextDiscoveryClient.js';
export { IntroductionsClient } from './IntroductionsClient.js';
export { PartiesClient, type PartyNotesView } from './PartiesClient.js';
export type {
  IntroductionView,
  IntroductionFrom,
  IntroductionStatus,
  IntroductionOutcome,
  MintIntroductionInput,
} from './IntroductionsClient.js';
export { GrantsClient } from './GrantsClient.js';
export type { ListGrantsQuery, ListGrantsResult, UnreadableRail } from './GrantsClient.js';
export { ContextGrantsClient } from './ContextGrantsClient.js';
export type {
  ContextGrantRecord,
  ContextGrantScope,
  ContextGrantScopeKind,
  ContextTemporal,
  IssueContextGrantInput,
  DelegateContextGrantInput,
  DelegateContextGrantResult,
  ReachEntry,
  GrantReachResult,
} from './ContextGrantsClient.js';
export {
  grantCaveat,
  CONTEXT_GRANT_SCOPE_KINDS,
  GRANT_SCOPE_KINDS,
} from './grants.js';
export type {
  GrantView,
  GrantScopeKind,
  GrantScopeView,
  GrantCaveatView,
  GrantHealth,
  GrantHolderKind,
  GrantAccessKind,
  GrantBasisKind,
} from './grants.js';
export { PaymentsClient } from './PaymentsClient.js';
export type {
  PaymentsError,
  WalletBalance,
  WalletRef,
  PaymentGrantView,
  PaymentGrantEnvelope,
  RevokeGrantResult,
} from './PaymentsClient.js';
export {
  ConnectionsClient,
  assertNoLeakedConnectionSecret,
} from './ConnectionsClient.js';
export type {
  ConnectionsError,
  ConnectionProxyParams,
  ConnectionGrant,
  ConnectionWithGrants,
  McpConnectionRequestParams,
} from './ConnectionsClient.js';
export {
  fetchMyOrgs,
  resolveOrgSelector,
  fetchDelegateAccess,
  fetchHostedAgentAccess,
  fetchSessionAccess,
} from './OrgsClient.js';
export type { MyOrg, OrgResolution } from './OrgsClient.js';
export { AgentSearchClient } from './AgentSearchClient.js';
export { TelemetryClient } from './TelemetryClient.js';
export { InboxClient } from './InboxClient.js';
export {
  planInboxAck,
  planPartialInboxAck,
  inboxAckAllowed,
  inboxAckHandledIds,
} from '../inboxAck.js';
export type {
  InboxAckDecision,
  InboxAckStep,
  InboxAckEnvelope,
  PlanInboxAckOptions,
} from '../inboxAck.js';
// The lane header, built in one place — see operatorHeaders.ts. Exported
// because the MCP transports in agent-sdk and ziggs-mcp send it too, and a
// copy of a header nobody notices missing goes stale unseen.
export {
  WAKE_LANE_HEADER,
  WAKE_AGREEMENT_HEADER,
  laneHeader,
  laneUnderAgreement,
  buildOperatorHeaders,
  buildCredsHeaders,
} from './operatorHeaders.js';

export { backendToolPick, type ToolPickOption, type ToolPickAnswer, type PickTool } from './ToolPickClient.js';
