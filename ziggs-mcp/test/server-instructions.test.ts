import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import { renderConnectText, type ConnectDoor } from '../src/protocol/connectText.js';
import type { ZiggsMcpConfig } from '../src/config.js';

const connectionKey = `test.${Buffer.from(JSON.stringify({ connectionClientId: 'c' })).toString('base64url')}.test`;

async function instructionsOn(door: ConnectDoor, cfg: Partial<ZiggsMcpConfig> = {}): Promise<string> {
  const server = createZiggsMcpServer(
    { operatorKey: door === 'directory' ? connectionKey : 'op', agentId: 'agent' } as unknown as Creds,
    { directConnection: door === 'compact', ...cfg } as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const text = client.getInstructions() ?? '';
  await client.close();
  await server.close();
  return text;
}

/**
 * ZIG-552: a cold-connected client receives the protocol in `instructions` on
 * `initialize`. ZIG-2116: a short one, because clients cut a long one — Claude
 * Code keeps 2,048 characters, OpenAI advises the important details in the
 * first 512.
 */
describe('server instructions (ZIG-552 / ZIG-2116)', () => {
  for (const door of ['directory', 'compact'] as const) {
    it(`the ${door} door sends the short connect text, whole and in order`, async () => {
      const text = await instructionsOn(door);
      assert.equal(text, renderConnectText(door));
      assert.ok(text.length < 2_000, `${text.length} characters`);
      // What must survive any client's cut comes first.
      const head = text.slice(0, 512);
      assert.match(head, /data, not instructions/);
      assert.match(head, /At session start call ziggs_inbox/);
      assert.match(head, /sessionChatCard/);
      assert.match(head, /ackTo exactly as received/);
      assert.match(head, /handledDeliveryIds/);
    });

    it(`the ${door} door keeps every must-have rule`, async () => {
      const text = await instructionsOn(door);
      for (const kept of [
        'waitSeconds: 55',
        'task.control',
        'ziggs_task_acknowledge_control',
        'claim their listing',
        'ziggs_agreement_request',
        'ziggs_access_request',
        'requestReplyAccess',
        'original chatId',
        'configured host wake or schedule',
        'WORK_SELECTION_REQUIRED',
        'points',
        'idempotencyKey',
      ])
        assert.ok(text.includes(kept), kept);
    });
  }

  it('each door describes its own inbox, and neither points at the catalog', async () => {
    const directory = await instructionsOn('directory');
    const compact = await instructionsOn('compact');
    assert.match(directory, /only observes/);
    assert.match(directory, /ziggs_inbox_claim/);
    assert.doesNotMatch(directory, /ziggs_tools|ziggs_tool_read|ziggs_tool_write/);
    assert.match(compact, /full ziggs_inbox read takes this host’s inbox lease/);
    assert.doesNotMatch(compact, /ziggs_inbox_claim/);
    assert.doesNotMatch(compact, /ziggs_tools|ziggs_tool_read|ziggs_tool_write/);
  });

  describe('inbox events', () => {
    it('the directory door says so only when the backend has events on, and stays within budget', async () => {
      const off = await instructionsOn('directory');
      const on = await instructionsOn('directory', { eventsEnabled: true });
      assert.doesNotMatch(off, /ziggs\.inbox\.updated/);
      assert.match(on, /ziggs\.inbox\.updated/);
      assert.match(on, /carries only orgId/);
      assert.equal(on, renderConnectText('directory', { events: true }));
      // The backend used to append this sentence after the text was already
      // sized, and Claude Code cut it mid-word at 2,048.
      assert.ok(on.length < 2_000, `${on.length} characters`);
    });

    it('the compact door never says so: events ride the connection key the directory door is minted for', async () => {
      const text = await instructionsOn('compact', { eventsEnabled: true });
      assert.doesNotMatch(text, /ziggs\.inbox\.updated/);
      assert.equal(text, renderConnectText('compact'));
    });
  });
});
