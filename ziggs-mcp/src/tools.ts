import { isDirectorySurface } from './directorySurface.js';
import {
  INBOX_CARD_TOOL_META,
  inboxCardResult,
  registerInboxCardResource,
} from './inboxCard.js';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  presentResourceActions,
  type ResourceAction,
  getAgreement,
  getMyAgreements,
  listMyChats,
  respondToAgreement,
  revokeAgreement,
  counterAgreement,
  fulfillAgreement,
  sendChatMessage,
  ConnectionsClient,
  ContextReadClient,
  GrantsClient,
  InboxClient,
  SessionsClient,
  AssistantConnectionClient,
  createTask,
  updateTaskState,
  acknowledgeTaskControl,
  replaceTaskPlan,
  updateTaskPlanSteps,
  listTasks,
  getTask,
  getBackendUrl,
  fetchMyOrgs,
  fetchSessionAccess,
  isMcpOAuthDelegateSession,
  GRANTS_CAPABILITIES,
  AGREEMENT_TERMS_PARAMS,
  AGREEMENT_VERB_CAPABILITIES,
  LISTING_DOOR_CAPABILITIES,
  CONTEXT_GRANT_SCOPE_KINDS,
  contextReadCapability,
  openCapability,
  accessExplainCapability,
  contextExpandReachCapability,
  contextDiscoverGrantableCapability,
  recordArtifactCapability,
  listArtifactsCapability,
  findArtifactsCapability,
  shareArtifactCapability,
  attachArtifactCapability,
  uploadArtifactUrlCapability,
  completeArtifactFileCapability,
  downloadArtifactCapability,
  openConversationCapability,
  connectionProxyCapability,
  requestConnectionCapability,
  agreementClaimCapability,
  agreementSubcontractCapability,
  listTasksCapability,
  cancelTaskCapability,
  marketplaceViewCapability,
  parseListFields,
  pickListedRows,
  listedFieldNote,
  projectChatListRows,
  sessionOrientation,
  presentSendResult,
  presentTaskOutcome,
  type GrantView,
  type ContextReadType,
  type Creds,
  type InboxEnvelope,
  type Task,
  type TaskState,
  type PlanReplaceStep,
  type PlanStepPatch,
  explainRefusedRead,
  RESOURCE_HIDDEN_MESSAGE,
  SOURCES_DESCRIPTION,
  type WriteSource,
} from '@ziggs-ai/api-client';
import type { ZiggsMcpConfig } from './config.js';
import { decodeOperatorKeyClaims } from './operatorKey.js';
import { registerTrustTools } from './trustTools.js';
import { registerPaymentTools } from './paymentTools.js';
import {
  formatInboxToolResult,
  buildReadContextReadPlan,
} from './inboxToolResult.js';
import { compactTextResult, windowNote } from './inboxCompact.js';
import { sessionRules } from './protocol/connectText.js';
import {
  agreementAppUrl,
  filterTasksForDelegate,
  formatPendingDecisionsPayload,
  resolveWebAppOrigin,
} from './pendingDecisions.js';
import {
  resolveMcpConnectionTarget,
  withMcpGatewayClient,
} from './mcpConnectionTools.js';

import { readOnly, write, destructive } from './toolAnnotations.js';
import { registerStrictTool } from './strictParams.js';
import { refusalError, toolError } from './toolError.js';
import {
  registerCapability,
  registerCapabilities,
  textResult,
} from './capabilityAdapter.js';

// the strict artifact write (fail loudly, return the artifactId)
// moved into ArtifactsClient.writeStrict, shared with the SDK's artifact_record.

// the leak-guard, the connections proxy/request calls, the
// grouped connection lister (ConnectionsClient.listForHolder), the org lookups
    // (fetchMyOrgs / fetchSessionAccess), and the whole SDK-twin tool definitions
// all live in @ziggs-ai/api-client now (shared with the agent SDK).

/** The human this delegate acts for: operator-key ownerId, else the config id. */
function ownerPrincipalId(creds: Creds, cfg: ZiggsMcpConfig): string | null {
  return (
    decodeOperatorKeyClaims(creds.operatorKey)?.ownerId ??
    cfg.ZIGGS_OWNER_USER_ID ??
    null
  );
}

/**
 * Ids this delegate answers for: its own agent id plus its principal's user
 * id (operator-key ownerId / ZIGGS_OWNER_USER_ID). Used to decide which
 * active tasks count as "your work" on session cards.
 */
function delegateSelfIds(creds: Creds, cfg: ZiggsMcpConfig): Set<string> {
  const ids = new Set<string>([creds.agentId]);
  const ownerId = decodeOperatorKeyClaims(creds.operatorKey)?.ownerId;
  if (ownerId) ids.add(ownerId);
  if (cfg.ZIGGS_OWNER_USER_ID) ids.add(cfg.ZIGGS_OWNER_USER_ID);
  return ids;
}

/**
 * The one read the inbox envelope cannot answer: the richer active-task rows.
 *
 * Split from the formatting below because it does not take the envelope as
 * input. Kept apart, a cold session start can put it on the wire alongside
 * the inbox fetch instead of behind it — the difference between one wave of
 * backend round-trips and two, on the call the surface advertises as "where you
 * stand, in one call".
 */
function loadSessionReads(
  creds: Creds,
): Promise<[PromiseSettledResult<Awaited<ReturnType<typeof listTasks>>>]> {
  return Promise.allSettled([listTasks({ state: 'active', limit: 20 }, creds)]);
}

/**
 * The session-start block, built from an envelope the caller already has and
 * the reads that were started beside it.
 *
 * This used to fetch its own inbox copy, because three tools each wanted the
 * same orientation and each paid for it separately. Now one tool owns the
 * session start and hands the envelope in.
 */
function buildSessionActions(
  inbox: InboxEnvelope,
  reads: Awaited<ReturnType<typeof loadSessionReads>>,
  creds: Creds,
  cfg: ZiggsMcpConfig,
): Record<string, unknown> {
  const webOrigin = resolveWebAppOrigin(cfg.ZIGGS_WEB_URL);
  const [tasksSettled] = reads;
  let activeTasks: Task[] = [];
  let activeTasksError: string | undefined;
  if (tasksSettled.status === 'fulfilled') {
    activeTasks = filterTasksForDelegate(
      tasksSettled.value.tasks ?? [],
      delegateSelfIds(creds, cfg),
    );
  } else {
    // inbox is still useful when task listing fails, but surface the
    // failure so hasActiveWork:false is not mistaken for "no tasks".
    activeTasksError = (tasksSettled.reason as Error).message;
  }
  return formatPendingDecisionsPayload(inbox, webOrigin, {
    activeTasks,
    activeTasksError,
    withSessionCard: true,
  });
}

/**
 * Who this session is acting as, in which org, against which backend. Shared
 * by the session-start block on ziggs_inbox and by ziggs_auth_status, which is
 * now only this: a binding check, with no counts.
 */
