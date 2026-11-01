/**
 * ZIG-1461 — `requestMatchTags` was declared on AgentOptions and read at
 * triage, but never copied into the constructor allow-list, so it was always
 * undefined at runtime. The same object dropped `respondsToProposals` once
 * already. These tests fail the instance and the category.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import { pollInboxOnce } from '../src/platform/inboxLoop.js';
import { SeenMessages } from '../src/platform/SeenMessages.js';
import { RequiredContextUnavailable } from '../src/runtime/requiredContext.js';

const HOST_SRC = join(dirname(fileURLToPath(import.meta.url)), '../src/Agent.ts');

/**
 * Fields stored on the instance in the constructor, not on `this.options`.
 * Everything else declared on AgentOptions must have a copy line.
 */
const CONSTRUCTOR_OWNED = new Set(['memory', 'sessionStore']);

function declaredOptionKeys(src: string): string[] {
  const m = src.match(/export interface AgentOptions \{([\s\S]*?)\n\}/);
  assert.ok(m, 'AgentOptions interface not found');
  return [...m[1].matchAll(/^  ([A-Za-z][A-Za-z0-9]*)\??:/gm)].map((x) => x[1]);
}

function copiedOptionKeys(src: string): string[] {
  const m = src.match(/this\.options = \{([\s\S]*?)\n    \} as Required/);
  assert.ok(m, 'constructor allow-list not found');
  return [...m[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)].map((x) => x[1]);
}

const makeHost = (extra: Record<string, unknown> = {}) =>
  new Agent({
    agentId: 'agent-me',
    operatorKey: 'op-key',
    anthropicKey: 'test-key',
    initial: 'ready',
    states: { ready: { kind: 'parked' as const, transitions: [] } },
    inboxCatchUp: false,
    ...extra,
  });

type Internals = {
  options: { requestMatchTags?: string[]; telemetryIngest?: boolean; specialization?: string | null };
  triageRequestDelivery(request: {
    agreementId: string;
    match: string;
    title: string;
    ts: string;
  }): Promise<void>;
  handleMessage(text: string, metadata?: Record<string, unknown>): Promise<void>;
};

describe('AgentOptions allow-list (ZIG-1461)', () => {
  it('copies every declared option except constructor-owned fields', () => {
    const src = readFileSync(HOST_SRC, 'utf8');
    const declared = declaredOptionKeys(src);
    const copied = new Set(copiedOptionKeys(src));
    const missing = declared.filter((k) => !copied.has(k) && !CONSTRUCTOR_OWNED.has(k));
    assert.deepEqual(
      missing,
      [],
      `allow-list dropped: ${missing.join(', ')}. A field left out of this.options is silently undefined at runtime.`,
    );
  });

  it('keeps requestMatchTags on the host so triage can see them', () => {
    const host = makeHost({ requestMatchTags: ['email', 'calendar'] });
    const opts = (host as unknown as Internals).options;
    assert.deepEqual(opts.requestMatchTags, ['email', 'calendar']);
  });

  it('does not wake on an open request whose match is not in the tags', async () => {
    const host = makeHost({ requestMatchTags: ['email'] });
    const internals = host as unknown as Internals;
    const woken: string[] = [];
    internals.handleMessage = async (text) => {
      woken.push(text);
    };
    await internals.triageRequestDelivery({
      agreementId: 'agr_other',
      match: 'plumbing',
      title: 'fix a pipe',
      ts: '2026-08-21T00:00:00.000Z',
    });
    assert.deepEqual(woken, []);
  });

  it('wakes on an open request that matches a copied tag', async () => {
    const host = makeHost({ requestMatchTags: ['email'] });
    const internals = host as unknown as Internals;
    const woken: string[] = [];
    internals.handleMessage = async (text) => {
      woken.push(text);
    };
    await internals.triageRequestDelivery({
      agreementId: 'agr_mail',
      match: 'email',
      title: 'sort my inbox',
      ts: '2026-08-21T00:00:00.000Z',
    });
    assert.equal(woken.length, 1);
    assert.match(woken[0], /agr_mail|sort my inbox|email/);
  });
});

describe('a matching marketplace request wake', () => {
  afterEach(() => mock.restoreAll());
  const request = { agreementId: 'agr_mail', match: 'email', title: 'sort my inbox', ts: '2026-08-21T00:00:00.000Z' };

  it('names the request by its agreement, with no made-up message or conversation', async () => {
    const host = makeHost({ requestMatchTags: ['email'] });
    const internals = host as unknown as Internals;
    const metadata: Array<Record<string, unknown>> = [];
    internals.handleMessage = async (_text, meta) => { metadata.push(meta ?? {}); };
    await internals.triageRequestDelivery(request);
    assert.deepEqual(metadata, [{ agreementId: 'agr_mail' }]);
  });

  it('reads the request by its agreement and never as a message or an address', async () => {
    const host = makeHost({ requestMatchTags: ['email'] });
    const urls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: unknown) => {
      urls.push(String(url));
      return Response.json({ history: [], agents: [], users: [], agreements: [{ agreementId: 'agr_mail' }], work: { minimumComplete: true } });
    });
    let woke = false;
    (host as unknown as { brain: unknown }).brain = {
      workflow: { id: 'test', initial: 'ready', states: { ready: { kind: 'parked', transitions: [] } } },
      tick: async ({ eff, identity }: { eff: (e: unknown) => Promise<unknown>; identity: { sessionId: string } }) => {
        woke = true;
        await eff({ kind: 'read-context', sessionId: identity.sessionId });
        return { ctx: {}, state: 'ready', parked: true, stateTimeoutUnhandled: false };
      },
    };
    await (host as unknown as Internals).triageRequestDelivery(request);
    assert.equal(woke, true);
    const reads = urls.filter((u) => u.includes('/context/snapshot'));
    assert.equal(reads.length, 1);
    assert.equal(new URL(reads[0]).searchParams.get('via'), 'agreement:agr_mail');
    assert.equal(urls.some((u) => u.includes('/messaging/messages/') || u.includes('marketplace%3A') || u.includes('request-wake')), false);
    await host.disconnect();
  });

  it('a wake that cannot read the request does not hold the rest of the inbox pass', async () => {
    const host = makeHost({ requestMatchTags: ['email'] });
    const internals = host as unknown as Internals;
    internals.handleMessage = async () => { throw new RequiredContextUnavailable(); };
    const acks: string[] = [];
    mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/inbox/ack')) { acks.push(...JSON.parse(String(init?.body)).handledDeliveryIds); return Response.json({ ackedUpTo: 'token' }); }
      return Response.json({ deliveries: [], ackTo: 'token', tasksAwaitingMe: [], proposalsAwaitingMe: [], connectionRequestsAwaitingMe: [],
        openRequestsAwaitingMe: [{ ...request, receiptId: 'rcp_request' }] });
    });
    const result = await pollInboxOnce({ creds: { operatorKey: 'op', agentId: 'agent-me' }, ownAgentId: 'agent-me', baseUrl: 'http://test', seen: new SeenMessages(),
      onMessage: async () => {}, onResourceEvent: async () => {}, onRequest: (r) => internals.triageRequestDelivery(r) });
    assert.equal(result.failures, 0);
    assert.equal(result.acked, true);
    assert.deepEqual(acks, ['rcp_request']);
  });
});
