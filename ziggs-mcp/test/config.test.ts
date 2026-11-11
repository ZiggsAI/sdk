import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('loadConfig', () => {
  it('requires operator key', async () => {
    const prevKey = process.env.ZIGGS_OPERATOR_KEY;
    const prevAgent = process.env.ZIGGS_AGENT_ID;
    delete process.env.ZIGGS_OPERATOR_KEY;
    delete process.env.ZIGGS_AGENT_ID;
    try {
      const { loadConfig } = await import('../src/config.js');
      assert.throws(() => loadConfig(), /ZIGGS_OPERATOR_KEY/);
    } finally {
      if (prevKey) process.env.ZIGGS_OPERATOR_KEY = prevKey;
      else delete process.env.ZIGGS_OPERATOR_KEY;
      if (prevAgent) process.env.ZIGGS_AGENT_ID = prevAgent;
      else delete process.env.ZIGGS_AGENT_ID;
    }
  });

  it('accepts fleet key with ZIGGS_AGENT_ID', async () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'operator', keyId: 'op_fleet' }),
    ).toString('base64url');
    process.env.ZIGGS_OPERATOR_KEY = `hdr.${payload}.sig`;
    process.env.ZIGGS_AGENT_ID = 'cursor-delegate';
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    assert.equal(cfg.resolvedAgentId, 'cursor-delegate');
  });

  it('resolves agent id from agent-scoped key without ZIGGS_AGENT_ID', async () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'operator', boundAgentId: 'delegate-agent' }),
    ).toString('base64url');
    process.env.ZIGGS_OPERATOR_KEY = `hdr.${payload}.sig`;
    delete process.env.ZIGGS_AGENT_ID;
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    assert.equal(cfg.resolvedAgentId, 'delegate-agent');
  });

  it('ZIGGS_MCP_DEBUG registers debug-only tools when set (ZIG-672)', async () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'operator', boundAgentId: 'delegate-agent' }),
    ).toString('base64url');
    process.env.ZIGGS_OPERATOR_KEY = `hdr.${payload}.sig`;
    delete process.env.ZIGGS_AGENT_ID;
    const prevDebug = process.env.ZIGGS_MCP_DEBUG;
    process.env.ZIGGS_MCP_DEBUG = 'true';
    try {
      const { loadConfig } = await import('../src/config.js');
      assert.equal(loadConfig().debugTools, true);
    } finally {
      if (prevDebug === undefined) delete process.env.ZIGGS_MCP_DEBUG;
      else process.env.ZIGGS_MCP_DEBUG = prevDebug;
    }
  });

  it('the listed surface follows the credential, on stdio too', async () => {
    const own = Buffer.from(
      JSON.stringify({ type: 'operator', boundAgentId: 'delegate-agent' }),
    ).toString('base64url');
    process.env.ZIGGS_OPERATOR_KEY = `hdr.${own}.sig`;
    delete process.env.ZIGGS_AGENT_ID;
    const { loadConfig } = await import('../src/config.js');
    assert.equal(loadConfig().directConnection, true);

    const assistant = Buffer.from(
      JSON.stringify({
        type: 'operator',
        boundAgentId: 'delegate-agent',
        issuedVia: 'mcp_oauth',
      }),
    ).toString('base64url');
    process.env.ZIGGS_OPERATOR_KEY = `hdr.${assistant}.sig`;
    assert.equal(loadConfig().directConnection, false);
  });

  // ZIG-1677 — both consent rails board an assistant through the same door and
  // both want the narrowed surface. This used to be `issuedVia === 'mcp_oauth'`,
  // so the moment the backend recorded the device rail honestly, every
  // device-code key would have been served the whole catalogue.
  it('narrows the surface for a device-code credential too', async () => {
    const deviceBoarded = Buffer.from(
      JSON.stringify({
        type: 'operator',
        boundAgentId: 'delegate-agent',
        issuedVia: 'device_code',
      }),
    ).toString('base64url');
    process.env.ZIGGS_OPERATOR_KEY = `hdr.${deviceBoarded}.sig`;
    delete process.env.ZIGGS_AGENT_ID;
    const { loadConfig } = await import('../src/config.js');
    assert.equal(loadConfig().directConnection, false);
  });

  // The other values a key can now carry all mean "configured this themselves".
  it('leaves the whole surface to keys a person minted for their own use', async () => {
    const { loadConfig } = await import('../src/config.js');
    for (const issuedVia of ['signup', 'session', 'derived', 'agent_provisioning']) {
      const own = Buffer.from(
        JSON.stringify({ type: 'operator', boundAgentId: 'a', issuedVia }),
      ).toString('base64url');
      process.env.ZIGGS_OPERATOR_KEY = `hdr.${own}.sig`;
      delete process.env.ZIGGS_AGENT_ID;
      assert.equal(loadConfig().directConnection, true, issuedVia);
    }
  });
});