async function loadSessionBinding(
  creds: Creds,
  cfg: ZiggsMcpConfig,
): Promise<Record<string, unknown>> {
  const claims = decodeOperatorKeyClaims(creds.operatorKey);
  const isDelegate = isMcpOAuthDelegateSession(creds);
  let actingOrgId: string | null = null;
  let actingOrgName: string | null = null;
  let actingOrgKind: string | null = null;
  let connected = false;
  try {
    // Claude OAuth delegates use self-hire access; hosted /
    // fleet impersonation must not hit that route (it lies / throws).
    const access = await fetchSessionAccess(creds);
    actingOrgId = typeof access.orgId === 'string' ? access.orgId : null;
    actingOrgName = typeof access.orgName === 'string' ? access.orgName : null;
    actingOrgKind = typeof access.orgKind === 'string' ? access.orgKind : null;
    connected = access.connected === true;
  } catch {
    // never leak raw fetch/network text into a hint.

  }
  return {
    agentId: creds.agentId,
    ownerId: claims?.ownerId ?? cfg.ZIGGS_OWNER_USER_ID ?? null,
    keyId: claims?.keyId ?? null,
    tokenType: claims?.type ?? 'operator',
    connected,
    actingOrgId,
    actingOrgName,
    actingOrgKind,
    orgId: actingOrgId,
    orgName: actingOrgName,
    orgKind: actingOrgKind,
    orgBindingNote: !connected
      ? isDelegate
        ? 'Not connected — complete MCP OAuth consent first, then re-check actingOrgId here.'
        : 'Not connected — could not resolve this hosted agent session. Check ZIGGS_OPERATOR_KEY / ZIGGS_AGENT_ID.'
      : actingOrgName
        ? isDelegate
          ? `This MCP session acts in **${actingOrgName}** (${actingOrgId}). Runtime org comes from server-side delegate + self-hire — not the OAuth JWT.`
          : `This MCP session acts in **${actingOrgName}** (${actingOrgId}). Runtime org is the hosted agent's home / key workspace.`
        : isDelegate
          ? 'Could not read the workspace name. Retry the live workspace read.'
          : 'Connected but could not resolve acting org name — check the agent home org on the key.',
    apiBase: getBackendUrl(),
    webAppOrigin: resolveWebAppOrigin(cfg.ZIGGS_WEB_URL),
    docs: 'https://ziggsai.com/docs',
    ...sessionOrientation({
      agentId: creds.agentId,
      ownerUserId: claims?.ownerId ?? cfg.ZIGGS_OWNER_USER_ID ?? null,
      surface: 'mcp',
    }),
  };
}

// `ziggs_provision_relay_workers` is gone from the agent surface.
// It was an infrastructure composite (walk the steps, claim or propose a worker
// agreement per step, then POST the coordinator task), not something an agent
// doing a job reaches for, and every agent paid for its 700-char schema in
// every session. Nothing it did is lost: the agreement verbs and
// ziggs_task_create are the same moves, one step at a time. Provisioning a
// whole relay is operator work and belongs on an operator surface.

