import { isContextAccessRequest } from '../shared/contextAccessRequest.js';
import { presentResourceActions } from './resourceActions.js';
import {
  ContextReadClient,
  CONTEXT_READ_TYPES,
  CONTEXT_READ_VIA,
  parseVia,
  viaHint,
  type ContextReadType,
} from '../http/ContextReadClient.js';
import { ContextOpenClient, type ContextOpenBody } from '../http/ContextOpenClient.js';
import {
  ContextGrantsClient,
  type ContextGrantScopeKind,
  type ContextTemporal,
} from '../http/ContextGrantsClient.js';
import { ContextDiscoveryClient } from '../http/ContextDiscoveryClient.js';
import {
  grantCaveat,
  CONTEXT_GRANT_SCOPE_KINDS,
  type GrantView,
} from '../http/grants.js';
import { fetchMyOrgs, resolveOrgSelector } from '../http/OrgsClient.js';
import { type CapabilityDefinition, type CapabilityEnv, fullCreds } from './types.js';

// `artifact` joined the context rail. Delegating an artifact grant
// onward works (same kind, same id — an exact re-grant); narrowing a container
// grant DOWN to an artifact inside it is deliberately not supported yet.
const GRANT_SCOPE_KINDS = CONTEXT_GRANT_SCOPE_KINDS;
const CONTEXT_TEMPORALS = ['from-now', 'from-start'] as const;

/**
 * Human/LLM-readable bounds for a context grant. folded a context
 * grant's temporal mode + read watermark into the canonical `caveats` array,
 * so pull them back out here to keep the `bounds` summary stable.
 */
export function contextBounds(grant: GrantView): Record<string, unknown> {
  return {
    temporal: grantCaveat(grant, 'temporal'),
    watermarkAt: grantCaveat(grant, 'watermark_at'),
    expiresAt: grant.expiresAt,
  };
}

/**
 * #6 — org-scoped grants may name the org instead of pasting its
 * opaque org_.. id: exact id or case-insensitive name against the operator's
 * memberships. Ambiguous names throw with the candidate list rather than
 * guessing; a name that matched nothing throws with a pointer to the org
 * lister. An org_.. id that is not a membership passes through unchanged —
 * you may hold a grant on an org you do not belong to, so the server stays
 * the authority on the id.
 */
export async function resolveOrgScopeId(env: CapabilityEnv, scopeId: string): Promise<string> {
  const resolution = resolveOrgSelector(await fetchMyOrgs(fullCreds(env), env.baseUrl), scopeId);
  if (resolution.status === 'ok') return resolution.orgId;
  if (resolution.status === 'ambiguous') {
    throw new Error(
      `Org name "${scopeId}" matches ${resolution.matches.length} of your orgs — pass the org id: ` +
        resolution.matches.map((m) => `${m.name} (${m.orgId})`).join(', '),
    );
  }
  if (scopeId.startsWith('org_')) return scopeId;
  const lister = env.surface === 'mcp' ? 'ziggs_org_list' : 'your org list';
  throw new Error(
    `No org named "${scopeId}" in your memberships — use ${lister} to see them, or pass the org id.`,
  );
}

/**
 * Which `via` each read type accepts, rendered for the tool text. Generated from
 * CONTEXT_READ_VIA so the pairing an agent is told about and the pairing the
 * call actually accepts are one statement — the prose that used to enumerate
 * these by hand had already drifted from the server's list.
 */
const VIA_BY_TYPE = CONTEXT_READ_TYPES.map(
  (t) => `${t} via ${viaHint(t)}`,
).join('; ');

/**
 * The one fact about `artifact:<id>` that both surfaces must state: it is how you
 * reach an artifact no container can return. Shared for the same reason the
 * pairings above are generated — hand-copied prose is what drifted.
 */
const ARTIFACT_VIA_NOTE =
  'via=artifact:<id> is a point read of one named artifact and the ONLY way to ' +
  'read one attached to no chat, agreement or task';

