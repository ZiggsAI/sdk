/**
 * ZIG-1418 / ZIG-2116 — the hosted brain offers every tool by its own name;
 * everyday and own tools load up front, the rest wait for tool search.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../src/Agent.js';
import { ARTIFACT_TOOLS } from '../src/platform/tools/tier2/artifactTools.js';
import { defineTool, toolName, type ToolDefinition } from '../src/tools/defineTool.js';
import { hostedModelTools, isHostedDeferred } from '../src/brain/hostedToolSurface.js';
import { buildSdkToolDefs } from '../src/brain/toolManagerToSdkMcp.js';

const CLAUDE = {
  cognition: 'claude-sdk' as const,
  anthropicKey: 'sk-ant-test',
  operatorKey: 'op-key',
  agentId: 'claude-agent',
  description: 'A hired Claude agent',
};

function names(tools: ToolDefinition[]): string[] {
  return tools.map((t) => toolName(t) ?? '');
}

function bytes(tools: ToolDefinition[]): number {
  return Buffer.byteLength(JSON.stringify(tools.map((t) => t.schema.function)));
}

describe('hosted model tool block (ZIG-2116)', () => {
  it('offers every tool by its own name, with no catalog in between', async () => {
    const own = defineTool('invoice_start', {}, async () => ({ ok: true }), {
      description: 'Start an invoice the agent owns.',
    });
    const host = createAgent({ ...CLAUDE, tools: [...ARTIFACT_TOOLS, own] });
    const registered = await host.toolManager.getAvailableTools();
    const mounted = hostedModelTools(registered);

    assert.deepEqual(new Set(names(mounted)), new Set(names(registered)));
    for (const gone of ['tools', 'tool_read', 'tool_write'])
      assert.equal(names(mounted).includes(gone), false, `${gone} is still mounted`);
  });

  it('loads everyday and own tools up front and defers the rest of the platform', async () => {
    const own = defineTool('invoice_start', {}, async () => ({ ok: true }), {
      description: 'Start an invoice the agent owns.',
    });
    const host = createAgent({ ...CLAUDE, tools: [...ARTIFACT_TOOLS, own] });
    const mounted = hostedModelTools(await host.toolManager.getAvailableTools());
    for (const loaded of ['chat_open', 'chat_send', 'context_read', 'open', 'task_set_result', 'agreement_revoke', 'invoice_start'])
      assert.equal(isHostedDeferred(loaded), false, `${loaded} should load up front`);
    for (const deferred of ['agreement_propose', 'agreement_subcontract', 'agreement_get', 'wake_at', 'context_snapshot', 'task_list', 'grant_list', 'marketplace_view', 'artifact_record', 'artifact_list'])
      assert.equal(isHostedDeferred(deferred), true, `${deferred} should be deferred`);

    // What rides every wake is well under the whole set.
    const upFront = mounted.filter((t) => !isHostedDeferred(toolName(t) ?? ''));
    assert.ok(bytes(upFront) * 2 < bytes(mounted), `up front ${bytes(upFront)} is not under half of ${bytes(mounted)}`);
  });

  it('marks each SDK tool for the Agent SDK to load or defer', () => {
    const everyday = defineTool('chat_send', {}, async () => ({}), { description: 'Send.' });
    const platform = defineTool('agreement_get', {}, async () => ({}), { description: 'Get.' });
    const defs = buildSdkToolDefs([everyday, platform], () => ({}) as never, (name) => !isHostedDeferred(name));
    const meta = Object.fromEntries(defs.map((d) => [d.name, (d as { _meta?: Record<string, unknown> })._meta?.['anthropic/alwaysLoad']]));
    assert.deepEqual(meta, { chat_send: true, agreement_get: false });
  });

  it('lets a default hosted agent call a deferred recovery tool by its own name', async (t) => {
    const calls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ status: 'restricted', actions: [] }));
    });
    const host = createAgent({ ...CLAUDE, tools: ARTIFACT_TOOLS });
    const result = await host.toolManager.executeTool('access_explain', { ref: 'artifact_restricted' }, {
      operatorKey: 'op-key',
      agentId: 'claude-agent',
    });
    assert.equal((result as { status: string }).status, 'restricted');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/context\/access\/explain$/);
  });
});
