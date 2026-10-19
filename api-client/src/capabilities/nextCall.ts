import type { AgreementParties } from '../types.js';
import type {
  CapabilityDefinition,
  CapabilityEnv,
  CapabilitySurface,
} from './types.js';

/**
 * One next step: the tool the calling surface registers, any args already
 * known, and why.
 *
 * Ready means the call has complete arguments and no declared hold; it is
 * not an authorization decision. The server checks permission on execution.
 * Incomplete means a required
 * argument is missing or an address field is not an address — the suggestion
 * still names the tool, and `missing` says what has to be filled first.
 *
 * `http` is the same invocation on the published HTTP surface, bound from the
 * capability key rather than a second implementation. Profile is not a field
 * here: assistant vs worker is not a transport.
 */
export interface NextCall {
  /** Registered tool name on the calling surface. */
  tool: string;
  /** Arguments, filled in from what the response already carries. */
  args?: Record<string, unknown>;
  /** One clause: what running this achieves, or what is still missing. */
  why: string;
  /** Arguments are complete and no hold is declared; does not prove authority. */
  ready: boolean;
  /** Required argument names that are absent or not an address. */
  missing?: readonly string[];
  /** Published HTTP method/path for the same capability, when we have one. */
  http?: { method: string; path: string };
  /**
   * Whether this step is a finished action, a parked human decision, a
   * half-filled suggestion, or something this surface cannot run.
   */
  outcome: NextCallOutcome;
  /** Material effects of running this, when the verb has any. */
  effects?: NextCallEffects;
  /** Who would run it, from the env — never a caller-chosen principal. */
  workContext?: WorkContext;
  /** Why a complete-looking call is still not runnable. */
  hold?: NextCallHold;
}

export type NextCallOutcome = 'ok' | 'pending' | 'partial' | 'unavailable';

export type NextCallHold = 'human_approval' | 'relationship';

export interface NextCallEffects {
  disclosure?: string;
  commitment?: string;
  metering?: string;
  relationship?: string;
}

export interface WorkContext {
  actingAgentId?: string;
  laneId?: string;
}

export interface NextCallOptions {
  /** Live capability schema — required args come from here when present. */
  definition?: Pick<CapabilityDefinition, 'params'>;
  outcome?: NextCallOutcome;
  effects?: NextCallEffects;
  /**
   * Args may be complete but the caller must not run it: a human signs, or
   * a relationship is not live yet.
   */
  hold?: NextCallHold;
}

/**
 * Fields that name a party to reach. A `psn_` persona face is display state
 * and must never be offered here — chat_open / chat_send refuse it, and the
 * baseline's provider learned that only by being refused.
 */
const ADDRESS_FIELDS = [
  'participantId',
  'to',
  'receiverId',
  'counterparty',
  'executorId',
] as const;

/**
 * Required arguments for the capability keys this helper is asked to emit.
 * Kept next to the HTTP bindings so a ready call cannot advertise a schema
 * the definition does not have. Keys we do not list here stay "no extra
 * required args" — the caller already chose what to pre-fill. Tests pin
 * these against live `CapabilityDefinition.params` for keys that have one.
 */
const REQUIRED_ARGS: Readonly<Record<string, readonly string[]>> = {
  chat_open: ['participantId'],
  chat_send: ['chatId'],
  agreement_claim: ['agreementId'],
  agreement_get: ['agreementId'],
  agreement_buy: ['counterparty', 'description'],
  agreement_bid: ['counterparty', 'description'],
  agreement_request: ['audience', 'description'],
  agreement_subcontract: ['parentAgreementId', 'executorId', 'description'],
  agreement_respond: ['agreementId'],
  introduction_redeem: ['token'],
  artifact_share: ['artifactId', 'holderId'],
  context_delegate: ['parentGrantId', 'holderId', 'scopeKind', 'scopeId', 'temporal'],
  task_create: ['agreementId', 'description'],
  task_cancel: ['taskId'],
};

/**
 * Published HTTP invocation per capability key. Paths match the api-client
 * HTTP clients, not a restated OpenAPI list. Path params stay as `:name`
 * until a ready arg fills them — an incomplete call must not invent an id.
 */
