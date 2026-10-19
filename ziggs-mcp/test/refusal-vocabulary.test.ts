import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool } from './support/surface.js';

/**
 * ZIG-2118 — one answer for "you cannot read this", whichever tool asked.
 *
 * The server judges a resource once (open / access_explain): readable,
 * unreadable with a request to make, or hidden, and hidden looks exactly like
 * missing. Every read tool answers in that vocabulary: RESOURCE_HIDDEN,
 * RESOURCE_UNREADABLE (with the request open would offer), INVALID_INPUT.
 */

type Judgement = 'ok' | 'hidden' | 'unreadable';

/** What open / access_explain answer for one id, in the server's shape. */
function verdict(kind: string, id: string, outcome: Judgement) {
  return {
    outcome,
    ref: { kind, id },
    access: { summary: outcome === 'hidden' ? 'This resource is not available.' : 'You cannot read this yet.' },
    workContext: { laneId: null },
    actions:
      outcome === 'unreadable'
        ? [{
            action: 'read',
            scope: { kind, id },
            state: 'needs_decision',
            tool: 'access_request',
            args: { scopeKind: kind, scopeId: id, permission: 'read', durationHours: 24 },
            required: ['reason'],
          }]
        : [],
  };
}

/**
 * The backend, as far as these reads go: `get` is what GET /agreements/:id or
 * /tasks/:id answers, `judgement` is what open and access_explain say.
 */
function backend(get: { status: number; body?: unknown }, judgement: Judgement) {
  mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes('/context/access/explain') || u.includes('/context/open')) {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, string>;
      const [key] = Object.keys(body).filter((k) => k.endsWith('Id'));
      // open now names its record by ref; the kind is read from the id.
      const ref = body.ref ?? '';
      const kind = key
        ? key.replace(/Id$/, '')
        : ref.startsWith('agr')
          ? 'agreement'
          : ref.startsWith('art')
            ? 'artifact'
            : ref.startsWith('task')
              ? 'task'
              : 'chat';
      return new Response(JSON.stringify(verdict(kind, key ? body[key]! : body.ref!, judgement)), { status: 200 });
    }
    if (u.includes('/agents/')) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), { status: 404 });
    }
    return new Response(JSON.stringify(get.body ?? { error: 'refused' }), { status: get.status });
  });
}

async function connected(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'refusals', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

type Answer = { isError: boolean; code?: string; outcome?: string; requestTool?: string; text: string };

async function ask(tool: string, args: Record<string, unknown>): Promise<Answer> {
  const client = await connected();
  const result = (await callZiggsTool(client, tool, args)) as {
    isError?: boolean;
    content: Array<{ text?: string }>;
  };
  await client.close();
  const text = result.content.map((c) => c.text ?? '').join('');
  const parsed = JSON.parse(text) as {
    error?: { code?: string; outcome?: string; actions?: Array<{ tool?: string }> };
    outcome?: string;
    actions?: Array<{ tool?: string }>;
  };
  const body = parsed.error ?? parsed;
  return {
    isError: result.isError === true,
    code: parsed.error?.code,
    outcome: body.outcome,
    requestTool: body.actions?.find((a) => a.tool?.includes('access_request'))?.tool,
    text,
  };
}

describe('ZIG-2118 — one refusal vocabulary across read tools', () => {
  afterEach(() => mock.restoreAll());

  // [tool, args, what its own GET answers]
  const gets = [
    ['ziggs_agreement_get', { agreementId: 'agr_x' }, 'agreement'],
    ['ziggs_task_get', { taskId: 'task_x' }, 'task'],
  ] as const;

  for (const [tool, args, kind] of gets) {
    // Both ways a server refuses a get: 404, and the task route's 403 "not a party".
    for (const status of [404, 403]) {
      it(`${tool}: a ${status} on something hidden or missing is RESOURCE_HIDDEN, like open`, async () => {
        backend({ status, body: { error: status === 403 ? 'not a party of task' : 'Not found' } }, 'hidden');
        const got = await ask(tool, args);
        const opened = await ask('ziggs_open', { ref: Object.values(args)[0] });
        assert.equal(got.code, 'RESOURCE_HIDDEN');
        assert.equal(got.outcome, 'hidden');
        assert.equal(opened.outcome, got.outcome);
        assert.doesNotMatch(got.text, /not a party|Agreement not found/);
      });

      it(`${tool}: a ${status} on something that exists and can be asked for is RESOURCE_UNREADABLE with open's request`, async () => {
        backend({ status }, 'unreadable');
        const got = await ask(tool, args);
        const opened = await ask('ziggs_open', { ref: Object.values(args)[0] });
        assert.equal(got.code, 'RESOURCE_UNREADABLE');
        assert.equal(got.outcome, 'unreadable');
        assert.equal(got.requestTool, 'ziggs_access_request');
        assert.equal(opened.outcome, 'unreadable');
        assert.equal(opened.requestTool, got.requestTool);
        void kind;
      });
    }

    it(`${tool}: a refusal the judgement does not explain keeps its own answer`, async () => {
      backend({ status: 403, body: { error: 'not authorized' } }, 'ok');
      const got = await ask(tool, args);
      assert.equal(got.code, 'NOT_AUTHORIZED');
    });
  }

  for (const kind of ['chat', 'artifact'] as const) {
    it(`ziggs_open on a hidden ${kind} says hidden, and an unreadable one offers the same request`, async () => {
      backend({ status: 404 }, 'hidden');
      const id = kind === 'chat' ? 'eufateaglljwkqosgycqxhbj' : 'art_1791956531449_ab12cd34';
      assert.equal((await ask('ziggs_open', { ref: id })).outcome, 'hidden');
      mock.restoreAll();
      backend({ status: 404 }, 'unreadable');
      const opened = await ask('ziggs_open', { ref: id });
      assert.equal(opened.outcome, 'unreadable');
      assert.equal(opened.requestTool, 'ziggs_access_request');
    });
  }

  it('ziggs_agent_get: a missing agent is RESOURCE_HIDDEN, with nothing to request', async () => {
    backend({ status: 404 }, 'hidden');
    const got = await ask('ziggs_agent_get', { agentId: 'agent_nope' });
    assert.equal(got.code, 'RESOURCE_HIDDEN');
    assert.equal(got.requestTool, undefined);
  });

  it('ziggs_open with no ref, or a mistyped handle, is INVALID_INPUT and names no internal class', async () => {
    backend({ status: 404 }, 'hidden');
    for (const args of [{ ref: '' }, { ref: 'T7K2QX0' }]) {
      const got = await ask('ziggs_open', args);
      assert.equal(got.code, 'INVALID_INPUT');
      assert.doesNotMatch(got.text, /ContextOpenClient/);
    }
  });

  it('a get no workspace of the connection can route to is RESOURCE_HIDDEN, not the routing refusal', async () => {
    // The multi-workspace routing guard refuses before the read, and refuses
    // the judgement the same way.
    mock.method(globalThis, 'fetch', async () =>
      new Response(
        JSON.stringify({
          code: 'RESOURCE_NOT_ACCESSIBLE',
          message: 'No assistant in this connection can act on the addressed resource. Name a workspace when requesting new access.',
        }),
        { status: 403 },
      ),
    );
    for (const [tool, args] of gets) {
      const got = await ask(tool, args);
      assert.equal(got.code, 'RESOURCE_HIDDEN');
      assert.doesNotMatch(got.text, /Name a workspace/);
    }
  });
});