export const contextReadCapability: CapabilityDefinition = {
  key: 'context_read',
  names: { sdk: 'context_read', mcp: 'ziggs_context_read' },
  title: 'Read context you hold',
  descriptions: {
    sdk: `Read the contents of a scope you already hold a grant for: ${CONTEXT_READ_TYPES.join(' | ')}. Each type reads through its own entries — ${VIA_BY_TYPE}. Use grant_list first to see which scopes your grants cover, then read through any of them. ${ARTIFACT_VIA_NOTE}. Cursored; all access is grant-fenced server-side.`,
  },
  annotation: 'read-only',
  params: {
    type: {
      type: 'string',
      required: true,
      enum: CONTEXT_READ_TYPES,
      description: 'Resource type to read from the scope',
    },
    via: {
      type: 'string',
      required: true,
      description: `Scope entry you hold, as <kind>:<id>. Accepted per type — ${VIA_BY_TYPE}.`,
    },
    agreementId: { type: 'string', description: 'Filter message history to this exact work agreement. Use cursor pagination to expand a wake packet.' },
    cursor: { type: 'string', description: 'Opaque cursor from a prior nextCursor to page' },
    after: { type: 'string', description: 'ISO timestamp for forward-delta (messages/artifacts)' },
    direction: {
      type: 'string',
      enum: ['forward', 'backward'],
      description: 'Use "forward" with after for a message forward-delta; "backward" starts a newest-first artifact inventory',
    },
    limit: { type: 'number', description: 'Page size (server default when omitted)' },
    state: { type: 'string', description: 'Task state filter (tasks only)' },
    contextGrantId: {
      type: 'string',
      description: 'Pin a specific grant when you hold several over the same scope',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const type = args['type'] as ContextReadType;
    if (!CONTEXT_READ_TYPES.includes(type)) {
      throw new Error(`type must be one of ${CONTEXT_READ_TYPES.join(', ')}`);
    }
    const via = args['via'] as string;
    if (!via) throw new Error('via is required');
    // Same verdict the server gives, given at the call site so the reason
    // arrives with the mistake. Never a softer one: a client that "fixes" an
    // argument the server would reject is a second answer to one call.
    const parsed = parseVia(via);
    if (!parsed) {
      throw new Error(
        `via must be <kind>:<id> — one of ${viaHint(type)} for type=${type}`,
      );
    }
    if (!CONTEXT_READ_VIA[type].includes(parsed.kind)) {
      throw new Error(
        `${type} reads accept via=${viaHint(type)} — not ${parsed.kind}:<id>`,
      );
    }
    const direction = args['direction'] as string | undefined;
    if (direction !== undefined && direction !== 'forward' && direction !== 'backward') {
      throw new Error('direction must be "forward" or "backward"');
    }
    return new ContextReadClient(creds.operatorKey, creds.agentId, undefined).read(type, {
      via,
      agreementId: args['agreementId'] as string | undefined,
      cursor: args['cursor'] as string | undefined,
      after: args['after'] as string | undefined,
      direction: direction as 'forward' | 'backward' | undefined,
      limit: typeof args['limit'] === 'number' ? (args['limit'] as number) : undefined,
      state: args['state'] as string | undefined,
      contextGrantId: args['contextGrantId'] as string | undefined,
    });
  },
};

export const contextExpandReachCapability: CapabilityDefinition = {
  key: 'context_expand_reach',
  names: { sdk: 'context_expand_reach', mcp: 'ziggs_context_expand_reach' },
  title: 'See what a grant reaches',
  descriptions: {
    sdk: 'Expand a grant you hold into the chat/agreement ids listed inside a broader scope (ids + labels only, no content). A chat grant returns its chat. Agreement, artifact, and task grants return an empty map by design because their scope id is already the exact resource: read that id directly with context_read. In particular, an agreement grant never opens linked chats. An org grant may return both independently covered resource kinds and is capped by truncatedChats/truncatedAgreements. Holder-only, grant-fenced.',
  },
  annotation: 'read-only',
  params: {
    grantId: {
      type: 'string',
      required: true,
      description: 'A grant you hold (grantId from the grant lister) to expand',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const grantId = args['grantId'] as string;
    if (!grantId) throw new Error('grantId is required');
    return new ContextGrantsClient(creds.operatorKey, creds.agentId).getReach(grantId);
  },
};

export const contextDiscoverGrantableCapability: CapabilityDefinition = {
  key: 'context_discover_grantable',
  names: { sdk: 'context_discover_grantable', mcp: 'ziggs_context_discover_grantable' },
  title: 'Find context you cannot read yet',
  descriptions: {
    sdk: 'See what context EXISTS in orgs you actively work in that you CANNOT read yet — the inverse of grant_list. Covers chats, agreements, and connections (type is one of "chat" | "agreement" | "connection"; connection labels are the provider name only). Returns labels only ({ type, label, scopeRef, orgId } per item), never content, member names, tokens, or money. Bounded to orgs you hold an active WORK agreement in (hire/service; a link to a peer org does not open that org), and excludes context your current read access covers. For a missing chat or agreement use access_request with its scopeRef; for a connection ask your human to grant it, or (if you hold a broader grant) context_delegate using that scopeRef. Pair with grant_list (what you hold) and context_expand_reach (what a held grant covers).',
  },
  annotation: 'read-only',
  params: {},
  needsAgentId: true,
  handler: async (_args, env) => {
    const creds = fullCreds(env);
    const items = await new ContextDiscoveryClient(
      creds.operatorKey,
      creds.agentId,
    ).discoverGrantable();
    return { count: items.length, items: items.map((item) => ({ ...item,
      actions: item.type === 'connection' ? [] : [requestAccessAction({ scopeKind: item.type, scopeId: item.scopeRef.id }, env)],
    })) };
  },
};

export const contextDelegateCapability: CapabilityDefinition = {
  key: 'context_delegate',
  names: { sdk: 'context_delegate', mcp: 'ziggs_context_delegate' },
  title: 'Pass on a narrower grant',
  descriptions: {
    sdk: 'Delegate a narrower child context grant (tighter scope, shorter expiry, or from-now). Holder-only. Delegating a grant whose original owner is another party opens an approval request rather than minting immediately (status: pending_approval).',
  },
  annotation: 'write',
  params: {
    parentGrantId: { type: 'string', required: true },
    holderId: { type: 'string', required: true, description: 'Agent receiving the delegated grant' },
    scopeKind: { type: 'string', required: true, enum: GRANT_SCOPE_KINDS },
    scopeId: { type: 'string', required: true },
    temporal: {
      type: 'string',
      required: true,
      enum: CONTEXT_TEMPORALS,
      description: 'from-now or from-start (must be same-or-narrower)',
    },
    expiresAt: { type: 'string' },
    watermarkAt: {
      type: 'string',
      description: 'from-now watermark ISO-8601 (optional; server may default)',
    },
    idempotencyKey: {
      type: 'string',
      description:
        'Replay the same delegate. Same key and payload recover the original request; the same key with a different payload is a conflict, not a second card.',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const temporal = args['temporal'] as string;
    if (!CONTEXT_TEMPORALS.includes(temporal as ContextTemporal)) {
      throw new Error('temporal must be from-now or from-start');
    }
    const scopeKind = args['scopeKind'] as string;
    if (!GRANT_SCOPE_KINDS.includes(scopeKind as (typeof GRANT_SCOPE_KINDS)[number])) {
      throw new Error(`scopeKind must be one of ${GRANT_SCOPE_KINDS.join(', ')}`);
    }
    // #6 — an org scope may be named rather than pasted as org_… id.
    let scopeId = args['scopeId'] as string;
    if (scopeKind === 'org') {
      scopeId = await resolveOrgScopeId(env, scopeId);
    }
    const client = new ContextGrantsClient(creds.operatorKey, creds.agentId);
    const result = await client.delegateGrant(
      args['parentGrantId'] as string,
      {
        holderId: args['holderId'] as string,
        // An agent passing part of its own grant onward hands it to another
        // agent; a person is granted through their own surface.
        holderKind: 'agent',
        scope: { kind: scopeKind as ContextGrantScopeKind, id: scopeId },
        temporal: temporal as ContextTemporal,
        expiresAt: (args['expiresAt'] as string | undefined) ?? undefined,
        watermarkAt: args['watermarkAt'] as string | undefined,
      },
      {
        idempotencyKey:
          typeof args['idempotencyKey'] === 'string'
            ? (args['idempotencyKey'] as string)
            : undefined,
      },
    );
    if (result.status === 'pending_approval') {
      return {
        status: 'pending_approval',
        state: 'requested',
        outcome: 'pending' as const,
        recoverable: true,
        message:
          "Requested, not granted — this grant's original owner must approve. Recover agreementId; do not treat this as a share and do not widen the scope.",
        parentGrantId: args['parentGrantId'],
        agreementId: result.agreementId,
        ownerId: result.ownerId,
      };
    }
    const grant = result.grant;
    return {
      status: 'delegated',
      outcome: 'ok' as const,
      parentGrantId: args['parentGrantId'],
      grant,
      bounds: contextBounds(grant),
    };
  },
};

const OPEN_REF_PARAMS = {
  ref: {
    type: 'string' as const,
    description: 'What to open: a handle such as T7K2QXD (T task, A agreement, C chat, F artifact) in any case, a Ziggs web URL holding one, or an id from a prior response.',
  },
  // Cached connector schemas still send these. Both surfaces normalize them
  // here; the server remains the only authority on the resource and access.
  ...Object.fromEntries(['artifactId', 'chatId', 'taskId', 'agreementId'].map(key => [key, {
    type: 'string' as const,
    description: 'Use instead of ref; exactly one reference.',
  }])),
};


function presentOpenResult(
  result: Awaited<ReturnType<ContextOpenClient['open']>>,
  env: CapabilityEnv,
): Record<string, unknown> {
  // Resource-routed OAuth calls let the backend select the assistant. Their
  // local credentials have no agent id, so only the response can name it.
  const actingAgentId = result.actingAgentId !== undefined
    ? result.actingAgentId : fullCreds(env).agentId || undefined;
  // Expose a request-only next action, never execute it as part of a read.
  const requestTool = env.surface === 'mcp' ? 'ziggs_access_request' : 'access_request';
  const chatTool = env.surface === 'mcp' ? 'ziggs_chat_open' : 'chat_open';
  const resumeActions = (result.outcome === 'ok' && result.ref.kind === 'agreement'
    ? result.page?.items ?? [] : []).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const row = item as { status?: string; grantRequest?: { primitive?: string; kind?: string; holderId?: string; scope?: { kind?: string; id?: string }; resumeAgreementId?: string } };
      const ask = row.grantRequest;
      if (row.status !== 'active' || !isContextAccessRequest(ask) || !actingAgentId || ask.holderId !== actingAgentId || !ask.scope?.id || !['artifact', 'chat', 'agreement', 'task'].includes(ask.scope.kind ?? '')) return [];
      return [{ kind: 'resume', tool: env.surface === 'mcp' ? 'ziggs_open' : 'open', args: { ref: ask.scope.id }, effect: 'read_only', note: 'Approval recorded. Open the original scope; the server rechecks expiry and revocation.' }];
    });
  return {
    ...result,
    actions: result.actions
      ? [...presentResourceActions(result.actions, env.surface),
          ...resumeActions.map(a => ({ ...a, action: 'resume', state: 'not_evaluated' }))]
      : result.access.continuation?.request
        ? [requestAccessAction(result.access.continuation.request, env)]
        : result.ref.kind === 'artifact' && result.outcome === 'unreadable'
          ? [requestAccessAction({ scopeKind: 'artifact', scopeId: result.ref.id, permission: 'read', durationHours: 24 }, env)]
          : resumeActions,
    ...(actingAgentId !== undefined ? { actingAgentId } : {}),
    ...(!result.actions && result.ref.kind === 'artifact' && result.outcome !== 'ok' ? {
      requestAccessHint: `If a source you already read supplied this artifact reference and its human owner, ${requestTool} scopeKind=artifact can ask that owner for temporary read access without a prior grant. It needs a conversation with the owner; ${chatTool} can open or reuse one, subject to authorization. Discover the request tool's schema before calling it. This response does not confirm existence or ownership. A request grants no access until the human owner approves.`,
    } : {}),
  };
}

/**
 * One answer for "you cannot read this", whichever tool asked.
 *
 * A get that the server refuses (404 or 403) used to answer in its own words:
 * agreement_get said "not found" for an agreement that exists and that the
 * caller could ask for, and task_get said "not a party" for a task that does
 * not exist. The server already judges this once, for open and access_explain:
 * readable, unreadable with a request to make, or hidden (and hidden looks
 * exactly like missing). A refused get asks that same judgement, so every tool
 * gives the same outcome and the same recovery for the same case, and none
 * reveals more than open already does.
 *
 * Null when the judgement says the caller may read it after all: the refusal
 * was something else, and the caller reports its own error.
 */
export interface RefusedRead {
  code: 'RESOURCE_HIDDEN' | 'RESOURCE_UNREADABLE';
  outcome: 'hidden' | 'unreadable';
  message: string;
  ref: { kind: string; id: string };
  actions?: unknown[];
}

export const RESOURCE_HIDDEN_MESSAGE =
  'Not found, or not available to you. The two look the same.';
export const RESOURCE_UNREADABLE_MESSAGE =
  'This exists and you cannot read it yet. actions has the request to make.';

export async function explainRefusedRead(
  kind: 'agreement' | 'task' | 'chat' | 'artifact',
  id: string,
  env: CapabilityEnv,
): Promise<RefusedRead | null> {
  const creds = fullCreds(env);
  let presented: Record<string, unknown>;
  try {
    const client = new ContextOpenClient(
      creds.operatorKey,
      creds.agentId,
      env.baseUrl,
    );
    presented = presentOpenResult(
      await client.explain({ [`${kind}Id`]: id } as ContextOpenBody),
      env,
    );
  } catch {
    return null;
  }
  const outcome = presented['outcome'];
  if (outcome !== 'hidden' && outcome !== 'unreadable') return null;
  const actions = Array.isArray(presented['actions']) ? presented['actions'] : [];
  return outcome === 'hidden'
    ? { code: 'RESOURCE_HIDDEN', outcome, message: RESOURCE_HIDDEN_MESSAGE, ref: { kind, id } }
    : {
        code: 'RESOURCE_UNREADABLE',
        outcome,
        message: RESOURCE_UNREADABLE_MESSAGE,
        ref: { kind, id },
        ...(actions.length ? { actions } : {}),
      };
}

export const openCapability: CapabilityDefinition = {
  key: 'open',
  names: { sdk: 'open', mcp: 'ziggs_open' },
  title: 'Open a returned resource',
  descriptions: {
    sdk: 'Read a returned resource: pass its ref, a short handle such as T7K2QXD (the first letter is the kind), a Ziggs URL, or an id. The backend resolves access and returns scoped actions with required inputs and recovery calls. Opening executes none of those actions. Extraction pending/failed is not an empty document. To read a chat\'s messages under one agreement, use context_read with type=messages, via=chat:<id> and its agreement filter.',
  },
  annotation: 'read-only',
  // ref names the one record to open (OPEN_REF_PARAMS). It used to carry context_read's filter wording, so an
  // agent passed it beside chatId as a filter and was refused by the
  // exactly-one rule. Filtering a room's messages to one agreement is
  // context_read's job, and the description says so.
  params: {
    ...OPEN_REF_PARAMS,
    cursor: { type: 'string', description: 'Opaque cursor from a prior open page' },
    after: { type: 'string', description: 'ISO timestamp for a forward-delta' },
    limit: { type: 'number', description: 'Page size' },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const client = new ContextOpenClient(
      creds.operatorKey,
      creds.agentId,
      env.baseUrl,
    );
    return presentOpenResult(await client.open(args), env);
  },
};

export const accessExplainCapability: CapabilityDefinition = {
  key: 'access_explain',
  names: { sdk: 'access_explain', mcp: 'ziggs_access_explain' },
  title: 'Explain access to a resource',
  descriptions: {
    sdk: 'Read-only access explanation for a returned resource. Same ref as open. Returns scoped action states, required inputs and recovery calls. Does not return content and does not request or approve anything.',
  },
  annotation: 'read-only',
  params: OPEN_REF_PARAMS,
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const client = new ContextOpenClient(
      creds.operatorKey,
      creds.agentId,
      env.baseUrl,
    );
    const result = await client.explain(args);
    return presentOpenResult(result, env);
  },
};


