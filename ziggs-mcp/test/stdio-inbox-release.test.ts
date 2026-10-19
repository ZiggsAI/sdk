import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installStdioInboxHostRelease,
  releaseStdioInboxHost,
} from '../src/server.js';

describe('stdio inbox host release', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('releaseStdioInboxHost DELETEs /inbox/host', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(JSON.stringify({ released: true }), { status: 200 });
    });
    await releaseStdioInboxHost({
      operatorKey: 'op',
      agentId: 'agt_1',
      instanceId: 'local:test:stdio',
    });
    assert.ok(calls.some((c) => c.startsWith('DELETE ') && c.endsWith('/inbox/host')));
  });

  it('releaseStdioInboxHost swallows a failed DELETE', async () => {
    mock.method(globalThis, 'fetch', async () => {
      return new Response('nope', { status: 500 });
    });
    await releaseStdioInboxHost({ operatorKey: 'op', agentId: 'agt_1' });
  });

  it('installStdioInboxHostRelease adds and removes the signal handlers', () => {
    const beforeTerm = process.listenerCount('SIGTERM');
    const beforeInt = process.listenerCount('SIGINT');
    const uninstall = installStdioInboxHostRelease(
      { operatorKey: 'op', agentId: 'agt_1' },
      () => {},
    );
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm + 1);
    assert.equal(process.listenerCount('SIGINT'), beforeInt + 1);
    uninstall();
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
    assert.equal(process.listenerCount('SIGINT'), beforeInt);
  });
});
