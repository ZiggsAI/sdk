import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagesListUrl } from '../src/http/MessagesClient.js';

test('the newest message page does not ask for a forward delta', () => {
  const latest = new URL(messagesListUrl('https://api.example', 'chat 1', { limit: 20 }));
  assert.equal(latest.searchParams.get('direction'), null);
  assert.equal(latest.searchParams.get('after'), null);
  assert.equal(latest.searchParams.get('limit'), '20');
  assert.equal(latest.pathname, '/chats/chat%201/messages');

  const forward = new URL(
    messagesListUrl('https://api.example', 'chat-1', { after: '2026-01-01T00:00:00.000Z' }),
  );
  assert.equal(forward.searchParams.get('direction'), 'forward');
  assert.equal(forward.searchParams.get('after'), '2026-01-01T00:00:00.000Z');
});
