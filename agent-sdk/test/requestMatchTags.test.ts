/**
 * ZIG-1461 — `requestMatchTags` was declared on AgentOptions and read at
 * triage, but never copied into the constructor allow-list, so it was always
 * undefined at runtime. The same object dropped `respondsToProposals` once
 * already. These tests fail the instance and the category.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';

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
