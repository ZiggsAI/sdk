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
// A send grant (`contact`) is never passed on, so it is not a delegation scope.
const GRANT_SCOPE_KINDS = CONTEXT_GRANT_SCOPE_KINDS.filter(kind => kind !== 'address' && kind !== 'person' && kind !== 'contact');
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
  'read one referenced by no agreement or task';

export const contextReadCapability: CapabilityDefinition = {
  key: 'context_read',
  names: { sdk: 'context_read', mcp: 'ziggs_context_read' },
  title: 'Read context you hold',
  descriptions: {
    sdk: `Read a scope you hold: ${CONTEXT_READ_TYPES.join(' | ')}. Each type reads through its own entries — ${VIA_BY_TYPE}. Use grant_list to find readable scopes. ${ARTIFACT_VIA_NOTE}. Cursored; all access is grant-fenced server-side.`,
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
    cursor: { type: 'string', description: 'Opaque cursor from a prior nextCursor to page' },
    after: { type: 'string', description: 'ISO timestamp for artifact forward-delta' },
    direction: {
      type: 'string',
      enum: ['forward', 'backward'],
      description: 'Use "forward" with after for an artifact forward-delta; "backward" starts a newest-first artifact inventory',
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
    sdk: 'Expand a grant you hold into authorized resource references listed inside a broader scope (ids + labels only, no content). Exact agreement, artifact and task grants already name their resource and return an empty expansion: read the named resource directly. Expansion grants no new authority; use retained message, artifact, task or agreement operations for content. Holder-only and grant-fenced.',
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
    sdk: 'Discover bounded resource labels in work organizations that current read access does not cover. Returns owner-projected references, never content, member names, tokens or money. Agreement entries may offer a pending access_request; connection access remains with its owner. Discovery grants no authority and does not open a conversation. Pair with grant_list for existing grants.',
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
      actions: item.type === 'agreement' ? [requestAccessAction({ scopeKind: item.type, scopeId: item.scopeRef.id }, env)] : [],
    })) };
  },
};

/** What a grant may be narrowed to when passed on. An artifact is not among
 * them: it reaches people only by being added to a bucket. */
const DELEGABLE_SCOPE_KINDS = GRANT_SCOPE_KINDS.filter((kind) => kind !== 'artifact');