/** A suggested request still needs a purpose; it is never a grant or an approval. */
function requestAccessAction(args: Record<string, unknown>, env: CapabilityEnv) {
  return {
    kind: 'request_access',
    tool: env.surface === 'mcp' ? 'ziggs_access_request' : 'access_request',
    args, requiredInput: args.scopeKind === 'artifact' ? ['reason', 'chatId', 'recipientId'] : ['reason', 'recipientId'], effect: 'request_only',
    requiresApproval: true,
  };
}

/** The readers an access request names: kinds stated, ids distinct, at most 20. */
function readersOf(value: unknown): Array<{ kind: 'agent' | 'user' | 'org'; id: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error('holders must list 1 to 20 readers');
  const seen = new Set<string>();
  return value.map((entry, i) => {
    const kind = (entry as { kind?: unknown })?.kind;
    const id = (entry as { id?: unknown })?.id;
    if (kind !== 'agent' && kind !== 'user' && kind !== 'org') throw new Error(`holders[${i}].kind must be agent, user or org`);
    if (typeof id !== 'string' || !id.trim()) throw new Error(`holders[${i}].id is required`);
    const key = `${kind}:${id.trim()}`;
    if (seen.has(key)) throw new Error(`holders names the same reader twice (holders[${i}])`);
    seen.add(key);
    return { kind, id: id.trim() };
  });
}

