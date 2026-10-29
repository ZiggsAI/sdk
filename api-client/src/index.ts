export * from './http/index.js';
export * from './capabilities/index.js';
export { ConnectionManager } from './ConnectionManager.js';
export {
  EntryTypes,
  ContentTypes,
  OPEN_AGREEMENT_TARGET,
  ORG_AGREEMENT_TARGET,
  COMPANY_AGREEMENT_TARGET,
  BROADCAST_TARGETS,
  isBroadcastTarget,
  isPersonaRef,
  isRoomPresentationRef,
  isOpaquePresentationRef,
  AGREEMENT_ENGAGEMENT_KIND,
  isValidContentType,
  partySideIds,
  partyActorIds,
} from './types.js';
export type { PrincipalPresentation } from './types.js';
export { getBackendUrl } from './utils/urlUtils.js';
// the host injects the environment; this package never reads it.
export { configureApiClient, apiClientConfig } from './config.js';
export type { ApiClientConfig, ApiClientLogLevel } from './config.js';
export { runtimeLog, resetRuntimeLogLevelCache } from './shared/runtimeLog.js';
export type { RuntimeLogLevel } from './shared/runtimeLog.js';
export {
  resolveDelegateCreds,
  resolveDelegateHttpUrl,
} from './shared/delegateCreds.js';
export type {
  DelegateEnv,
  ResolvedDelegateCreds,
} from './shared/delegateCreds.js';
// one ApiError shape; 429s carry the server's wait.
export {
  RateLimitedError,
  isRateLimited,
  parseRetryAfterMs,
  pollSurfaceError,
} from './shared/rateLimit.js';
// One reader for the one error shape the API answers in — exported so nothing has
// to re-implement the field precedence (it was copy-pasted into six clients, and
// half of them had drifted).
export {
  parseErrorMessage,
  parseErrorCode,
  throwApiError,
} from './shared/apiError.js';
export { ApiError } from './types.js';
export type {
  Creds,
  Task,
  TaskState,
  PlanStep,
  PlanStepStatus,
  Agreement,
  AgreementParties,
  AgreementPartySide,
  EngagementKind,
  BroadcastAudience,
  EntryType,
  ContentType,
  MessageMetadata,
  MessageHandler,
  InboxDeliveryKind,
  InboxDeliveryRef,
  InboxChatNews,
  InboxProposalRef,
  InboxTaskRef,
  InboxRequestRef,
  InboxConnectionRequestRef,
  InboxHumanAttention,
  InboxEnvelope,
  InboxAckResult,
  InboxPeek,
  InboxReadOptions,
} from './types.js';
export type {
  ProposeTerms,
  ProposeDirectInput,
  ProposeBroadcastInput,
  ProposeAgreementData,
  ClaimOptions,
  ClaimRoom,
} from './http/AgreementClient.js';

// One decision, one sentence, on every rail: the reason a delivery row carries
// when somebody answered a request this agent made, rendered as words.
export { decisionWords, speakableActor } from './decisionWords.js';
export type {
  DecisionOutcome,
  DecisionWords,
  DecisionWordsInput,
} from './decisionWords.js';

export {
  planInboxAck,
  planPartialInboxAck,
  inboxAckAllowed,
  inboxAckHandledIds,
} from './inboxAck.js';
export type {
  InboxAckDecision,
  InboxAckStep,
  InboxAckEnvelope,
  PlanInboxAckOptions,
} from './inboxAck.js';
export { agreementLaneId, agreementIdFromLane, isAgreementLaneId, isAgreementId } from '@ziggs-ai/contracts';
/** The one way to show points (hundredths → ϟ5.00), shared with the web and the phone. */
export { POINTS_GLYPH, formatPoints, formatPointsPrice } from '@ziggs-ai/contracts';
export * from './shared/operatorKey.js';
export {
  INBOX_HOST_CLAIMANT_HEADER,
  INSTANCE_IDENTITY_MAX_LENGTH,
  cliHostIdentity,
  hostIdentity,
  instanceIdentity,
  mcpConnectionIdentity,
} from './instanceIdentity.js';
export * from './utils/appUrls.js';
export {
  sessionOrientation,
} from './sessionOrientation.js';
export type {
  ContinuationKind,
  InboxAckDriver,
  InboxHandling,
  RepresentedPerson,
  SessionContinuation,
  SessionOrientation,
  SessionOrientationInput,
} from './sessionOrientation.js';
export {
  inboxEngagement,
  isEchoOrDuplicate,
  isHireWorkOrder,
  contactPath,
  formationGuide,
  marketplaceFormation,
  liveHireChangedTerms,
  liveHireConflictFromStatus,
  withdrawHeldGraph,
  reminderHonesty,
  graphReleaseHonesty,
  hintsFromTasks,
} from './engagementGuide.js';
export type {
  EngagementGuide,
  EngagementGuideKind,
  EngagementOutcome,
  EngagementTaskHint,
  ContactPathInput,
  FormationInput,
  GraphHonesty,
  HireTermsHonesty,
  WaitingOn,
} from './engagementGuide.js';

export { isContextAccessRequest } from './shared/contextAccessRequest.js';

export {
  AssistantConnectionClient,
  type AssistantWorkspace,
  type McpEventStatus,
} from './http/AssistantConnectionClient.js';

export { withAssistantRequest, assistantRequestHeaders } from './http/operatorHeaders.js';

// Short handles: T…, A…, C…, F… (task, agreement, chat, artifact).
export { HANDLE_ALPHABET, findHandles, looksLikeHandle, parseHandle, parseRef, type HandleKind } from './handles.js';

export { describeOperationError, type OperationError } from './shared/operationError.js';

export { withWorkExecution, withWorkExecutionId, currentWorkExecution } from './http/operatorHeaders.js';
export { deliveryHandlingId, type WorkExecutionContext, type WorkPositionView } from '@ziggs-ai/contracts';

export { validateWorkExecution } from './http/ExecutionContextClient.js';
