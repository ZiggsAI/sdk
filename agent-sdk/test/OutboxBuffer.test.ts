import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OutboxBuffer } from '../src/platform/OutboxBuffer.js';

describe('OutboxBuffer', () => {
  it('drops pending entries that already exist in server history', () => {
    const buf = new OutboxBuffer();
    buf.track('chat-1', { text: 'hello', receiverId: 'u1' });

    const history = [
      {
        text: 'hello',
        sender: { id: 'agent-1' },
      },
    ];

    buf.merge('chat-1', history, 'agent-1');
    assert.equal(history.length, 1);
    assert.equal((buf as any)._pending.has('chat-1'), false);
  });

  it('appends unmatched pending messages and keeps them pending', () => {
    const buf = new OutboxBuffer();
    buf.track('chat-2', { text: 'not in history', receiverId: 'u2' });

    const history: Array<Record<string, unknown>> = [
      {
        text: 'other',
        sender: { id: 'agent-1' },
      },
    ];

    buf.merge('chat-2', history, 'agent-1');
    assert.equal(history.length, 2);
    assert.equal(history[1].text, 'not in history');
    assert.equal(history[1].entryType, 'message');
    assert.equal((buf as any)._pending.get('chat-2').length, 1);
  });

  it('does not match history rows from a different sender', () => {
    const buf = new OutboxBuffer();
    buf.track('chat-3', { text: 'same text', receiverId: 'u3' });

    const history = [
      {
        text: 'same text',
        sender: { id: 'another-agent' },
      },
    ];

    buf.merge('chat-3', history, 'agent-1');
    assert.equal(history.length, 2);
    assert.equal((buf as any)._pending.get('chat-3').length, 1);
  });

  it('expires stale pending messages by ttl before merge', () => {
    const realNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const buf = new OutboxBuffer({ ttlMs: 1_000 });
      buf.track('chat-ttl', { text: 'old', receiverId: 'u1' });
      now = 2_200;
      buf.track('chat-ttl', { text: 'fresh', receiverId: 'u1' });

      const history: Array<Record<string, unknown>> = [];
      buf.merge('chat-ttl', history, 'agent-1');

      assert.equal(history.length, 1);
      assert.equal(history[0].text, 'fresh');
      assert.equal((buf as any)._pending.get('chat-ttl').length, 1);
    } finally {
      Date.now = realNow;
    }
  });
});

