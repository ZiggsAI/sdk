import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerTrustTools } from '../src/trustTools.js';

/**
 * ZIG-941 #6 — org-scoped grants may name the org instead of pasting its opaque
 * org_... id. issue_grant / delegate_grant resolve the selector server-side via
 * the (previously dead) resolveOrgSelector: exact id or case-insensitive name,
 * candidates on ambiguity, a pointer to ziggs_org_list on a miss.
 */
type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

const ORGS = [
  { orgId: 'org_personal_1', name: 'Ido', kind: 'personal', role: 'owner' },
  { orgId: 'org_team_abc', name: 'rpg', kind: 'team', role: 'admin' },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function grantBody(id: string) {
  return {
    grant: {
      grantId: `ctx_${id}`,
      scope: { kind: 'org', id },
      caveats: [],
      expiresAt: null,
    },
  };
}

function register(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  };
  registerTrustTools(server as never, { operatorKey: 'op', agentId: 'delegate-a' });
  return tools;
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function mockFetch(handler: (url: string) => Response): Call[] {
  const calls: Call[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return handler(u);
  });
  return calls;
}

function parse(out: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(out.content[0]?.text ?? '{}');
}

describe('org selector resolution on grant tools (ZIG-941 #6)', () => {
  afterEach(() => mock.restoreAll());

  it('ziggs_context_delegate resolves an org name to its id', async () => {
    const calls = mockFetch((u) => {
      if (u.endsWith('/orgs/me')) return json({ orgs: ORGS });
      if (u.includes('/context/grants/') && u.endsWith('/delegate')) {
        return json(grantBody('org_team_abc'));
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    const out = await register().get('ziggs_context_delegate')!({
      parentGrantId: 'ctx_parent',
      holderId: 'peer',
      scopeKind: 'org',
      scopeId: 'rpg',
      temporal: 'from-now',
    });
    assert.equal(parse(out).status, 'delegated');
    const delCall = calls.find((c) => c.url.endsWith('/delegate'));
    assert.ok(delCall, 'expected POST /context/grants/:id/delegate');
    assert.equal((delCall!.body?.scope as { id: string }).id, 'org_team_abc');
  });
});
