import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildTransport } from '../src/mcp/createMcpAgent.js';

// The MCP SDK stores the fetch RequestInit under this private field.
const requestInitOf = (t: unknown): RequestInit | undefined =>
  (t as { _requestInit?: RequestInit })._requestInit;

describe('buildTransport (ZIG-689 static headers)', () => {
  it('carries static headers on an http transport', () => {
    const t = buildTransport({ type: 'http', url: 'https://srv.example/mcp', headers: { 'X-Api-Key': 'secret' } });
    assert.ok(t instanceof StreamableHTTPClientTransport);
    assert.deepEqual(requestInitOf(t)?.headers, { 'X-Api-Key': 'secret' });
  });

  it('omits requestInit when no headers are given (keyless)', () => {
    const t = buildTransport({ type: 'http', url: 'https://srv.example/mcp' });
    assert.ok(t instanceof StreamableHTTPClientTransport);
    assert.equal(requestInitOf(t), undefined);
  });

  it('treats an empty headers object as keyless', () => {
    const t = buildTransport({ type: 'http', url: 'https://srv.example/mcp', headers: {} });
    assert.equal(requestInitOf(t), undefined);
  });

  it('still builds a stdio transport', () => {
    const t = buildTransport({ type: 'stdio', command: 'echo', args: ['hi'] });
    assert.ok(t instanceof StdioClientTransport);
  });
});
