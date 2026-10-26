import { GrantsClient } from '../http/GrantsClient.js';
import {
  GRANT_SCOPE_KINDS,
  type GrantScopeKind,
  type GrantHealth,
} from '../http/grants.js';
import { type CapabilityDefinition, fullCreds } from './types.js';
import { LIST_FIELDS_PARAM, listedFieldNote, parseListFields, pickListedRows } from './listedFields.js';

// BOTH the tool's param enum and its validator, so a missing kind makes the
// filter the description advertises fail validation. Derived from the canonical
// list next to the type rather than restated, because that is exactly how
// `artifact` came to be advertised but not accepted.
const SCOPE_KINDS: readonly GrantScopeKind[] = GRANT_SCOPE_KINDS;
const HEALTHS: readonly GrantHealth[] = ['active', 'expired', 'revoked'];

function parseScopeKinds(raw: unknown): GrantScopeKind[] | undefined {
  if (raw == null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const out: GrantScopeKind[] = [];
  for (const r of list) {
    if (!SCOPE_KINDS.includes(r as GrantScopeKind)) {
      throw new Error(`scopeKind must be one of ${SCOPE_KINDS.join(', ')}`);
    }
    if (!out.includes(r as GrantScopeKind)) out.push(r as GrantScopeKind);
  }
  return out.length ? out : undefined;
}

/**
 * the single "what authority do I hold?" tool. One name, every rail
 * (context chat/agreement/org/artifact/task, connection, wallet, consent,
 * inbox), holder-scoped,
 * cross-session. `unreadableRails` comes from the backend so a short
 * list is never presented as complete when the key can't read a rail.
 *
 * HOLD, not reach. `GET /grants` lists rows this holder is named on, and taking
 * part in a room or being party to a live agreement now IS such a row. Two kinds
 * of access still leave none: authoring an artifact, and the org memberships
 * that make an ORG-held grant cover you (the row names the org, not you). So a
 * reader can still be entitled to something this list will never mention, and
 * the description says so, because the old "the single answer" wording was read
 * as completeness and an empty list as "no access".
 */
export const listGrantsCapability: CapabilityDefinition = {
  key: 'grant_list',
  names: { sdk: 'grant_list', mcp: 'ziggs_grant_list' },
  title: 'List grants you hold',
  descriptions: {
    sdk: 'List grants this agent holds — or, with role=issuer, grants this agent caused (author-shares and delegate children). Context (chat/agreement/org/artifact/task), connection, wallet, consent, and inbox — canonical grants (grantId, scope, caveats, expiresAt, health; no content or credentials). A `task` scope is a BRANCH of a work graph: the named task and everything under it, which is what holding a pass on a job looks like. Default role=holder answers "what grants do I HOLD?", which is narrower than "what can I reach?": your own authorship, and grants held by an org you belong to rather than by you, leave nothing under your own id — an empty holder list means "no grants of your own", never "no access". role=issuer answers "who did I share with / what did I mint?" after artifact_share. Filter by scopeKind, scopeId, and health (defaults to active). Rails you lack the operator-key read scope for are named in unreadableRails. Cursor-paginated.',
  },
  annotation: 'read-only',
  params: {
    role: {
      type: 'string',
      enum: ['holder', 'issuer'],
      description:
        'holder (default): grants you hold. issuer: grants you caused — author-shares you made and delegate children you minted (not your human owner\'s full issuer view).',
    },
    scopeKind: {
      type: 'array',
      items: { type: 'string', enum: SCOPE_KINDS },
      description:
        'Rail filter (repeatable): chat | agreement | org | artifact (context) | connection | wallet. Omit for every rail you can read.',
    },
    scopeId: {
      type: 'string',
      description:
        'Narrow to one resource id (e.g. one artifactId) within the rails above.',
    },
    health: {
      type: 'string',
      enum: HEALTHS,
      description: 'Grant health filter. Defaults to active (live grants only).',
    },
    cursor: { type: 'string', description: 'Opaque cursor from a prior nextCursor to page' },
    limit: { type: 'number', description: 'Page size (server default when omitted)' },
    fields: LIST_FIELDS_PARAM,
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const scopeKind = parseScopeKinds(args['scopeKind']);
    const healthArg = args['health'] as string | undefined;
    if (healthArg !== undefined && !HEALTHS.includes(healthArg as GrantHealth)) {
      throw new Error(`health must be one of ${HEALTHS.join(', ')}`);
    }
    const roleArg = args['role'] as string | undefined;
    if (roleArg !== undefined && roleArg !== 'holder' && roleArg !== 'issuer') {
      throw new Error('role must be holder or issuer');
    }
    const { items, nextCursor, unreadableRails } = await new GrantsClient(
      creds.operatorKey,
      creds.agentId,
      env.baseUrl,
      // The lane, so the server answers with the grants THIS wake may spend
      // rather than everything the agent holds across every customer.
      creds.laneId,
    ).listGrants({
      scopeKind,
      scopeId: typeof args['scopeId'] === 'string' ? args['scopeId'] : undefined,
      role: roleArg as 'holder' | 'issuer' | undefined,
      // Reach = live grants only by default; pass health to see expired/revoked.
      health: (healthArg as GrantHealth | undefined) ?? 'active',
      cursor: args['cursor'] as string | undefined,
      limit: typeof args['limit'] === 'number' ? (args['limit'] as number) : undefined,
    });
    const fields = parseListFields(args['fields']);
    return {
      count: items.length,
      grants: pickListedRows(items as unknown[], fields),
      ...listedFieldNote(items as unknown[], fields),
      nextCursor,
      ...(unreadableRails?.length ? { unreadableRails } : {}),
    };
  },
  sdkOptions: { isGenericFallback: true },
};

export const GRANTS_CAPABILITIES: CapabilityDefinition[] = [listGrantsCapability];
