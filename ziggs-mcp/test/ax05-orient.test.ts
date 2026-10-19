import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

function jsonResult(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return JSON.parse(content.map((c) => c.text ?? '').join('')) as Record<
    string,
    unknown
  >;
}

async function connectedClient(): Promise<Client> {
  const token = `e30.${Buffer.from(
    JSON.stringify({ ownerId: 'usr_human', boundAgentId: 'assistant-1' }),
  ).toString('base64url')}.sig`;
  const server = createZiggsMcpServer(
    { operatorKey: token, agentId: 'assistant-1' } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ax05-orient', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe('AX-05 orientation (ZIG-1876)', () => {
  afterEach(() => mock.restoreAll());

  it('peek is native and read-only', async () => {
    const client = await connectedClient();
    const listed = await client.listTools();
    const peek = listed.tools.find((t) => t.name === 'ziggs_inbox_peek');
    assert.ok(peek, 'ziggs_inbox_peek is native');
    assert.equal(peek!.annotations?.readOnlyHint, true);
    const surface = await surfaceTools(client);
    assert.ok(surface.some((t) => t.name === 'ziggs_inbox_peek'));
    await client.close();
  });

  it('E01/E18: session names the represented person and manual continuation', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('/orgs/me')) {
        return new Response(
          JSON.stringify({
            activeOrgId: 'org-1',
            orgs: [{ orgId: 'org-1', name: 'Acme', kind: 'team' }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_auth_status', {});
    const parsed = jsonResult(result);
    assert.deepEqual(parsed.representedPerson, {
      id: 'usr_human',
      kind: 'user',
    });
    const continuation = parsed.continuation as { kind?: string };
    assert.equal(continuation.kind, 'manual');
    const handling = parsed.inboxHandling as {
      ackDriver?: string;
      peekDoesNotAcquire?: boolean;
    };
    assert.equal(handling.ackDriver, 'agent');
    assert.equal(handling.peekDoesNotAcquire, true);
    await client.close();
  });

  it('E25: peek hits /inbox/peek, never GET /inbox', async () => {
    const hits: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      const u = String(url);
      hits.push(u);
      if (u.includes('/orgs/me')) {
        return new Response(
          JSON.stringify({
            activeOrgId: 'org-1',
            orgs: [{ orgId: 'org-1', name: 'Acme', kind: 'team' }],
          }),
          { status: 200 },
        );
      }
      if (u.includes('/inbox/peek')) {
        return new Response(
          JSON.stringify({ asOf: '2026-09-17T00:00:00.000Z', count: 2 }),
          { status: 200 },
        );
      }
      if (u.includes('/tasks')) {
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_inbox_peek', {});
    const parsed = jsonResult(result);
    assert.deepEqual(parsed.peek, {
      asOf: '2026-09-17T00:00:00.000Z',
      count: 2,
    });
    const session = parsed.session as { representedPerson?: { id?: string } };
    assert.equal(session.representedPerson?.id, 'usr_human');
    assert.equal(
      hits.some((h) => /\/inbox(\?|$)/.test(h) && !h.includes('/inbox/peek')),
      false,
      'peek must not acquire via GET /inbox',
    );
    assert.ok(hits.some((h) => h.includes('/inbox/peek')));
    await client.close();
  });

  it('E21: a failed peek still returns session, not a false empty mailbox', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('/orgs/me')) {
        return new Response(
          JSON.stringify({
            activeOrgId: 'org-1',
            orgs: [{ orgId: 'org-1', name: 'Acme', kind: 'team' }],
          }),
          { status: 200 },
        );
      }
      if (u.includes('/inbox/peek')) {
        return new Response('nope', { status: 500 });
      }
      if (u.includes('/tasks')) {
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const client = await connectedClient();
    const result = await callZiggsTool(client, 'ziggs_inbox_peek', {});
    const parsed = jsonResult(result);
    assert.equal(parsed.peek, undefined);
    assert.equal(typeof parsed.peekFetchError, 'string');
    const session = parsed.session as { representedPerson?: { id?: string } };
    assert.equal(session.representedPerson?.id, 'usr_human');
    assert.equal(parsed.hasActiveWork, false);
    await client.close();
  });
});
