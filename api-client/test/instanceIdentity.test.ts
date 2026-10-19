import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTANCE_IDENTITY_MAX_LENGTH,
  cliHostIdentity,
  hostIdentity,
  instanceIdentity,
  mcpConnectionIdentity,
  resetInstanceIdentityForTests,
} from '../src/instanceIdentity.js';

describe('instanceIdentity (ZIG-1199 host claimant)', () => {
  const saved = { ...process.env };

  afterEach(() => {
    resetInstanceIdentityForTests();
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });

  it('names the ECS container on a deployed task', () => {
    resetInstanceIdentityForTests();
    delete process.env.ECS_CONTAINER_METADATA_URI;
    process.env.ECS_CONTAINER_METADATA_URI_V4 =
      'http://169.254.170.2/v4/0e79957e1f584a27b1ee5f3a486c5959-1234567890';
    assert.equal(instanceIdentity(), 'ecs:0e79957e1f58');
  });

  it('names host and pid when there is no ECS metadata', () => {
    resetInstanceIdentityForTests();
    delete process.env.ECS_CONTAINER_METADATA_URI_V4;
    delete process.env.ECS_CONTAINER_METADATA_URI;
    process.env.HOSTNAME = 'mins-macbook';
    assert.equal(instanceIdentity(), `local:mins-macbook:${process.pid}`);
  });
});

describe('rail identities (ZIG-1794)', () => {
  const saved = { ...process.env };

  function clearEnv(): void {
    resetInstanceIdentityForTests();
    delete process.env.ECS_CONTAINER_METADATA_URI;
    delete process.env.ECS_CONTAINER_METADATA_URI_V4;
    delete process.env.ZIGGS_INSTANCE_ID;
  }

  afterEach(() => {
    resetInstanceIdentityForTests();
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });

  it('ZIGGS_INSTANCE_ID pins the process identity over the ECS task', () => {
    clearEnv();
    process.env.ECS_CONTAINER_METADATA_URI_V4 =
      'http://169.254.170.2/v4/0e79957e1f584a27b1ee5f3a486c5959-1234567890';
    process.env.ZIGGS_INSTANCE_ID = 'nanoclaw:gated-inbox';
    assert.equal(instanceIdentity(), 'nanoclaw:gated-inbox');
  });

  it('the CLI identity carries no pid, so two invocations are one host', () => {
    clearEnv();
    process.env.HOSTNAME = 'idos-macbook';
    process.env.USER = 'ido';
    assert.equal(cliHostIdentity(), 'cli:idos-macbook:ido');
    assert.ok(!cliHostIdentity().includes(String(process.pid)));
  });

  it('the CLI honours the same pin', () => {
    clearEnv();
    process.env.HOSTNAME = 'idos-macbook';
    process.env.USER = 'ido';
    process.env.ZIGGS_INSTANCE_ID = 'ci-runner-7';
    assert.equal(cliHostIdentity(), 'ci-runner-7');
  });

  it('the hosted MCP names the key it serves, not the backend task', () => {
    clearEnv();
    process.env.ECS_CONTAINER_METADATA_URI_V4 =
      'http://169.254.170.2/v4/0e79957e1f584a27b1ee5f3a486c5959-1234567890';
    assert.equal(mcpConnectionIdentity(operatorKey('key-abc')), 'mcp:key-abc');
    // A refresh re-signs the same keyId, so the assistant keeps its inbox.
    assert.equal(
      mcpConnectionIdentity(operatorKey('key-abc', 4102444800)),
      'mcp:key-abc',
    );
    // Two assistants holding different keys are two hosts.
    assert.notEqual(
      mcpConnectionIdentity(operatorKey('key-abc')),
      mcpConnectionIdentity(operatorKey('key-def')),
    );
  });

  it('a credential with no keyId names no host, and says so', () => {
    clearEnv();
    assert.equal(mcpConnectionIdentity(operatorKey(undefined)), undefined);
    assert.equal(mcpConnectionIdentity('not-a-jwt'), undefined);
  });

  it('an overlong identity is hashed to fit, never cut to a collision', () => {
    clearEnv();
    const shared = 'x'.repeat(70);
    const a = hostIdentity(`${shared}-one`);
    const b = hostIdentity(`${shared}-two`);
    assert.equal(a.length, INSTANCE_IDENTITY_MAX_LENGTH);
    assert.equal(b.length, INSTANCE_IDENTITY_MAX_LENGTH);
    assert.notEqual(a, b);
  });

  it('hostIdentity falls back to this process when a rail names nothing', () => {
    clearEnv();
    process.env.HOSTNAME = 'laptop';
    assert.equal(hostIdentity(), `local:laptop:${process.pid}`);
    assert.equal(hostIdentity('   '), `local:laptop:${process.pid}`);
  });
});

/** An operator token shaped like the ones the backend signs — payload only. */
function operatorKey(keyId: string | undefined, exp?: number): string {
  const payload: Record<string, unknown> = { type: 'operator', ownerId: 'u1' };
  if (keyId) payload.keyId = keyId;
  if (exp) payload.exp = exp;
  const body = Buffer.from(JSON.stringify(payload))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${body}.signature`;
}