const HTTP_BINDINGS: Readonly<
  Record<string, { method: string; path: string }>
> = {
  chat_open: { method: 'POST', path: '/chats' },
  chat_send: { method: 'POST', path: '/chats/:chatId/messages' },
  introduction_list: { method: 'GET', path: '/introductions' },
  introduction_mint: { method: 'POST', path: '/introductions' },
  introduction_redeem: { method: 'POST', path: '/introductions/:token/redeem' },
  agreement_claim: { method: 'POST', path: '/agreements/:agreementId/claim' },
  agreement_get: { method: 'GET', path: '/agreements/:agreementId' },
  agreement_buy: { method: 'POST', path: '/agreements/proposals' },
  agreement_bid: { method: 'POST', path: '/agreements/proposals' },
  agreement_request: { method: 'POST', path: '/agreements/proposals' },
  agreement_subcontract: {
    method: 'POST',
    path: '/agreements/:parentAgreementId/delegations',
  },
  agreement_respond: {
    method: 'PUT',
    path: '/agreements/:agreementId/approvals/:partyId',
  },
  marketplace_view: { method: 'GET', path: '/marketplace/offers' },
  artifact_share: { method: 'POST', path: '/context/artifacts/:artifactId/share' },
  context_delegate: { method: 'POST', path: '/context/grants/:parentGrantId/delegate' },
  open: { method: 'POST', path: '/context/open' },
  access_explain: { method: 'POST', path: '/context/access/explain' },
  inbox_peek: { method: 'GET', path: '/inbox/peek' },
  inbox_changes: { method: 'GET', path: '/inbox/changes' },
  notification_status: { method: 'GET', path: '/oauth/events/status' },
  task_get: { method: 'GET', path: '/tasks/:taskId' },
  task_list: { method: 'GET', path: '/tasks' },
  link_list: { method: 'GET', path: '/agreements?engagementKind=link' },
  link_propose: { method: 'POST', path: '/agreements/links' },
  task_create: { method: 'POST', path: '/tasks' },
  task_cancel: { method: 'PATCH', path: '/tasks/:taskId/cancel' },
};

/**
 * Intentional surface exclusions. A ready next call has to exist as a tool
 * on the calling surface (tool-surface-parity).
 */
const SURFACE_EXPOSURE: Readonly<
  Record<string, readonly CapabilitySurface[]>
> = {
  // The hosted SDK surface enumerates its own work with task_list and reads a
  // task from the wake it arrived on; ziggs_task_get is the MCP delegate's
  // one-task read. Naming it to an SDK agent would offer a tool it cannot call.
  task_get: ['mcp'],
};

const MATERIAL_EFFECTS: Readonly<Record<string, NextCallEffects>> = {
  task_get: {
    disclosure: 'reads back what was recorded; it changes nothing',
  },
  agreement_claim: {
    commitment: 'claiming makes you a party to the posted terms',
    relationship: 'you become the open party on that broadcast',
  },
  agreement_respond: {
    commitment:
      'approve or reject binds your side; do not sign for a human whose slot this is',
  },
  introduction_redeem: {
    relationship:
      'a stranger redeem stages a link both humans must approve — it is not a live connection yet',
  },
  link_propose: {
    relationship:
      'proposes a reach-only link; nothing is shared until they accept',
  },
  chat_open: {
    disclosure: 'opening a room issues the other side a grant on it',
  },
  task_create: {
    commitment: 'creates a task under the named agreement',
  },
  task_cancel: {
    commitment: 'cancel ends this task; a held graph withdraws by cancelling the root',
  },
  agreement_buy: {
    commitment: 'proposes that they work and your side pays',
    relationship: 'a named counterparty — not a listing claim',
  },
  agreement_bid: {
    commitment: 'proposes that you work and they pay',
  },
  agreement_request: {
    commitment: 'posts work anyone may claim; you pay the claimer',
  },
  agreement_subcontract: {
    commitment:
      'opens a sub-agreement under the parent; the worker must approve — never impersonated',
    relationship: 'the slice sits under the parent you already hold',
  },
};