function registerConnectionTools(
  server: McpServer,
  creds: Creds,
  cfg: ZiggsMcpConfig,
): void {
  // A tool that takes a target name plus a freeform payload is the shape store
  // reviewers reject: nothing in its definition says what it will do or which
  // API it calls, and one annotation cannot cover reads and writes at once.
  // The connection rail is that shape three times over (the named-connector
  // proxy and the brokered-MCP pair), and asking a person for a grant the
  // caller could never use here would be a trap. So on the listed surface (a
  // connected assistant, see ZiggsMcpConfig.directConnection) the rail is the
  // read-only lister and nothing else, while a caller who configured this
  // server with their own operator key keeps it whole. Nothing is lost on the
  // listed side: the rail exists so hosted agents can borrow a person's
  // connection under limits, and an assistant already has its own connectors.
  if (cfg.directConnection) {
    registerCapability(server, connectionProxyCapability, creds);
  }

  registerStrictTool(
    server,
    'ziggs_connection_list',
    {},
    readOnly('List connections you can use'),
    async () => {
      try {
        const connections = await new ConnectionsClient(
          creds.operatorKey,
          creds.agentId,
          undefined,
        ).listForHolder();
        return textResult({ connections });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // Everything below uses or asks for a connection; see the note at the top.
  if (!cfg.directConnection) return;

  // Brokered MCP connections (provider: mcp). Not connection_proxy.
  registerStrictTool(
    server,
    'ziggs_mcp_tools_list',
    {
      connectionId: z
        .string()
        .optional()
        .describe(
          'Connection to inspect. Omit when you hold a grant on exactly one.',
        ),
      grantId: z
        .string()
        .optional()
        .describe('Grant to use. Omit to use the live grant on that connection.'),
    },
    readOnly('List tools on a connected server'),
    async ({ connectionId, grantId }) => {
      try {
        const t = await resolveMcpConnectionTarget(creds, connectionId, grantId);
        const tools = await withMcpGatewayClient(
          creds,
          t.connectionId,
          t.grantId,
          async (c) => {
            const res = await c.listTools();
            return (res.tools ?? []).map((tool) => ({
              name: tool.name,
              description: tool.description ?? null,
            }));
          },
        );
        return textResult({
          connectionId: t.connectionId,
          grantId: t.grantId,
          tools,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_mcp_tool_call',
    {
      tool: z
        .string()
        .describe('Tool name on the connected MCP server, e.g. list_issues.'),
      args: z
        .record(z.unknown())
        .optional()
        .describe("Arguments for that tool, as the server's schema defines them."),
      connectionId: z
        .string()
        .optional()
        .describe(
          'Connection to call through. Omit when you hold a grant on exactly one.',
        ),
      grantId: z
        .string()
        .optional()
        .describe('Grant to use. Omit to use the live grant on that connection.'),
    },
    destructive('Call a tool on a connected server'),
    async ({ tool, args, connectionId, grantId }) => {
      try {
        if (!tool) throw new Error('tool is required');
        const t = await resolveMcpConnectionTarget(creds, connectionId, grantId);
        const result = await withMcpGatewayClient(
          creds,
          t.connectionId,
          t.grantId,
          (c) =>
            c.callTool({
              name: tool,
              arguments: args ?? {},
            }),
        );
        return textResult({
          connectionId: t.connectionId,
          tool,
          result,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerCapability(server, requestConnectionCapability, creds);
}

function inboxFor(creds: Creds): InboxClient {
  return new InboxClient(creds.operatorKey, creds.agentId, undefined, creds.instanceId, {
    clientSessionId: creds.clientSessionId,
    workspaceIds: creds.workspaceIds,
    app: creds.app,
    sessionName: creds.sessionName,
  });
}

/** A get the server refused for reach (403) or existence (404). */
function isReadRefusal(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 403 || status === 404;
}

/**
 * What a write drew on, as every write tool takes it. Loose on purpose, the
 * shape the capability adapter gives an object list: the server checks each
 * entry and says which one is wrong, and a full schema here would repeat that
 * check on six tools in every session.
 */
function sourcesField() {
  return z.array(z.record(z.unknown())).optional().describe(SOURCES_DESCRIPTION);
}

export function registerZiggsTools(
  server: McpServer,
  creds: Creds,
  cfg: ZiggsMcpConfig,
): void {
  // A refused get answers as open would: the server's one judgement of
  // hidden or unreadable, and for unreadable the request to make. When that
  // judgement cannot be had, the original refusal stands (or, for a get that
  // returned nothing at all, hidden).
  const refusedRead = async (
    kind: 'agreement' | 'task',
    id: string,
    cause?: unknown,
  ) => {
    const refusal = await explainRefusedRead(kind, id, {
      creds,
      webUrl: cfg.ZIGGS_WEB_URL,
      surface: 'mcp',
    });
    if (refusal) return refusalError(refusal);
    // No workspace of this connection holds it: the routing guard refused
    // before the read, and the judgement behind it would be refused the same
    // way. Not reachable from here reads as hidden, the same as missing.
    if (
      (cause as { code?: unknown } | undefined)?.code === 'RESOURCE_NOT_ACCESSIBLE'
    ) {
      return refusalError({
        code: 'RESOURCE_HIDDEN',
        message: RESOURCE_HIDDEN_MESSAGE,
        outcome: 'hidden',
        ref: { kind, id },
      });
    }
    return cause
      ? toolError(cause)
      : refusalError({
          code: 'RESOURCE_HIDDEN',
          message: RESOURCE_HIDDEN_MESSAGE,
          outcome: 'hidden',
          ref: { kind, id },
        });
  };

  // A binding check and nothing else. This used to also report the
  // pending/active counts and point at a separate decisions tool for the card,
  // which is how a session start came to cost three calls that each said some
  // of the same thing. The counts moved to the one tool that owns the
  // session start; what is left here is the question this tool alone answers:
  // who am I acting as, in which org, against which backend.
  registerStrictTool(
    server,
    'ziggs_auth_status',
    {},
    readOnly('Check session identity'),
    async () => {
      return textResult({ ok: true, ...(await loadSessionBinding(creds, cfg)) });
    },
  );

  registerStrictTool(
    server,
    'ziggs_org_list',
    {},
    readOnly('List your orgs'),
    async () => {
      try {
        const orgs = await fetchMyOrgs(creds);
        return textResult({ count: orgs.length, orgs });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // The dedicated pending-decisions tool is gone. It was the third tool in the
  // orientation trio and the one that was pure duplication: every decision and
  // active-work row it built comes off the inbox envelope, which ziggs_inbox
  // already fetches. Its whole output — decisions, activeWork and the
  // sessionChatCard — is now what a cold ziggs_inbox returns, so the session
  // start is one call instead of three.

  if (cfg.debugTools) {
    registerStrictTool(
      server,
      'ziggs_smoke_impersonation',
      {},
      readOnly('Debug: check the impersonation path'),
      async () => {
        try {
          const agreements = await getMyAgreements({}, creds);
          const chats = await listMyChats(creds);
          let snapshot: unknown = null;
          const firstChatId = chats[0]?.chatId;
          if (firstChatId) {
            const client = new ContextReadClient(
              creds.operatorKey,
              creds.agentId,
              undefined,
            );
            snapshot = await client.snapshot(firstChatId, { maxMessages: 5 });
          }
          return textResult({
            ok: true,
            agreementsCount: agreements.length,
            chatsCount: chats.length,
            snapshot,
          });
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }
  registerStrictTool(
    server,
    'ziggs_context_snapshot',
    {
      chatId: z.string().optional().describe('Chat id for conversation history'),
      taskId: z.string().optional().describe('Exact task to load bottom-up, without a chat'),
      agreementId: z.string().optional().describe('Exact agreement scope; required if no task or chat is named'),
      artifactId: z.string().optional().describe('Exact triggering artifact to include alongside the work context'),
      maxMessages: z.number().optional().describe('Optional message history cap'),
      contextGrantId: z
        .string()
        .optional()
        .describe('Optional grant id when reading under a context grant'),
    },
    readOnly('Catch up on a chat'),
    async ({ chatId, taskId, agreementId, artifactId, maxMessages, contextGrantId }) => {
      try {
        if (!chatId && !taskId && !agreementId) throw new Error('Name a taskId, agreementId, or chatId');
        // The chat being read IS the lane: a snapshot of someone else's room
        // is a call inside that engagement, and stating it is what lets a hired
        // delegate read the room it was hired into. Falls back to the
        // connection's lane when no chat is named.
        const client = new ContextReadClient(
          creds.operatorKey,
          creds.agentId,
          undefined,
        );
        const result = await client.snapshot(chatId ?? `agrn-${agreementId ?? taskId}`, {
          taskId, agreementId, artifactId,
          maxMessages,
          contextGrantId,
        });
        if (result.workBrief && Array.isArray(result.workBrief.actions)) {
          result.workBrief.actions = presentResourceActions(result.workBrief.actions as ResourceAction[], 'mcp');
        }
        return textResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_agreement_list',
    {
      scope: z
        .enum(['mine', 'reachable'])
        .optional()
        .describe(
          'reachable (default): agreements your grants can read, including hires. mine: only agreements where you are a party.',
        ),
      proposalStatus: z
        .string()
        .optional()
        .describe('Optional filter: pending, approved, rejected, …'),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          'Return only these keys on each row. Omit for the full row. Keep agreementId if you will claim or get next.',
        ),
    },
    readOnly('List your agreements'),
    async ({ scope, proposalStatus, fields }) => {
      try {
        const agreements = await getMyAgreements(
          {
            ...(proposalStatus ? { proposalStatus } : {}),
            partyOnly: scope === 'mine',
          },
          creds,
        );
        const projected = parseListFields(fields);
        return textResult({
          count: agreements.length,
          scope: scope ?? 'reachable',
          agreements: pickListedRows(agreements, projected),
          ...listedFieldNote(agreements, projected),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_agreement_get',
    { agreementId: z.string() },
    readOnly('Read one agreement'),
    async ({ agreementId }) => {
      try {
        const agreement = await getAgreement(agreementId, creds);
        if (!agreement) return refusedRead('agreement', agreementId);
        return textResult({ agreement });
      } catch (e) {
        if (isReadRefusal(e)) return refusedRead('agreement', agreementId, e);
        return toolError(e);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_chat_list',
    {
      fields: z
        .array(z.string())
        .optional()
        .describe(
          'Return only these keys on each row. Omit for the default (chatId, name, updatedAt, lastMessage, unreadCount, participantSummary, readable, requestAccess). Pass members and/or rosterSummary to include the other web-app rosters. Keep chatId if you will open or send next.',
        ),
      participantId: z
        .string()
        .optional()
        .describe('Only rooms this person or agent is in.'),
      readable: z
        .boolean()
        .optional()
        .describe(
          'true: only rooms you can read. false: only rooms you may list but not read, each with the read request to file.',
        ),
    },
    readOnly('List your chats'),
    async ({ fields, participantId, readable }) => {
      try {
        const chats = await listMyChats(creds, {
          ...(participantId?.trim() ? { participantId: participantId.trim() } : {}),
          ...(readable === undefined ? {} : { readable }),
        });
        return textResult({
          count: chats.length,
          chats: projectChatListRows(chats, fields),
          note: 'These are existing rooms, not everyone you can contact. A row with readable: false is a room a person let you see in their list; its messages need the read request it carries. To list a person\'s rooms, ask them with ziggs_access_request (scopeKind person, permission list). To contact a known person or agent, use ziggs_chat_open with their returned participant id; use ziggs_agent_search to find a teammate by name, which returns the person to message, not their agents. The server checks whether contact is allowed. No existing room does not mean contact is forbidden.',
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerCapability(server, openConversationCapability, creds);

  registerStrictTool(
    server,
    'ziggs_chat_send',
    {
      chatId: z
        .string()
        .optional()
        .describe(
          'Room to send in. Omit when using `to`. Explicit chatId wins over `to`.',
        ),
      to: z
        .string()
        .optional()
        .describe(
          'User or agent id of someone you already have a conversation with. Sends in that pair room. Does not open contact — first contact still needs ziggs_chat_open. Ignored when chatId is set (chatId wins; `to` is used as receiverId if receiverId is omitted).',
        ),
      receiverId: z
        .string()
        .optional()
        .describe(
          "Receiver id for the message. Leave it out to write back in this room, and name someone only when you mean them. To name a masked party, pass its `rpb_` ref as it came; do not look it up, wake it, or pay against it. With one other participant, they are the recipient. With several, Jev may select one when confident. Otherwise the message stays in the room with no specific wake. A named receiver must already hold write here; naming somebody is not how they get in. Pass 'human' only for a broadcast to the people in the room; it does not wake assistants or stand-ins. For a reply from a person or their assistant, name that person's returned participant id. This does not grant their assistant access or guarantee a reply.",
        ),
      conversationAgreementId: z.string().optional().describe('The agreement this message is under. Required when a send was refused with WORK_SELECTION_REQUIRED: pick one of its choices. Room history never selects it.'),
      underAgreementId: z.string().optional().describe('The agreement authorizing your run. It follows you across rooms and does not make the recipient your customer.'),
      taskId: z.string().optional().describe('Task being discussed; its agreement determines this message’s work scope.'),
      text: z.string(),
      entryType: z
        .string()
        .optional()
        .describe('Usually "message" for user-visible chat'),
      idempotencyKey: z
        .string()
        .optional()
        .describe(
          'Retry-safe key. Reuse the SAME key when re-sending the SAME logical message (e.g. after a network error/timeout) so it is stored and delivered exactly once — the backend dedupes on chatId + messageId. Use a fresh key (or omit) for a genuinely new message.',
        ),
      sources: sourcesField(),
    },
    destructive('Send a chat message'),
    async ({ chatId, to, receiverId, text, entryType, idempotencyKey, conversationAgreementId, underAgreementId, taskId, sources }) => {
      try {
        const roomId = typeof chatId === 'string' ? chatId.trim() : '';
        const personId = typeof to === 'string' ? to.trim() : '';
        if (!roomId && !personId) {
          throw new Error(
            'Pass chatId of the room, or to naming a person you already have a conversation with. First contact still needs ziggs_chat_open.',
          );
        }
        const result = await sendChatMessage(
          {
            ...(roomId
              ? {
                  chatId: roomId,
                  receiverId: receiverId || personId || undefined,
                }
              : { to: personId, receiverId }),
            text,
            // A stable idempotencyKey maps to a stable messageId so a retried
            // logical send collapses to one row/one delivery (backend
            // dedupe); otherwise each call is a distinct message.
            messageId: idempotencyKey
              ? `mcp_idem_${idempotencyKey}`
              : `mcp_${randomUUID()}`,
            conversationAgreementId,
            underAgreementId,
            taskId,
            entryType: entryType ?? 'message',
            contentType: 'text',
            ...(sources ? { sources: sources as unknown as WriteSource[] } : {}),
          },
          creds,
        );
        // `success: true` was the whole answer, and an agent that had just sent
        // an answer read it as delivered. The presenter names the destination
        // the server resolved — which may not be the one the caller asked for —
        // and keeps accepted, woken and read as three separate facts.
        return textResult({
          ...result,
          ...presentSendResult(result, { creds, surface: 'mcp' }),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // One verb per shape, replacing the propose dispatch table. The direction
  // of work is in the verb name, so no caller reconstructs a providerId
  // permutation to reach the shape it already knew it wanted.
  // A parked formation's response carries the approve URL, so the
  // assistant hands its human the link in the same breath it reports the wait.
  registerCapabilities(server, AGREEMENT_VERB_CAPABILITIES, creds, {
    webUrl: cfg.ZIGGS_WEB_URL,
  });

  // Pause and resume are not on this surface. The array is empty.
  registerCapabilities(server, LISTING_DOOR_CAPABILITIES, creds);

  registerCapability(server, agreementClaimCapability, creds, {
    webUrl: cfg.ZIGGS_WEB_URL,
  });

  registerCapability(server, agreementSubcontractCapability, creds, {
    webUrl: cfg.ZIGGS_WEB_URL,
  });

  // browse rides wherever claim rides. ziggs_agreement_claim is
  // always registered, so the view that produces claimable agreement ids must
  // survive coreOnly too; an agent that can claim but cannot browse holds a
  // default pathway it cannot begin.
  registerCapability(server, marketplaceViewCapability, creds);

  registerStrictTool(
    server,
    'ziggs_agreement_respond',
    {
      agreementId: z.string(),
      action: z.enum(['approve', 'reject']),
      mandateAgreementId: z
        .string()
        .optional()
        .describe('The hire you act under, when its setting lets you answer without a person.'),
    },
    destructive('Approve or reject a proposal'),
    async ({ agreementId, action, mandateAgreementId }) => {
      try {
        const claims = decodeOperatorKeyClaims(creds.operatorKey);
        const ownerId = claims?.ownerId ?? cfg.ZIGGS_OWNER_USER_ID;
        const updated = await respondToAgreement(agreementId, action, creds, {
          ownerUserId: ownerId,
          ...(mandateAgreementId ? { mandateAgreementId } : {}),
          // So a refusal can name where the human goes, not just why.
          appUrl: agreementAppUrl(resolveWebAppOrigin(cfg.ZIGGS_WEB_URL), agreementId),
        });
        return textResult({ agreement: updated });
      } catch (e) {
        return toolError(e);
      }
    },
  );


  registerStrictTool(

    server,
    'ziggs_agreement_revoke',
    {
      agreementId: z.string().describe('Agreement to revoke'),
    },
    destructive('Revoke an agreement'),
    async ({ agreementId }) => {
      try {
        const result = await revokeAgreement(agreementId, creds);
        const isLink = result.agreement?.engagementKind === 'link';
        return textResult({
          status: 'revoked',
          agreementId,
          ...(isLink
            ? { note: 'Link revoked — unpublished cross-org reach to this peer is blocked again.' }
            : {}),
          agreement: result.agreement,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_agreement_counter',
    {
      agreementId: z.string().describe('The pending agreement to counter'),
      price: z
        .number()
        .optional()
        .describe('Revised price in POINTS, as an integer of hundredths — 500 means ϟ5.00 (see ziggs_agreement_buy).'),
      agreementDescription: z
        .string()
        .optional()
        .describe('Revised agreement description / terms'),
      expiresAt: z.string().optional().describe(AGREEMENT_TERMS_PARAMS.expiresAt.description ?? 'Revised expiry (ISO-8601)'),
      lifecycle: z
        .enum(AGREEMENT_TERMS_PARAMS.lifecycle.enum as ['open', 'time-bound', 'count-bound'])
        .optional()
        .describe(AGREEMENT_TERMS_PARAMS.lifecycle.description ?? ''),
      maxExecutions: z.number().optional().describe(AGREEMENT_TERMS_PARAMS.maxExecutions.description ?? ''),
      interactionMode: z
        .enum(AGREEMENT_TERMS_PARAMS.interactionMode.enum as ['messages', 'tasks', 'both'])
        .optional()
        .describe(AGREEMENT_TERMS_PARAMS.interactionMode.description ?? ''),
      conversationAllowance: z
        .number()
        .optional()
        .describe(AGREEMENT_TERMS_PARAMS.conversationAllowance.description ?? ''),
      description: z
        .string()
        .optional()
        .describe('Revised task description for the spawned work'),
      sources: sourcesField(),
    },
    destructive('Counter a proposal'),
    async ({ agreementId, sources, ...counter }) => {
      try {
        const agreement = await counterAgreement(
          agreementId,
          {
            ...counter,
            ...(sources ? { sources: sources as unknown as WriteSource[] } : {}),
          },
          creds,
        );
        return textResult({ status: 'countered', agreementId, agreement });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_agreement_fulfill',
    {
      agreementId: z.string().describe('The agreement you provide, to mark fulfilled'),
    },
    destructive('Close an agreement you provide'),
    async ({ agreementId }) => {
      try {
        const result = await fulfillAgreement(agreementId, creds);
        return textResult({ status: 'fulfilled', agreementId, agreement: result.agreement });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  if (decodeOperatorKeyClaims(creds.operatorKey)?.connectionClientId) {
    registerStrictTool(server, 'ziggs_notification_status', {
      orgId: z.string().min(1).max(200).describe('Workspace ID.'),
    }, readOnly('Notification status'), async ({ orgId }) => {
      try { return textResult(await new AssistantConnectionClient(creds).eventStatus(orgId)); }
      catch (error) { return toolError(error); }
    });
  }

  registerStrictTool(
    server,
    'ziggs_inbox_changes',
    {
      cursor: z.string().optional().describe('Observation cursor; reads renew it for 24h. Omit or restart on 410 to scan retained history. Never ack it.'),
      waitSeconds: z.number().min(0).optional().describe('Wait up to 110 seconds for an unobserved delivery; use 55 during an active session.'),
    },
    readOnly('Read new inbox arrivals'),
    async ({ cursor, waitSeconds }) => {
      try { return textResult(await inboxFor(creds).getChanges({ cursor, waitSeconds })); }
      catch (error) { return toolError(error); }
    },
  );

  // Not on the directory allow-list: reviewed ChatGPT/Claude/Cursor
  // connectors stay unchanged. Hosted CLI and Claude Code still register them.
  registerStrictTool(
    server,
    'ziggs_session_list',
    {},
    readOnly('List sibling windows of this assistant'),
    async () => {
      try {
        const sessions = await new SessionsClient(creds).list();
        return textResult({ sessions });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_session_hold',
    {
      chatId: z
        .string()
        .min(1)
        .describe('Chat to hold in this window. Taken off any sibling that held it.'),
    },
    write('Hold a chat in this window'),
    async ({ chatId }) => {
      try {
        const result = await new SessionsClient(creds).hold(chatId);
        return textResult(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_inbox_peek',
    {
      waitSeconds: z
        .number()
        .optional()
        .describe(
          'Hold up to this many seconds (the server clamps a hold at about 110) and return as soon as assigned mail exists. Omit for an immediate count. Still does not take the lease. To wait for a reply your person asked about, call ziggs_inbox with waitSeconds: 55 instead, since only the full read returns the mail.',
        ),
    },
    readOnly('Peek inbox count without taking the mailbox'),
    async ({ waitSeconds }) => {
      try {
        const client = inboxFor(creds);
        const [bindingSettled, readsSettled, peekSettled] =
          await Promise.allSettled([
            loadSessionBinding(creds, cfg),
            loadSessionReads(creds),
            client.peek(waitSeconds != null ? { waitSeconds } : {}),
          ]);
        const session =
          bindingSettled.status === 'fulfilled'
            ? bindingSettled.value
            : {
                connected: false,
                bindingFetchError:
                  'Could not resolve the session binding — call ziggs_auth_status for the diagnosis.',
              };
        const peek =
          peekSettled.status === 'fulfilled' ? peekSettled.value : undefined;
        const peekFetchError =
          peekSettled.status === 'rejected'
            ? (peekSettled.reason as Error).message
            : undefined;
        if (readsSettled.status === 'rejected') {
          return textResult({
            peek,
            session,
            ...(peekFetchError ? { peekFetchError } : {}),
            sessionActionsFetchError: (readsSettled.reason as Error).message,
          });
        }
        const asOf = peek?.asOf ?? new Date().toISOString();
        const emptyInbox: InboxEnvelope = {
          asOf,
          deliveries: [],
          deliveriesCapped: false,
          chats: [],
          ackTo: null,
          tasksAwaitingMe: [],
          truncatedTasks: 0,
          proposalsAwaitingMe: [],
          truncatedProposals: 0,
          connectionRequestsAwaitingMe: [],
          truncatedConnectionRequests: 0,
          openRequestsAwaitingMe: [],
        };
        const actions = buildSessionActions(
          emptyInbox,
          readsSettled.value,
          creds,
          cfg,
        );
        return textResult({
          peek,
          session,
          ...(peekFetchError ? { peekFetchError } : {}),
          ...actions,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_inbox',
    {
      waitSeconds: z
        .number()
        .optional()
        .describe(
          'Long-poll: hold up to this many seconds (the server clamps a hold at about 110) and return as soon as something new arrives, no busy re-polling. Pass it and the answer is only what is new. Omit it and the call is the session start, which is large. When your person asked you to wait for a reply, pass 55 and call again until it arrives or ten minutes have passed.',
        ),
    },
    readOnly('Read your inbox'),
    async ({ waitSeconds }) => {
      try {
        // Unset on stdio: that process IS the host, and a scheduler that
        // respawns it per run pins ZIGGS_INSTANCE_ID instead.
        const client = inboxFor(creds);
        // A cold call is the session start, and its extra reads — the binding
        // and the active-task rows — take nothing from the envelope. Started
        // here, they ride the same wave as the inbox fetch
        // instead of a second one after it. `allSettled` up front so a failure
        // in either is carried, not thrown into a promise nobody is awaiting
        // yet: `getInbox` can still reject between this line and the await.
        const sessionStart =
          waitSeconds == null
            ? Promise.allSettled([
                loadSessionBinding(creds, cfg),
                loadSessionReads(creds),
              ])
            : null;
        const inbox = await (isDirectorySurface(server) ? client.getSnapshot.bind(client) : client.getInbox.bind(client))(
          waitSeconds != null ? { waitSeconds } : {},
        );
        // #2+#3: activeWorkCount comes from inbox.tasksAwaitingMe
        // (formatInboxToolResult omits listTasks). Grant walk is only for
        // readPlan pinning and is unused when deliveries is empty — the idle
        // long-poll outcome — so skip it there (artifact grants grow unbounded).
        let reach: GrantView[] = [];
        if ((inbox.deliveries?.length ?? 0) > 0) {
          try {
            // tag each scope with the covering grant from the caller's
            // own held context grants. Best-effort — the inbox still works
            // untagged. All pages of live grants only (GET /grants also returns
            // expired/revoked and paginates).
            reach = await new GrantsClient(
              creds.operatorKey,
              creds.agentId,
              undefined,
            ).listAllGrants({
              // Every context scope kind — a literal subset here is how the CLI
              // silently dropped a whole kind when `artifact` was added.
              scopeKind: [...CONTEXT_GRANT_SCOPE_KINDS],
              health: 'active',
            });
          } catch {
            // omit grant tags when the grants read fails
          }
        }
        const news = formatInboxToolResult(
          inbox,
          null,
          cfg.ZIGGS_WEB_URL,
          undefined,
          reach,
          undefined,
          { agentId: creds.agentId, ownerUserId: ownerPrincipalId(creds, cfg) },
        );
        // Whose rows are whose, so the deliveries come back grouped.
        const reader = { agentIds: [creds.agentId], personId: ownerPrincipalId(creds, cfg) };
        // A long-poll is a continuation of a session that already oriented
        // itself, so it returns news only. A cold call is the session start, and
        // carries what the other two orientation tools used to each be called
        // for: the binding, the decisions, and the card.
        if (waitSeconds != null) return compactTextResult(news, reader);

        const [bindingSettled, readsSettled] = await sessionStart!;
        const session =
          bindingSettled.status === 'fulfilled'
            ? bindingSettled.value
            : {
                connected: false,
                bindingFetchError:
                  'Could not resolve the session binding — call ziggs_auth_status for the diagnosis.',
              };
        if (readsSettled.status === 'rejected') {
          // The news is still worth returning; say the session block is missing
          // rather than letting its absence read as "nothing is waiting".
          return compactTextResult({
            ...news,
            session,
            sessionActionsFetchError: (readsSettled.reason as Error).message,
          }, reader);
        }
        const actions = buildSessionActions(
          inbox,
          readsSettled.value,
          creds,
          cfg,
        );
        // No prose list of next actions rides here: the calls are in
        // `readPlan`, the human cues sit on the `decisions` and `activeWork`
        // rows, and how to present them is said once, on connect.
        const note = windowNote(
          news.deliveries,
          [creds.agentId],
        );
        return compactTextResult({
          ...news,
          session,
          ...actions,
          // A directory host may never show the model the server's
          // instructions; the session-start read is the one place it looks.
          ...(isDirectorySurface(server) ? { rules: sessionRules('directory') } : {}),
          ...(note && typeof actions.notice === 'string'
            ? { notice: `${actions.notice} ${note}` }
            : {}),
        }, reader);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // The inbox as a card a host can draw (MCP Apps). Same snapshot read and
  // the same session block as a cold ziggs_inbox, without its news: what is
  // waiting on the person and the work in hand, for the person to see.
  registerStrictTool(
    server,
    'ziggs_inbox_show',
    {},
    readOnly("Show what's waiting on you"),
    async () => {
      try {
        const [inbox, reads] = await Promise.all([
          inboxFor(creds).getSnapshot({}),
          loadSessionReads(creds),
        ]);
        return inboxCardResult(buildSessionActions(inbox, reads, creds, cfg));
      } catch (e) {
        return toolError(e);
      }
    },
    INBOX_CARD_TOOL_META,
  );
  registerInboxCardResource(server);

  /**
   * The ack, split out of the read.
   *
   * It used to be a parameter on `ziggs_inbox`, which is annotated read-only —
   * so the one call that moves the watermark and can bury a delivery presented
   * to a host as a harmless read, and hosts skip their confirmation for those.
   * The catalog already splits read and write into two dispatchers for exactly
   * this reason; the native inbox tool was contradicting its own surface.
   *
   * The split is only in the annotation and the name. Same client call, same
   * refusals, same opaque token — and a plain read still takes or renews the
   * host lease without asking anybody anything, which is the constraint this
   * had to keep: an assistant polling while its person waits cannot be stopped
   * for a permission prompt on every poll.
   */
  if (isDirectorySurface(server)) {
    registerStrictTool(server, 'ziggs_inbox_claim',
      {}, destructive('Claim the inbox for this worker'), async () => {
        try {
          const client = inboxFor(creds);
          const inbox = await client.getInbox() as { deliveries?: unknown };
          const deliveryCount = Array.isArray(inbox.deliveries) ? inbox.deliveries.length : 0;
          return textResult({ claimed: true, deliveryCount });
        } catch (e) { return toolError(e); }
      });
    // Only a connection key has a roster to synchronize. A device-boarded key
    // names one assistant in one workspace, so listing the tool for it would
    // offer an operation that can never succeed.
    if (decodeOperatorKeyClaims(creds.operatorKey)?.connectionClientId)
      registerStrictTool(server, 'ziggs_workspace_sync',
        {}, destructive('Synchronize assistant workspace access'), async () =>
          toolError('Workspace synchronization runs through the assistant connection; this session has no connection roster.'));
  }

  registerStrictTool(
    server,
    'ziggs_inbox_defer',
    {
      agreementId: z
        .string()
        .describe(
          'Agreement id of the pending decision to hide from the top of the inbox. Nothing is approved or rejected. It returns to the top when the decision changes, or when it is less than a day from expiring.',
        ),
    },
    destructive('Hide a pending decision from the inbox'),
    async ({ agreementId }) => {
      try {
        const client = inboxFor(creds);
        return textResult(await client.park(agreementId));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_inbox_ack',
    {
      ack: z
        .string()
        .describe(
          "An `ackTo` from a previous ziggs_inbox call, passed back VERBATIM: the envelope's for the whole window, or a delivery row's own to stop early at that row. Opaque and monotonic (an older value is a no-op).",
        ),
      handledDeliveryIds: z.array(z.string()).optional().describe('Exact responsibilityIds you handled. Resource IDs cannot settle these assignments.'),

    },
    destructive('Acknowledge inbox deliveries'),
    async ({ ack, handledDeliveryIds }) => {
      try {
        // Same host identity as the read: acking renews an owner, and only a
        // read acquires one.
        const client = inboxFor(creds);
        const acked = await client.ackOrTakeHost(ack, {
          handledDeliveryIds,
        });
        return textResult({ acked });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerCapabilities(server, GRANTS_CAPABILITIES, creds);
  registerCapability(server, contextExpandReachCapability, creds);
  registerCapability(server, contextDiscoverGrantableCapability, creds);
  registerCapability(server, openCapability, creds);
  registerCapability(server, accessExplainCapability, creds);

  // The read-plan is MCP-local decoration (its next-call tool names and the
  // inbox loop it feeds are this surface's); schema + handler stay shared.
  registerCapability(server, contextReadCapability, creds, {
    transformResult: (result, args) => {
      const readPlan = buildReadContextReadPlan(
        result as Parameters<typeof buildReadContextReadPlan>[0],
        args['type'] as ContextReadType,
        args['via'] as string,
        args['contextGrantId'] as string | undefined,
      );
      return readPlan.length
        ? { ...(result as Record<string, unknown>), readPlan }
        : result;
    },
  });

  // descriptions.mcp is canonical — do not override. Shared protocol
  // paragraphs stay on connect instructions, not this description.
  registerCapability(server, recordArtifactCapability, creds);

  // find what you recorded free-standing, and hand one artifact to one
  // agent. Descriptions come from the shared capability (no PROTOCOL override
  // needed; neither is a reporting surface).
  registerCapability(server, listArtifactsCapability, creds);
  // The search an agent reaches for when the work refers to something it did
  // not write. Separate from the listing because it answers a different
  // question and carries its own honesty: what it searched, and what it could
  // not.
  registerCapability(server, findArtifactsCapability, creds);
  registerCapability(server, shareArtifactCapability, creds);
  registerCapability(server, attachArtifactCapability, creds);
  registerCapability(server, uploadArtifactUrlCapability, creds);
  registerCapability(server, completeArtifactFileCapability, creds);
  registerCapability(server, downloadArtifactCapability, creds);
  // `ziggs_artifact_reextract` is gone from the agent surface.
  // Re-running text extraction over a stored file is a repair operation on our
  // storage, not an agent intent: the extraction already runs on upload, and an
  // agent that reads a stale extract has no way to know it is stale. It belongs
  // on an operator surface, where whoever noticed the bad extract is standing.

  // ---------------------------------------------------------------------------
  // Task mutation tools
  // ---------------------------------------------------------------------------

  registerStrictTool(
    server,
    'ziggs_task_create',
    {
      agreementId: z.string().describe('Agreement this task belongs to'),
      description: z.string().describe('What the task entails'),
      title: z
        .string()
        .max(80)
        .optional()
        .describe(
          'Short list label, around 60 characters. Set it when this is one of many tasks; otherwise the list shows the description.',
        ),
      parentTaskId: z.string().optional().describe('Parent task id for sub-tasks'),
      assigneeId: z
        .string()
        .optional()
        .describe(
          'Agent or user to assign it to; they must already hold a grant on the agreement.',
        ),
      inputArtifactIds: z
        .array(z.string())
        .optional()
        .describe(
          'Artifact ids this task consumes as structured inputs — pass prior-step output handles without embedding them in description',
        ),
      waitsOn: z
        .array(z.string())
        .optional()
        .describe(
          'Task ids to wait for: created now, but its assignee is not woken until all of them end, in any state. States a join up front instead of polling. Name only tasks you can read.',
        ),
      closesBy: z
        .enum(['result', 'children'])
        .optional()
        .describe(
          'How this task closes, fixed now. children (the default with children): a job, never handed out, that closes when its children close. result (the default otherwise): closes by its own result.',
        ),
      children: z
        .array(
          z.object({
            name: z.string().min(1).max(200),
            agreementId: z.string(),
            description: z.string().min(1),
            title: z.string().max(80).optional(),
            assigneeId: z.string().optional(),
            waitsOn: z.array(z.string()).optional(),
            joinKind: z.enum(['all', 'any']).optional(),
            runIf: z
              .string()
              .min(1)
              .max(500)
              .optional()
              .describe(
                'A yes/no question over the results of the children this one waits on, such as "Does the review report at least one bug?". On yes it runs; on no it is skipped, and children waiting on it go ahead. When the answer is unclear it waits for the buyer. Needs waitsOn.',
              ),
            inputArtifactIds: z.array(z.string()).optional(),
          }),
        )
        .min(1)
        .max(100)
        .optional()
        .describe(
          'Children created with this task, all or none; waitsOn names sibling names, and the answer maps each name to its task id. Children that wait on nothing get this task\'s inputArtifactIds. before_execution holds every child until the plan is acknowledged.',
        ),
      // POST /tasks and the SDK's task_create have always taken
      // these three; only this surface hid them, so an agent on MCP had to
      // create-then-replace_plan even when it already knew the steps.
      plan: z
        .object({
          steps: z
            .array(
              z.object({
                // server mints step-<n> / array-index order when omitted.
                stepId: z
                  .string()
                  .optional()
                  .describe(
                    'Stable id for this step. Omit to let the server assign step-<n>.',
                  ),
                description: z
                  .string()
                  .describe('What this step does, in one line — required and non-blank'),
                order: z
                  .number()
                  .int()
                  .optional()
                  .describe('Position in the plan. Omit to use the array index.'),
              }),
            )
            .describe('Ordered steps the task starts with'),
        })
        .optional()
        .describe('The plan the task is born with. Omit to start without one.'),
      planReviewTiming: z
        .enum(['with_proposal', 'before_execution'])
        .optional()
        .describe(
          'When the buyer reviews the plan. with_proposal (default) — approving the agreement covers it. before_execution — the task cannot start until the plan is acknowledged.',
        ),
      requireMidWorkPlanAck: z
        .boolean()
        .optional()
        .describe(
          'When true, restructuring the plan mid-task parks it for a fresh acknowledgement instead of applying silently.',
        ),
      // For work that means chasing an answer out of somebody.
      // Nothing on the server makes the holder keep to these yet, so the
      // wording here is the contract: it is what the holder reads.
      dueAt: z
        .string()
        .optional()
        .describe(
          'Deadline, ISO 8601 (e.g. 2026-09-12T17:00:00Z). Whoever holds this task posts what it has and where it is stuck at the deadline, in the room where the question was asked, and then stops. A deadline already past is refused.',
        ),
      checkBack: z
        .object({
          everyMinutes: z
            .number()
            .int()
            .min(5)
            .describe(
              'Minimum minutes between two reminders to the same person. A floor, not a schedule — reminding later is fine, sooner is not.',
            ),
          maxReminders: z
            .number()
            .int()
            .min(1)
            .max(20)
            .describe(
              'Total reminders allowed per person asked, after the first ask. Then the holder stops and reports.',
            ),
        })
        .optional()
        .describe(
          'How often the holder may remind and how many times at most; both are required. Omit for a task nobody needs reminding about.',
        ),
      sources: sourcesField(),
    },
    write('Create a task'),
    async ({
      agreementId,
      description,
      title,
      parentTaskId,
      assigneeId,
      inputArtifactIds,
      waitsOn,
      closesBy,
      children,
      plan,
      planReviewTiming,
      requireMidWorkPlanAck,
      dueAt,
      checkBack,
      sources,
    }) => {
      try {
        const task = await createTask(
          {
            ...(sources ? { sources: sources as unknown as WriteSource[] } : {}),
            agreementId,
            description,
            title,
            parentTaskId,
            assigneeId,
            inputArtifactIds,
            waitsOn,
            closesBy,
            children,
            plan,
            planReviewTiming,
            requireMidWorkPlanAck,
            dueAt,
            checkBack,
          },
          creds,
        );
        return textResult({ ok: true, task });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_task_set_result',
    {
      taskId: z.string(),
      // Cancelling has its own tool, ziggs_task_cancel.
      state: z.enum(['completed', 'failed']),
      result: z
        .object({
          summary: z.string().optional(),
          status: z.string().optional(),
          links: z.array(z.string()).optional(),
        })
        .passthrough()
        .optional()
        .describe('Outcome payload (summary, status, links, …)'),
      errorMessage: z.string().optional().describe('Required when state=failed'),
      idempotencyKey: z
        .string()
        .optional()
        .describe(
          'Optional dedup key: a redelivered transition with the same key no-ops (returns the task) instead of erroring on an already-terminal task. Derive it deterministically (e.g. from taskId + target state) so a crash-replay reproduces it.',
        ),
      sources: sourcesField(),
    },
    destructive('File a task result'),
    async ({ taskId, state, result, errorMessage, idempotencyKey, sources }) => {
      try {
        const confirm = await updateTaskState(
          taskId,
          state as TaskState,
          {
            result,
            errorMessage,
            idempotencyKey,
            ...(sources ? { sources: sources as unknown as WriteSource[] } : {}),
          },
          creds,
        );
        // The confirmation said `completed` and left delivery,
        // metering and the agreement to be inferred from it. The presenter
        // states each one from what the server reported, and stays silent about
        // the ones it did not.
        return textResult({
          ...confirm,
          ...presentTaskOutcome(confirm, { creds, surface: 'mcp' }),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_task_replace_plan',
    {
      taskId: z.string(),
      steps: z
        .array(
          z.object({
            // server mints step-<n> / array-index order when omitted.
            stepId: z
              .string()
              .optional()
              .describe(
                'Stable id for this step. Omit to let the server assign step-<n>.',
              ),
            description: z.string(),
            order: z
              .number()
              .int()
              .optional()
              .describe('Position in the plan. Omit to use the array index.'),
            // Progress on the step, not in the description string.
            status: z
              .enum(['pending', 'in_progress', 'completed', 'skipped'])
              .optional()
              .describe(
                'Step progress. Omit for pending. Mark completed/in_progress as you work so finishing the task leaves finished steps finished.',
              ),
            result: z
              .unknown()
              .optional()
              .describe('Optional step output stored with this replace.'),
            sources: sourcesField(),
          }),
        )
        .describe('Full replacement step list (ordered)'),
    },
    destructive('Update a task plan'),
    async ({ taskId, steps }) => {
      try {
        const confirm = await replaceTaskPlan(taskId, steps as PlanReplaceStep[], creds);
        return textResult(confirm);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_task_update_steps',
    {
      taskId: z.string(),
      steps: z
        .array(
          z.object({
            stepId: z.string().describe('Stable id of an existing plan step.'),
            status: z
              .enum(['pending', 'in_progress', 'completed', 'skipped'])
              .describe('Step progress. Mark completed/in_progress as you work.'),
            result: z
              .unknown()
              .optional()
              .describe('Optional step output stored with this patch.'),
            sources: sourcesField(),
          }),
        )
        .optional()
        .describe('The steps that changed. Do not resend the rest of the plan. Omit it only when this call is nothing but a waitingOn.'),
      waitingOn: z
        .object({
          kind: z.enum(['user', 'agent']).describe('Whether the answer has to come from a person or an agent.'),
          id: z.string().describe('Who you asked.'),
        })
        .nullable()
        .optional()
        .describe(
          'Who this task now waits on, because you just asked them. Send it with the progress you post when you ask — or on its own, with no steps, for an ask that produced no other progress. Your person sees the task as waiting on them instead of as running, which is the difference between a job that looks stalled and one that is waiting for an answer. It clears itself: any later progress write that does not restate it, and any terminal state, drops it, because a holder that did something else after asking is no longer waiting. Send null to clear it yourself.',
        ),
    },
    destructive('Update named task plan steps'),
    async ({ taskId, steps, waitingOn }) => {
      try {
        const named = (steps ?? []) as PlanStepPatch[];
        if (named.length === 0 && waitingOn === undefined) {
          throw new Error(
            'Name the steps that changed, or pass waitingOn on its own when the ask produced no other progress.',
          );
        }
        const confirm = await updateTaskPlanSteps(
          taskId,
          named,
          creds,
          waitingOn as { kind: 'user' | 'agent'; id: string } | null | undefined,
        );
        return textResult(confirm);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerStrictTool(
    server,
    'ziggs_task_acknowledge_control',
    { taskId: z.string(), requestId: z.string().uuid(), supported: z.boolean() },
    destructive('Acknowledge task execution control'),
    async ({ taskId, requestId, supported }) => {
      try { return textResult(await acknowledgeTaskControl(taskId, requestId, supported, creds)); }
      catch (error) { return toolError(error); }
    },
  );

  registerCapability(server, listTasksCapability, creds);
  registerCapability(server, cancelTaskCapability, creds);

  registerStrictTool(
    server,
    'ziggs_task_get',
    { taskId: z.string() },
    readOnly('Read one task'),
    async ({ taskId }) => {
      try {
        const task = await getTask(taskId, creds);
        if (!task) return refusedRead('task', taskId);
        return textResult({ task });
      } catch (e) {
        if (isReadRefusal(e)) return refusedRead('task', taskId, e);
        return toolError(e);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Connection proxy
  // ---------------------------------------------------------------------------

  if (!cfg.coreOnly) {
    registerConnectionTools(server, creds, cfg);
  }

  registerTrustTools(server, creds, cfg);
  if (!cfg.coreOnly) {
    registerPaymentTools(server, creds);
  }
}
