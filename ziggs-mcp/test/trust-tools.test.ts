import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('ZIG-433 trust MCP wiring', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('ziggs_agent_search uses agent search endpoint', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    const { registerTrustTools } = await import('../src/trustTools.js');
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
        tools.set(name, handler);
      },
    };

    registerTrustTools(server as never, { operatorKey: 'op', agentId: 'delegate-a' });
    await tools.get('ziggs_agent_search')!({ query: 'newsletter' });
    assert.match(calls[0] ?? '', /\/agents\/search/);
  });

  it('the link rail registers exactly propose + list', async () => {
    const { registerTrustTools } = await import('../src/trustTools.js');
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
        tools.set(name, handler);
      },
    };

    registerTrustTools(server as never, { operatorKey: 'op', agentId: 'delegate-a' });
    const names = [...tools.keys()];
    // Requesting/claiming/revoking a link ride the agreement verbs now.
    // ZIG-1478: `ziggs_link_create_invite` is gone — minting a share link is the
    // same act as naming someone, so one verb takes an email, an agent id, or
    // nothing.
    assert.ok(names.includes('ziggs_link_propose'));
    assert.ok(names.includes('ziggs_link_list'));
    assert.ok(!names.includes('ziggs_link_create_invite'));
    assert.ok(!names.includes('ziggs_request_link'));
    assert.ok(!names.includes('ziggs_agreement_claim'), 'claim registers with the agreement verbs, not the trust group');
    assert.ok(!names.includes('ziggs_revoke_link'));
  });

  it('ziggs_link_list lists link agreements and adds nextSteps when active', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          agreements: [
            { agreementId: 'agr_1', engagementKind: 'link', status: 'active' },
          ],
        }),
        { status: 200 },
      );
    });

    const { registerTrustTools } = await import('../src/trustTools.js');
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
        tools.set(name, handler);
      },
    };

    registerTrustTools(server as never, { operatorKey: 'op', agentId: 'delegate-a' });
    const out = (await tools.get('ziggs_link_list')!({})) as {
      content: { text: string }[];
    };
    const parsed = JSON.parse(out.content[0]?.text ?? '{}') as {
      count?: number;
      nextSteps?: string;
    };
    assert.equal(parsed.count, 1);
    assert.ok(parsed.nextSteps?.includes('ziggs_chat_open'));
    assert.match(calls[0] ?? '', /engagementKind=link/);
  });
});