/** A persona face (`psn_…`) is display state, not a message address. */
export function isPersonaFace(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('psn_');
}

/** Acting agent and lane from the env. Never a caller-chosen principal. */
export function workContextFromEnv(env: CapabilityEnv): WorkContext | undefined {
  const ctx: WorkContext = {
    ...(env.creds.agentId ? { actingAgentId: env.creds.agentId } : {}),
    ...(env.creds.laneId ? { laneId: env.creds.laneId } : {}),
  };
  return ctx.actingAgentId || ctx.laneId ? ctx : undefined;
}

function isFilled(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function bindHttpPath(
  template: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return template;
  return template.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (all, name: string) => {
    const value = args[name];
    if (typeof value === 'string' && value && !isPersonaFace(value)) {
      return encodeURIComponent(value);
    }
    return all;
  });
}

function toolName(env: CapabilityEnv, capabilityKey: string): string {
  return env.surface === 'mcp' ? `ziggs_${capabilityKey}` : capabilityKey;
}

function requiredArgNames(
  capabilityKey: string,
  definition?: Pick<CapabilityDefinition, 'params'>,
): readonly string[] {
  if (definition) {
    return Object.entries(definition.params)
      .filter(([, param]) => param.required)
      .map(([name]) => name);
  }
  return REQUIRED_ARGS[capabilityKey] ?? [];
}

function isKnownCapability(
  capabilityKey: string,
  definition?: Pick<CapabilityDefinition, 'params'>,
): boolean {
  return (
    definition != null ||
    capabilityKey in REQUIRED_ARGS ||
    capabilityKey in HTTP_BINDINGS
  );
}

function isExposedOnSurface(
  capabilityKey: string,
  surface: CapabilitySurface,
): boolean {
  const allowed = SURFACE_EXPOSURE[capabilityKey];
  return allowed ? allowed.includes(surface) : true;
}

function effectsFor(
  capabilityKey: string,
  opts?: NextCallOptions,
): NextCallEffects | undefined {
  return opts?.effects ?? MATERIAL_EFFECTS[capabilityKey];
}

/**
 * Build a next step naming the tool as the calling surface registers it.
 *
 * Takes the capability key, not a tool name, because the two surfaces spell the
 * same capability differently (`chat_open` and `ziggs_chat_open`). Every one of
 * the 31 capability definitions follows that one rule, so the key is enough and
 * a caller cannot accidentally emit a name the surface does not have.
 */