export const contextDelegateCapability: CapabilityDefinition = {
  key: 'context_delegate',
  names: { sdk: 'context_delegate', mcp: 'ziggs_context_delegate' },
  title: 'Pass on a narrower grant',
  descriptions: {
    sdk: 'Delegate a narrower child context grant (tighter scope, shorter expiry, or from-now). Holder-only. Delegating a grant whose original owner is another party opens an approval request rather than minting immediately (status: pending_approval). An artifact is not passed on this way: add it to a bucket.',
  },
  annotation: 'write',
  params: {
    parentGrantId: { type: 'string', required: true },
    holderId: { type: 'string', required: true, description: 'Agent receiving the delegated grant' },
    scopeKind: { type: 'string', required: true, enum: DELEGABLE_SCOPE_KINDS },
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
    if (!(DELEGABLE_SCOPE_KINDS as readonly string[]).includes(scopeKind)) {
      throw new Error(`scopeKind must be one of ${DELEGABLE_SCOPE_KINDS.join(', ')}; an artifact is shared by adding it to a bucket`);
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
    description: 'What to open: a handle such as T7K2QXD (T task, A agreement, F artifact) in any case, a Ziggs web URL holding one, or an id from a prior response.',
  },
  // Cached connector schemas still send these. Both surfaces normalize them
  // here; the server remains the only authority on the resource and access.
  ...Object.fromEntries(['artifactId', 'taskId', 'agreementId'].map(key => [key, {
    type: 'string' as const,
    description: 'Use instead of ref; exactly one reference.',
  }])),
};


function resumeResource(kind: string, id: string, env: CapabilityEnv) {
  // After a send grant is approved there is nothing to read: send to the destination.
  // Offer an optional shared bucket with the newly reachable destination.
  if (kind === 'contact') return { tool: env.surface === 'mcp' ? 'ziggs_bucket_create' : 'bucket_create', args: { name: 'Conversation', audience: [id] } };
  const tool = kind === 'message' ? 'message_read' : 'open';
  return {
    tool: env.surface === 'mcp' ? `ziggs_${tool}` : tool,
    args: kind === 'message' ? { messageId: id } : { ref: id },
  };
}

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
  const resumeActions = (result.outcome === 'ok' && result.ref.kind === 'agreement'
    ? result.page?.items ?? [] : []).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const row = item as { status?: string; grantRequest?: { primitive?: string; kind?: string; holderId?: string; scope?: { kind?: string; id?: string }; resumeAgreementId?: string } };
      const ask = row.grantRequest;
      if (row.status !== 'active' || !isContextAccessRequest(ask) || !actingAgentId || ask.holderId !== actingAgentId || !ask.scope?.id || !['message', 'artifact', 'agreement', 'task'].includes(ask.scope.kind ?? '')) return [];
      return [{ kind: 'resume', ...resumeResource(ask.scope.kind!, ask.scope.id, env), effect: 'read_only', note: 'Approval recorded. Read the original scope; the server rechecks expiry and revocation.' }];
    });
  return {
    ...result,
    actions: result.actions
      ? [...presentResourceActions(result.actions, env.surface),
          ...resumeActions.map(a => ({ ...a, action: 'resume', state: 'not_evaluated' }))]
      : result.access.continuation?.request && ['agreement', 'task'].includes(result.access.continuation.request.scopeKind)
        ? [requestAccessAction(result.access.continuation.request, env)]
        : result.ref.kind === 'artifact' && result.outcome === 'unreadable'
          ? [requestAccessAction({ scopeKind: 'artifact', scopeId: result.ref.id, permission: 'read', durationHours: 24 }, env)]
          : resumeActions,
    ...(actingAgentId !== undefined ? { actingAgentId } : {}),
    ...(!result.actions && result.ref.kind === 'artifact' && result.outcome !== 'ok' ? {
      requestAccessHint: `If a source you already read supplied this artifact reference and its human owner, ${requestTool} scopeKind=artifact can ask that owner for temporary read access without a prior grant. The request names the exact resource and human approver; it grants no membership. Discover the request tool's schema before calling it. This response does not confirm existence or ownership. A request grants no access until the human owner approves.`,
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
  kind: 'agreement' | 'task' | 'artifact',
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
    sdk: 'Read a returned resource: pass its ref, a short handle such as T7K2QXD (the first letter is the kind), a Ziggs URL, or an id. The backend resolves access and returns scoped actions with required inputs and recovery calls. Opening executes none of those actions. Extraction pending/failed is not an empty document. Use message_list with an explicit agreementId to read authorized work messages.',
  },
  annotation: 'read-only',
  // Select exactly one resource. Message queries use their own owner operations.
  params: {
    ...OPEN_REF_PARAMS,
    cursor: { type: 'string', description: 'Opaque cursor from a prior open page' },
    after: { type: 'string', description: 'ISO timestamp for a forward-delta' },
    limit: { type: 'number', description: 'Page size' },
    html: { type: 'boolean', description: 'A page comes as its text; true for its HTML' },
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
    args, requiredInput: ['reason', 'recipientId'], effect: 'request_only',
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
    sdk: 'Request optional bounded access to one message, artifact, agreement context or task, or ask to send messages to a destination (scopeKind=contact). Creates only a pending approval; never grants access or approves. Choose recipientId when several approvers are offered; with one, it is selected automatically: your work brief offers them for this wake — workBrief.actingFor.customer.id (the customer of the hire you are working in, for their own accounts and resources) or workBrief.actingFor.operator.id (your operator, for tools you bring). Anyone else is refused, and the refusal lists who you can ask. Artifact requests go to the selected approver inbox; no conversation is needed. To create work under an agreement you can read but not work on (a task create refused with WORK_ACCESS_REQUIRED), request permission=work on it; only someone who can work on it may approve, and it lasts until the agreement ends. To work on one task only, request permission=work with scopeKind=task: a yes makes you its assignee. Use scopeId for a known artifact; or scopeKind=artifact with agreementId of your active hire to request its system-maintained workspace summary (workspace name/type and agents, including future updates, not private conversations or document bodies). Send the returned appUrl, wait for human approval, then follow the returned resume action. To arrange reading of one artifact for others, name them in holders (agents by id, people or workspaces by their authorized principal IDs); include yourself only if you need to read it too. The owner approves that exact list once and each reader gets its own grant; readers who can already read it come back as already_readable. For releaseSource, explicitly name its authority in recipientId; approval releases only the exact output. Hiring alone grants no source access. Revocation and expiry are checked by the system.',
  },
  params: {
    scopeKind: { type: 'string', required: true, enum: ['message', 'artifact', 'agreement', 'task', 'contact'], description: 'contact: ask to send messages to scopeId (a person, an agent or a workspace inbox). One-way; it reads nothing and gives no reply path.' },
    scopeId: { type: 'string', description: 'Original resource id. Omit when using a hire agreementId to request its workspace summary.' },
    agreementId: { type: 'string', description: 'Artifact scope only: current hire id, used instead of scopeId to request the system-maintained workspace summary.' },
    reason: { type: 'string', required: true, description: 'Why access is needed and who will receive the reply or summary' },
    permission: { type: 'string', enum: ['read', 'work'], description: 'read by default. work: agreement work, or with scopeKind=task, that task.' },
    temporal: { type: 'string', enum: ['from-start'], description: 'Retained resource access uses from-start; owner policy remains authoritative.' },
    durationHours: { type: 'number', description: 'Integer 1–168 hours after approval; reads default to 24' },
    // Not required here: the server requires it, and a request without it
    // comes back refused with the people this agent may ask. Required in the
    // schema, a host refused the call before that list could arrive.
    recipientId: { type: 'string', description: 'Who approves: a work brief choice, the owner, or a source authority.' },
    releaseSource: {
      type: 'object', description: 'A {kind,id} from the review; releases it in this output only. Needs contributionTo.',
    },
    contributionTo: {
      type: 'object', description: 'Artifact-use consent: {kind:"message"|"agreement",id}. Include all readers and yourself in holders; read access is separate.',
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
    const scopeKind = args.scopeKind as 'message' | 'artifact' | 'agreement' | 'task' | 'contact';
    if (!['message', 'artifact', 'agreement', 'task', 'contact'].includes(scopeKind)) throw new Error('Unsupported scopeKind');
    const contact = scopeKind === 'contact';
    const agreementId = typeof args.agreementId === 'string' ? args.agreementId.trim() : undefined;
    const scopeId = typeof args.scopeId === 'string' ? args.scopeId.trim() : undefined;
    if (Boolean(agreementId) === Boolean(scopeId) || (agreementId && scopeKind !== 'artifact')) throw new Error('Provide scopeId, or agreementId for its workspace summary artifact');
    const permission = args.permission ?? 'read';
    if (!['read', 'work'].includes(String(permission))) throw new Error('permission must be read or work');
    // Which scope takes which permission is the server's answer, with its reason.
    if (args.temporal !== undefined && args.temporal !== 'from-start') throw new Error('Retained resources use from-start access');
    // A read lasts 24 hours unless asked otherwise. Work lasts as long as its
    // agreement, or is a hand-over that never times out, so it gets no default.
    const durationHours = args.durationHours ?? (permission === 'work' ? undefined : 24);
    if (durationHours !== undefined && (typeof durationHours !== 'number' || !Number.isInteger(durationHours) || durationHours < 1 || durationHours > 168)) throw new Error('durationHours must be an integer between 1 and 168');
    const holders = args.holders === undefined ? undefined : readersOf(args.holders);
    if (holders && contact && holders.length !== 1) throw new Error('A contact request names one holder: yourself or your own owner');
    if (holders && !contact && (scopeKind !== 'artifact' || agreementId || permission !== 'read')) throw new Error('holders is for one artifact named by scopeId, to read');
    let contributionTo: { kind: 'message' | 'agreement'; id: string } | undefined;
    if (args.contributionTo !== undefined) {
      const target = args.contributionTo as { kind?: unknown; id?: unknown } | null;
      if (!target || !['message', 'agreement'].includes(String(target.kind)) || typeof target.id !== 'string' || !target.id.trim() || !holders || scopeKind !== 'artifact' || agreementId || permission !== 'read')
        throw new Error('contributionTo requires an artifact, named readers, and a message or agreement destination');
      contributionTo = { kind: target.kind as 'message' | 'agreement', id: target.id.trim() };
    }
    let releaseSource: import('@ziggs-ai/contracts').ContributionSource | undefined;
    if (args.releaseSource !== undefined) {
      const source = args.releaseSource as { kind?: unknown; id?: unknown } | null;
      if (!contributionTo || !source || !['message', 'artifact', 'agreement', 'address', 'task', 'connection-grant'].includes(String(source.kind)) || typeof source.id !== 'string' || !source.id.trim()) throw new Error('releaseSource requires contributionTo and a valid source kind and id');
      releaseSource = { kind: source.kind as import('@ziggs-ai/contracts').ContributionSource['kind'], id: source.id.trim() };
    }
    const creds = fullCreds(env);
    const result = await new ContextGrantsClient(creds.operatorKey, creds.agentId, env.baseUrl).requestAccess({
      scopeKind, scopeId, agreementId, reason: String(args.reason).trim(),
      // A contact request carries no permission unless the caller named one;
      // the server makes it send-only and refuses any other with its reason.
      ...(contact && args.permission === undefined ? {} : { permission: permission as 'read' | 'work' }), temporal: args.temporal as 'from-start' | undefined,
      ...(durationHours !== undefined ? { durationHours: durationHours as number } : {}),
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
      resumeAfterApproval: resumeResource(scopeKind, result.scope?.id ?? scopeId!, env),
      note: `${result.message ?? 'A request card is open.'} No access granted until they approve; then read the original resource using the same agent identity.`,
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
