/**
 * one shared definition per SDK/MCP tool capability.
 *
 * The tool-surface-parity epic (→903) unified the HTTP layer here in
 * api-client but left ~25 shared capabilities hand-written twice: once in the
 * agent-sdk's defineTool DSL, once in ziggs-mcp zod. Each capability below is
 * the single source for the tool's schema, validation, response shaping, and
 * guidance; the two surfaces register it through thin adapters
 * (agent-sdk `toolFromCapability`, ziggs-mcp `registerCapability`).
 *
 * Params are a neutral JSON-schema-flavoured DSL rather than zod because the
 * two surfaces cannot share one zod: agent-sdk is on zod v4, ziggs-mcp on
 * zod v3 (pinned by the MCP SDK's ZodRawShape), and api-client deliberately
 * has no zod dependency. The SDK adapter feeds params straight into
 * defineTool's converter; the MCP adapter lowers them to zod v3.
 */
import { decodeOperatorKeyClaims } from '../shared/operatorKey.js';
import type { Creds } from '../types.js';

export type CapabilitySurface = 'sdk' | 'mcp';

/** read-only / write / destructive — lowered to MCP tool annotations. */
export type CapabilityAnnotation = 'read-only' | 'write' | 'destructive';

export interface CapabilityParam {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  description?: string;
  /** Only for type 'string'. */
  enum?: readonly string[];
  /** Only for type 'array'. */
  items?: { type: 'string'; enum?: readonly string[] } | { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

/**
 * Runtime context a surface adapter hands the shared handler. `creds.agentId`
 * may be absent for agent-scoped operator keys (payments rail); capabilities
 * that impersonate set `needsAgentId` so the adapter fails early instead.
 */
export interface CapabilityEnv {
  /** Validated wake scope supplied by the host; never a resource-access grant. */
  serviceAgreementId?: string;
  creds: { operatorKey: string; agentId?: string; laneId?: string };
  /** SDK runner base-URL override (BACKEND_URL / ZIGGS_BACKEND_URL). */
  baseUrl?: string;
  /** Web-app origin for human-facing URLs (claim links etc.). */
  webUrl?: string;
  surface: CapabilitySurface;
}

export interface CapabilityDefinition {
  /** Stable capability key (the parity-table base name), e.g. 'payment_transfer'. */
  key: string;
  /** Registered tool name per surface — the parity table is the authority. */
  names: { sdk: string; mcp: string };
  /**
   * Human-readable label a host shows instead of the raw `rail_verb` name.
   * Required: a tool with no title displays as its wire name, and the
   * connector directory rejects the surface for it. One title for both
   * surfaces — the wire name differs per surface, the action it performs
   * does not. Phrase it as that action, and keep it product copy: this is
   * what a person reads in the tool picker.
   */
  title: string;
  /**
   * The SDK tool description. The MCP one is rendered from the tool's brief
   * in `mcpBriefs.ts`, keyed by `names.mcp`, so every MCP
   * description has the same shape and fits the clients' limits.
   */
  descriptions: { sdk: string };
  annotation: CapabilityAnnotation;
  params: Record<string, CapabilityParam>;
  /** True when the handler impersonates an agent (X-Agent-Id required). */
  needsAgentId?: boolean;
  handler: (args: Record<string, unknown>, env: CapabilityEnv) => Promise<unknown>;
  /** Pass-through flags for the SDK's defineTool options. */
  sdkOptions?: {
    isAgreementCreation?: boolean;
    isGenericFallback?: boolean;
  };
}

/** Creds for impersonated calls; adapters guarantee agentId when needsAgentId. */
export function fullCreds(env: CapabilityEnv): Creds {
  const { operatorKey, agentId, laneId } = env.creds;
  if (!operatorKey) throw new Error('operatorKey missing from tool context');
  if (!agentId && !decodeOperatorKeyClaims(operatorKey)?.connectionClientId) throw new Error('agentId missing from tool context');
  // the lane rides along so every Creds-based client sends
  // X-Ziggs-Lane without each capability having to remember to.
  return { operatorKey, agentId: agentId ?? '', ...(laneId ? { laneId } : {}) };
}

interface CarriedError extends Error {
  status?: number;
  body?: string;
}

/**
 * Re-throw a client error with a capability-level prefix, preserving the HTTP
 * status/body the clients attach (the SDK runtime and toolError classification
 * both read them).
 */
export function rethrowWithContext(error: unknown, prefix: string): never {
  const e = error as CarriedError & { code?: string | null };
  const wrapped = new Error(`${prefix}: ${e.message}`) as CarriedError & {
    code?: string | null;
  };
  if (e.status !== undefined) wrapped.status = e.status;
  if (e.body !== undefined) wrapped.body = e.body;
  // keep the machine code so toolError can classify without prose.
  if (typeof e.code === 'string' && e.code) wrapped.code = e.code;
  (wrapped as unknown as Record<string, unknown>)['cause'] = error;
  throw wrapped;
}
