import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { PROTOCOL, renderInstructions } from '../src/protocol/delegateProtocol.js';
import { surfaceTools } from './support/surface.js';

/**
 * ZIG-1879 / AX-08 — on the delegate surface the connect instructions and the
 * tool descriptions are read together, so they have to say the same thing about
 * what finishing a task does. Four facts ride on one word: the result is
 * stored, a wake is queued, a per-task agreement meters one execution, and the
 * engagement ends only at its own quota.
 */
async function connectedClient(): Promise<Client> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op', agentId: 'agent-1' } as unknown as Creds,
    { debugTools: false } as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe('AX-08: completion says what it did, and what it did not', () => {
  it('the connect instructions carry the completion rule', () => {
    const instructions = renderInstructions();
    assert.ok(instructions.includes(PROTOCOL.completion));
    assert.match(PROTOCOL.completion, /Closing a task closes the TASK/);
    assert.match(PROTOCOL.completion, /does not end the engagement/);
    assert.match(PROTOCOL.completion, /does not prove anyone read you/);
    assert.match(PROTOCOL.completion, /does not prove you were paid/);
    assert.match(PROTOCOL.completion, /ziggs_task_get rather than completing it again/);
  });

  it('the reporting rule allows the human delivery it used to leave out', () => {
    assert.match(PROTOCOL.reporting, /A PERSON reads it in the working conversation/);
    // …and still keeps the deliverable out of every other room.
    assert.match(PROTOCOL.reporting, /and only there/);
  });

  it('ziggs_task_set_result agrees with the protocol it ships beside', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const setResult = tools.find((t) => t.name === 'ziggs_task_set_result');
    assert.ok(setResult, 'ziggs_task_set_result is not registered');
    const description = setResult!.description ?? '';
    // ZIG-2116: the same facts, as facts about this tool in its 250 characters.
    assert.match(description, /Closes a task/);
    assert.match(description, /agreement stays active/);
    assert.match(description, /proving nobody read or paid/);
    assert.match(description, /a person reads it in your conversation/);
    assert.match(description, /same idempotencyKey is a no-op/);
    await client.close();
  });

  it('fulfilling still ends the relationship, and says so', async () => {
    const client = await connectedClient();
    const tools = await surfaceTools(client);
    const fulfill = tools.find((t) => t.name === 'ziggs_agreement_fulfill');
    const revoke = tools.find((t) => t.name === 'ziggs_agreement_revoke');
    assert.match(fulfill?.description ?? '', /for good, once its whole scope is delivered/);
    assert.match(fulfill?.description ?? '', /finished task closes with ziggs_task_set_result instead/);
    assert.match(fulfill?.description ?? '', /cannot be reopened/);
    assert.match(revoke?.description ?? '', /ends it now/);
    await client.close();
  });
});
