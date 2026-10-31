import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendChatMessage } from '../src/http/ChatClient.js';

const CREDS = { operatorKey: 'op', agentId: 'agent-a' };

function mockFetch(
  responder: (url: string, init?: RequestInit) => Response,
): Array<{ url: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return responder(String(url), init);
  });
  return calls;
}

describe('sendChatMessage to an existing participant', () => {
  afterEach(() => mock.restoreAll());

  it('POSTs /messaging/addresses/messages when to is set and addressId is omitted', async () => {
    const calls = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            message: 'ok',
            messageId: 'm1',
            addressId: 'pair-1',
          }),
          { status: 200 },
        ),
    );

    const res = await sendChatMessage(
      { to: 'user-buyer', text: 'hi', messageId: 'm1' },
      CREDS,
    );

    assert.equal(res.addressId, 'pair-1');
    assert.match(calls[0]?.url ?? '', /\/messaging\/addresses\/messages$/);
    assert.equal(calls[0]?.body['to'], 'user-buyer');
    assert.equal(calls[0]?.body['addressId'], undefined);
  });

  it('lets addressId win when both are set', async () => {
    const calls = mockFetch(
      () =>
        new Response(
          JSON.stringify({ success: true, message: 'ok', addressId: 'c-1' }),
          { status: 200 },
        ),
    );

    await sendChatMessage(
      { addressId: 'c-1', to: 'user-buyer', text: 'hi', messageId: 'm1' },
      CREDS,
    );

    assert.match(calls[0]?.url ?? '', /\/messaging\/addresses\/c-1\/messages$/);
    assert.equal(calls[0]?.body['addressId'], 'c-1');
    assert.equal(calls[0]?.body['to'], undefined);
  });

  it('refuses when neither addressId nor to is set', async () => {
    await assert.rejects(
      () => sendChatMessage({ text: 'hi', messageId: 'm1' }, CREDS),
      /addressId or to is required/,
    );
  });
});
