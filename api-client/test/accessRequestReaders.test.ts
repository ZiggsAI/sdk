import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { accessRequestCapability } from '../src/capabilities/context.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';

const env: CapabilityEnv = {
  creds: { operatorKey: 'op', agentId: 'coord-agent' },
  surface: 'mcp',
};
const ask = {
  scopeKind: 'artifact',
  scopeId: 'art_budget',
  chatId: 'room_1',
  recipientId: 'ido',
  reason: 'Luke and Itay review the budget',
};

describe('access_request for named readers', () => {
  afterEach(() => mock.restoreAll());

  it('sends the readers and returns each one’s outcome with the pending card', async () => {
    let sent: Record<string, unknown> = {};
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          status: 'pending_approval',
          agreementId: 'agr_1',
          accessGranted: false,
          readers: [
            { kind: 'agent', id: 'luke-agent', outcome: 'awaiting_approval' },
            { kind: 'user', id: 'itay', outcome: 'already_readable' },
          ],
          message: 'Sent to Ido. Ido approves it in this room.',
        }),
        { status: 201 },
      );
    });
    const out = (await accessRequestCapability.handler(
      {
        ...ask,
        holders: [
          { kind: 'agent', id: 'luke-agent' },
          { kind: 'user', id: ' itay ' },
        ],
      },
      env,
    )) as { outcome: string; readers: Array<{ outcome: string }>; appUrl: string };
    assert.deepEqual(sent.holders, [
      { kind: 'agent', id: 'luke-agent' },
      { kind: 'user', id: 'itay' },
    ]);
    assert.equal(out.outcome, 'pending');
    assert.deepEqual(
      out.readers.map((r) => r.outcome),
      ['awaiting_approval', 'already_readable'],
    );
    assert.match(out.appUrl, /agr_1/);
  });

  it('says nothing was asked when every reader already reads it', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response(
        JSON.stringify({
          status: 'already_readable',
          agreementId: null,
          accessGranted: false,
          readers: [{ kind: 'agent', id: 'luke-agent', outcome: 'already_readable' }],
          message: 'Every reader you named can already read it. Nothing was asked.',
        }),
        { status: 201 },
      ),
    );
    const out = (await accessRequestCapability.handler(
      { ...ask, holders: [{ kind: 'agent', id: 'luke-agent' }] },
      env,
    )) as { outcome: string; appUrl?: string; note: string };
    assert.equal(out.outcome, 'already_readable');
    assert.equal(out.appUrl, undefined);
    assert.match(out.note, /Nothing was asked/);
  });

  it('refuses readers outside one artifact to read, before any call', async () => {
    const fetched = mock.method(globalThis, 'fetch', async () => new Response('{}'));
    await assert.rejects(
      accessRequestCapability.handler(
        { ...ask, scopeKind: 'chat', holders: [{ kind: 'agent', id: 'a' }] },
        env,
      ),
      /one artifact/,
    );
    await assert.rejects(
      accessRequestCapability.handler(
        { ...ask, holders: [{ kind: 'agent', id: 'a' }, { kind: 'agent', id: 'a' }] },
        env,
      ),
      /twice/,
    );
    await assert.rejects(
      accessRequestCapability.handler({ ...ask, holders: [{ kind: 'robot', id: 'a' }] }, env),
      /kind/,
    );
    await assert.rejects(accessRequestCapability.handler({ ...ask, holders: [] }, env), /1 to 20/);
    assert.equal(fetched.mock.callCount(), 0);
  });
});
