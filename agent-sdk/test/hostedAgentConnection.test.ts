import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertHostedAgentZiggsTools,
  looksLikeInboundZiggsMcp,
} from '../src/brain/hostedAgentConnection.js';

describe('hostedAgentConnection (ZIG-781)', () => {
  it('detects ziggs-mcp stdio paths', () => {
    assert.equal(
      looksLikeInboundZiggsMcp(process.execPath, ['/app/ziggs-mcp/dist/index.js']),
      true,
    );
    assert.equal(
      looksLikeInboundZiggsMcp('npx', ['-y', '@ziggs-ai/ziggs-mcp']),
      true,
    );
    assert.equal(looksLikeInboundZiggsMcp('/usr/bin/node', ['/app/in-process.js']), false);
  });

  it('rejects stdio MCP servers for hosted agents', () => {
    assert.throws(
      () =>
        assertHostedAgentZiggsTools({
          ziggs: { type: 'stdio', command: 'node', args: ['ziggs-mcp/dist/index.js'] },
        }),
      /must not use stdio MCP/,
    );
  });

  it('allows in-process createSdkMcpServer specs (no type: stdio)', () => {
    assert.doesNotThrow(() =>
      assertHostedAgentZiggsTools({
        ziggs: { name: 'ziggs', version: '1.0.0', tools: [] },
      }),
    );
  });
});
