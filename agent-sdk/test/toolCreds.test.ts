import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credsFromToolContext, laneFromToolContext } from '../src/tools/toolCreds.js';

test('the lane rides along when the wake context carries a chat', () => {
  const creds = credsFromToolContext({
    operatorKey: 'op_k',
    agentId: 'agent-a',
    chatId: 'chat_1',
  });
  assert.deepEqual(creds, { operatorKey: 'op_k', agentId: 'agent-a', laneId: 'chat_1' });
});

test('an agreement lane arrives as sessionId and is claimed the same way', () => {
  assert.equal(
    laneFromToolContext({ sessionId: 'agrn-agr_1' }),
    'agrn-agr_1',
  );
});

test('chatId wins over sessionId when both are present', () => {
  assert.equal(laneFromToolContext({ chatId: 'chat_1', sessionId: 'agrn-agr_1' }), 'chat_1');
});

test('no lane is omitted rather than sent empty — the backend reads absent as own-org', () => {
  const creds = credsFromToolContext({ operatorKey: 'op_k', agentId: 'agent-a' });
  assert.equal('laneId' in creds, false);
});

test('a blank lane is treated as no lane, not as a lane called ""', () => {
  assert.equal(laneFromToolContext({ chatId: '   ' }), undefined);
});

test('a missing operator key or agent id fails here, not at the wire', () => {
  assert.throws(() => credsFromToolContext({ agentId: 'agent-a' }, 'my_tool'), /my_tool: operatorKey missing/);
  assert.throws(() => credsFromToolContext({ operatorKey: 'op_k' }, 'my_tool'), /my_tool: agentId missing/);
});