export const accessRequestCapability: CapabilityDefinition = {
  key: 'access_request',
  names: { sdk: 'access_request', mcp: 'ziggs_access_request' },
  title: 'Request access for yourself or named readers',
  annotation: 'destructive', needsAgentId: true,
  descriptions: {
    sdk: 'Request optional bounded access to one artifact, chat, agreement context or task. Creates only a pending approval; never grants access or approves. Choose recipientId when several approvers are offered; with one, it is selected automatically: your work brief offers them for this wake — workBrief.actingFor.customer.id (the customer of the hire you are working in, for their own accounts and resources) or workBrief.actingFor.operator.id (your operator, for tools you bring). Anyone else is refused, and the refusal lists who you can ask. Artifact requests also need chatId, the conversation they approve in. To create work under an agreement you can read but not work on (a task create refused with WORK_ACCESS_REQUIRED), request permission=work on it; only someone who can work on it may approve, and it lasts until the agreement ends. Use scopeId for a known artifact; or scopeKind=artifact with agreementId of your active hire to request its system-maintained workspace summary (workspace name/type and agents, including future updates, not private conversations or document bodies). Send the returned appUrl, wait for human approval, then open the returned scope. To arrange reading of one artifact for others, name them in holders (agents by id, people or workspaces by id or the participant reference this room shows you); include yourself only if you need to read it too. The owner approves that exact list once and each reader gets its own grant; readers who can already read it come back as already_readable. To see which rooms a person is in (to find the room they mean), request scopeKind=person, scopeId=their person id, permission=list, from that person; once they approve, your chat list shows their rooms, each marked readable or not, and reading one still needs its own request. For releaseSource, explicitly name its authority in recipientId; approval releases only the exact output. Hiring alone grants no source access. Revocation and expiry are checked by the system.',
  },
  params: {
    scopeKind: { type: 'string', required: true, enum: ['artifact', 'chat', 'agreement', 'task', 'person'] },
    scopeId: { type: 'string', description: 'Original resource id. Omit when using a hire agreementId to request its workspace summary.' },
    agreementId: { type: 'string', description: 'Artifact scope only: current hire id, used instead of scopeId to request the system-maintained workspace summary.' },
    reason: { type: 'string', required: true, description: 'Why access is needed and who will receive the reply or summary' },
    permission: { type: 'string', enum: ['read', 'reply', 'work', 'list'], description: 'read by default; reply is read and reply and is only valid for a chat; work lets you create work under an agreement you can read but not work on, and lasts until it ends; list is required for a person scope and shows which rooms they are in, never their messages' },
    temporal: { type: 'string', enum: ['from-now', 'from-start'], description: 'Chat history requested; default from-now. Earlier messages need from-start. Other resources use from-start.' },
    durationHours: { type: 'number', description: 'Integer 1–168 hours after approval; default 24' },
    chatId: { type: 'string', description: 'Artifact or workspace requests only: existing conversation with the owner' },
    // Not required here: the server requires it, and a request without it
    // comes back refused with the people this agent may ask. Required in the
    // schema, a host refused the call before that list could arrive.
    recipientId: { type: 'string', description: 'Who approves: a work brief choice or the artifact owner. With releaseSource, explicitly name its source authority; they must already be able to review the output.' },
    releaseSource: {
      type: 'object', description: 'Source {kind,id} from contribution review. Approves its information in scopeId (the output), never source access. Requires contributionTo.',
    },
    contributionTo: {
      type: 'object', description: 'Artifact only: { kind: "chat" | "agreement", id }. Ask its owner to approve use in this shared work. Name all destination readers and yourself in holders. Existing read access does not replace this consent.',
    },
    holders: {
      type: 'array',
      description: 'Artifact only, read only: up to 20 readers, each { kind: "agent" | "user" | "org", id }. Leave yourself out to arrange it for others. Omit to ask for yourself.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['agent', 'user', 'org'] },
          id: { type: 'string' },
        },
        required: ['kind', 'id'],
      },
    },
    idempotencyKey: { type: 'string', description: 'Reuse for the same logical request' },
  },
  handler: async (args, env) => {
    // recipientId is resolved by the server: it picks the sole eligible recipient
    // and lists who this agent may ask, which nothing on this side knows.
    for (const key of ['scopeKind', 'reason']) {
      if (typeof args[key] !== 'string' || !String(args[key]).trim()) throw new Error(`${key} is required`);
    }
    const scopeKind = args.scopeKind as 'artifact' | 'chat' | 'agreement' | 'task' | 'person';
    if (!['artifact', 'chat', 'agreement', 'task', 'person'].includes(scopeKind)) throw new Error('Unsupported scopeKind');
    const agreementId = typeof args.agreementId === 'string' ? args.agreementId.trim() : undefined;
    const scopeId = typeof args.scopeId === 'string' ? args.scopeId.trim() : undefined;
    if (Boolean(agreementId) === Boolean(scopeId) || (agreementId && scopeKind !== 'artifact')) throw new Error('Provide scopeId, or agreementId for its workspace summary artifact');
    const permission = args.permission ?? (scopeKind === 'person' ? 'list' : 'read');
    if ((permission === 'list') !== (scopeKind === 'person')) throw new Error('A person scope is requested with permission=list, and list only for a person');
    if (!['read', 'reply', 'work', 'list'].includes(String(permission)) || (permission === 'reply' && scopeKind !== 'chat')) throw new Error('Only chat access may request reply permission');
    if (permission === 'work' && scopeKind !== 'agreement') throw new Error('Only agreement access may request work permission');
    if (args.temporal !== undefined && (!['from-now', 'from-start'].includes(String(args.temporal)) || (scopeKind !== 'chat' && args.temporal === 'from-now'))) throw new Error('Only chats support from-now access');
    const durationHours = args.durationHours ?? 24;
    if (typeof durationHours !== 'number' || !Number.isInteger(durationHours) || durationHours < 1 || durationHours > 168) throw new Error('durationHours must be an integer between 1 and 168');
    const holders = args.holders === undefined ? undefined : readersOf(args.holders);
    if (holders && (scopeKind !== 'artifact' || agreementId || permission !== 'read')) throw new Error('holders is for one artifact named by scopeId, to read');
    let contributionTo: { kind: 'chat' | 'agreement'; id: string } | undefined;
    if (args.contributionTo !== undefined) {
      const target = args.contributionTo as { kind?: unknown; id?: unknown } | null;
      if (!target || !['chat', 'agreement'].includes(String(target.kind)) || typeof target.id !== 'string' || !target.id.trim() || !holders || scopeKind !== 'artifact' || agreementId || permission !== 'read')
        throw new Error('contributionTo requires an artifact, named readers, and a chat or agreement destination');
      contributionTo = { kind: target.kind as 'chat' | 'agreement', id: target.id.trim() };
    }
    let releaseSource: import('@ziggs-ai/contracts').ContributionSource | undefined;
    if (args.releaseSource !== undefined) {
      const source = args.releaseSource as { kind?: unknown; id?: unknown } | null;
      if (!contributionTo || !source || !['artifact', 'agreement', 'chat', 'task', 'connection-grant'].includes(String(source.kind)) || typeof source.id !== 'string' || !source.id.trim()) throw new Error('releaseSource requires contributionTo and a valid source kind and id');
      releaseSource = { kind: source.kind as import('@ziggs-ai/contracts').ContributionSource['kind'], id: source.id.trim() };
    }
    const creds = fullCreds(env);
    const result = await new ContextGrantsClient(creds.operatorKey, creds.agentId, env.baseUrl).requestAccess({
      scopeKind, scopeId, agreementId, reason: String(args.reason).trim(),
      permission: permission as 'read' | 'reply' | 'work' | 'list', temporal: args.temporal as 'from-now' | 'from-start' | undefined,
      durationHours, chatId: args.chatId as string | undefined,
      recipientId: typeof args.recipientId === 'string' ? args.recipientId.trim() : undefined,
      ...(holders ? { holders } : {}),
      ...(contributionTo ? { contributionTo } : {}),
      ...(releaseSource ? { releaseSource } : {}),
    }, { idempotencyKey: args.idempotencyKey as string | undefined, laneId: creds.laneId });
    const actingAgentId = result.actingAgentId ?? (creds.agentId || undefined);
    if (result.status === 'already_readable') {
      return {
        ...result, outcome: 'already_readable', state: 'not_requested',
        ...(actingAgentId ? { actingAgentId } : {}),
        scope: result.scope ?? { kind: scopeKind, id: scopeId },
        note: result.message ?? 'Every reader you named can already read it. Nothing was asked.',
      };
    }
    return {
      ...result, outcome: 'pending', state: 'requested',
      ...(actingAgentId ? { actingAgentId } : {}),
      scope: result.scope ?? { kind: scopeKind, id: scopeId },
      appUrl: `${(env.webUrl ?? 'https://ziggsai.com').replace(/\/$/, '')}/app/agreements/${encodeURIComponent(result.agreementId)}`,
      // A person scope opens nothing: the yes shows up in the chat list.
      ...(scopeKind === 'person'
        ? env.surface === 'mcp' ? { resumeAfterApproval: { tool: 'ziggs_chat_list', args: {} } } : {}
        : { resumeAfterApproval: { tool: env.surface === 'mcp' ? 'ziggs_open' : 'open', args: { ref: result.scope?.id ?? scopeId } } }),
      note: `${result.message ?? 'A request card is open.'} No access granted until they approve; then open the original resource using the same agent identity.`,
    };
  },
};

export const CONTEXT_CAPABILITIES: CapabilityDefinition[] = [
  contextReadCapability,
  openCapability,
  accessExplainCapability,
  accessRequestCapability,
  contextDelegateCapability,
  contextExpandReachCapability,
  contextDiscoverGrantableCapability,
];