export function nextCall(
  env: CapabilityEnv,
  capabilityKey: string,
  args: Record<string, unknown> | undefined,
  why: string,
  opts?: NextCallOptions,
): NextCall {
  const ctx = workContextFromEnv(env);
  const effects = effectsFor(capabilityKey, opts);
  const extra = {
    ...(effects ? { effects } : {}),
    ...(ctx ? { workContext: ctx } : {}),
  };

  if (!isKnownCapability(capabilityKey, opts?.definition)) {
    return {
      tool: toolName(env, capabilityKey),
      why: `${why} — this capability is not exposed as a next call`,
      ready: false,
      outcome: 'unavailable',
      ...extra,
    };
  }

  if (!isExposedOnSurface(capabilityKey, env.surface)) {
    return {
      tool: toolName(env, capabilityKey),
      why: `${why} — not on this surface`,
      ready: false,
      outcome: 'unavailable',
      ...extra,
    };
  }

  const missing: string[] = [];
  const strippedFaces: string[] = [];
  const filled: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args ?? {})) {
    if (!isFilled(value)) continue;
    if (key === 'participantIds' && Array.isArray(value) && value.some(isPersonaFace)) {
      missing.push(key);
      strippedFaces.push(key);
      continue;
    }
    if (
      (ADDRESS_FIELDS as readonly string[]).includes(key) &&
      isPersonaFace(value)
    ) {
      missing.push(key);
      strippedFaces.push(key);
      continue;
    }
    filled[key] = value;
  }

  for (const name of requiredArgNames(capabilityKey, opts?.definition)) {
    if (capabilityKey === 'chat_open' && name === 'participantId' && Array.isArray(filled.participantIds) && filled.participantIds.length > 0) continue;
    if (!isFilled(filled[name])) {
      if (!missing.includes(name)) missing.push(name);
    }
  }

  if (capabilityKey === 'chat_open' && (!opts?.definition || 'participantIds' in opts.definition.params)) {
    if (!filled.participantId && !(Array.isArray(filled.participantIds) && filled.participantIds.length > 0) && !missing.includes('participantId')) {
      missing.push('participantId');
    }
    if (Array.isArray(filled.participantIds) && !filled.chatId && !filled.idempotencyKey) missing.push('idempotencyKey');
  }

  const hold = opts?.hold;
  const ready = missing.length === 0 && !hold;
  const outcome: NextCallOutcome =
    opts?.outcome ??
    (hold
      ? 'pending'
      : missing.length === 0
        ? 'ok'
        : Object.keys(filled).length
          ? 'partial'
          : 'unavailable');
  const http = HTTP_BINDINGS[capabilityKey];
  const faceWasPassed = strippedFaces.length > 0;
  const reason =
    hold && missing.length === 0
      ? why
      : !ready && faceWasPassed
        ? `${why} — missing ${missing.join(', ')}. a next call for reaching a person names the user id or their agent, never a psn_ face`
        : !ready
          ? `${why} — missing ${missing.join(', ')}`
          : why;

  return {
    tool: toolName(env, capabilityKey),
    ...(Object.keys(filled).length ? { args: filled } : {}),
    why: reason,
    ready,
    outcome,
    ...(missing.length ? { missing } : {}),
    ...(hold ? { hold } : {}),
    ...(http
      ? { http: { method: http.method, path: bindHttpPath(http.path, filled) } }
      : {}),
    ...extra,
  };
}

/**
 * E23: messages, artifacts, and agreement prose are data. They cannot mint
 * a server action. The only legal parse is "none".
 */
export function nextCallsFromUntrustedContent(_content: unknown): NextCall[] {
  return [];
}

/**
 * E22: a next call advertised against an earlier snapshot is stale when the
 * row is no longer in the state that action assumed. Execution still has to
 * hit the existing precondition (claim 400, respond refuse) — this is the
 * client-side invalidation so a caller does not treat the suggestion as live.
 */
export function isStaleAdvertisedAction(
  advertised: Pick<NextCall, 'tool' | 'args'>,
  current: { status?: string | null },
): boolean {
  const key = advertised.tool.replace(/^ziggs_/, '');
  const status = current.status ?? '';
  if (key === 'agreement_claim') {
    return status.length > 0 && status !== 'open';
  }
  if (key === 'agreement_respond') {
    return (
      status.length > 0 &&
      !['open', 'proposed', 'pending'].includes(status)
    );
  }
  return false;
}

/**
 * The other PRINCIPAL in a two-party agreement, from the perspective of
 * `selfId`.
 *
 * This was `peerAgentId`, and it read the `actor` columns — the agents that
 * carried the paperwork. Those became courier info when a link was re-keyed to
 * the two people it belongs to, and on most links they are null, so the hint it
 * fed either pre-filled a call with an agent that is no longer a door or
 * silently vanished because the helper returned nothing.
 *
 * Named for the SLOT, not for what a link happens to put in it. On a link both
 * principals are guaranteed to be people, because links are person-only and
 * both sides are userIds by construction — but the same slots hold an org or an
 * agent on other engagement kinds, so a caller who read "person" here and
 * trusted it on a hire would be wrong. The person guarantee is a link-only
 * property; ask the kind before relying on it.
 *
 * Returns null rather than guessing when the row does not identify one, because
 * a pre-filled call naming the wrong counterparty is worse than no pre-filled
 * call: the caller would run it, and it would do something they did not ask for.
 */
export function peerPrincipalId(
  parties: AgreementParties | undefined,
  selfId: string | undefined,
): string | null {
  if (!parties || !selfId) return null;
  const creator = parties.creator?.principal;
  const provider = parties.provider?.principal;
  if (creator && creator !== selfId) return creator;
  if (provider && provider !== selfId) return provider;
  return null;
}
