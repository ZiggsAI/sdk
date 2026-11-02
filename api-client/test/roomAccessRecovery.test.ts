import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { openCapability, accessExplainCapability, ContextOpenClient, describeOperationError } from '../src/index.js';
import type { CapabilityEnv } from '../src/capabilities/types.js';

const env = (surface: 'sdk' | 'mcp'): CapabilityEnv => ({ creds: { operatorKey: 'op', agentId: 'assistant' }, surface });
const response = { outcome: 'hidden', ref: { kind: 'agreement', id: 'room' }, access: { summary: 'Unavailable' }, workContext: { laneId: null } };

describe('resource access recovery across tool surfaces', () => {
  afterEach(() => mock.restoreAll());
  for (const surface of ['sdk', 'mcp'] as const) {
    it(`${surface} keeps domain codes instead of inferring authority from prose`, () => {
      for (const code of ['ACCESS_APPROVER_UNAVAILABLE', 'GRANT_EXPIRED', 'CUSTOM_POLICY_DENIED']) {
        const error = Object.assign(new Error('Access to this scope is refused'), { status: 403, code });
        assert.deepEqual(describeOperationError(error, surface), { code, message: error.message });
      }
      const withoutStatus = Object.assign(new Error('Choose another operation'), { code: 'CUSTOM_POLICY_DENIED' });
      assert.equal(describeOperationError(withoutStatus, surface).code, 'CUSTOM_POLICY_DENIED');
    });
    it(`${surface} does not turn token restrictions or ordinary errors into access requests`, () => {
      const error = Object.assign(new Error('missing scope: payments:admin; the owner must act'), { status: 403 });
      assert.deepEqual(describeOperationError(error, surface), { code: 'NOT_AUTHORIZED', message: error.message });
    });
    it(`${surface} preserves an explicitly empty approver choice list`, () => {
      const error = Object.assign(new Error('Nobody in this context can approve'), { status: 403, code: 'ACCESS_APPROVER_UNAVAILABLE', body: JSON.stringify({ choices: [] }) });
      assert.deepEqual(describeOperationError(error, surface).choices, []);
    });
    for (const capability of [openCapability, accessExplainCapability]) {
      it(`${surface} ${capability.key} accepts typed resource ids and the current ref through the same client`, async () => {
        const bodies: unknown[] = [];
        mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify(response));
        });
        for (const key of ['ref', 'artifactId', 'taskId', 'agreementId']) {
          assert.ok(capability.params?.[key]);
          await capability.handler({ [key]: 'older-id', limit: 5 }, env(surface));
          assert.deepEqual(bodies.at(-1), { [key]: 'older-id', limit: 5 });
        }
        const count = bodies.length;
        for (const args of [{}, { ref: '' }, { ref: 'room', addressId: 'other' }, { addressId: 'room', ref: '' }, { ref: 42 }]) {
          await assert.rejects(capability.handler(args, env(surface)), { code: 'INVALID_INPUT' });
        }
        assert.equal(bodies.length, count);
      });
    }
    it(`${surface} preserves the actual denial, request, approvers and wrapped causes`, () => {
      const recovery = { tool: 'access_request', args: { scopeKind: 'agreement', scopeId: 'room', permission: 'work' }, required: ['reason', 'recipientId'], approvers: [{ id: 'person', name: 'Itay', role: 'operator' }] };
      const api = Object.assign(new Error('Room access required'), { status: 403, code: 'CHAT_UNAVAILABLE', body: JSON.stringify({ recovery }) });
      const error = new Error('Tool execution failed', { cause: api });
      const shaped = describeOperationError(error, surface);
      assert.equal(shaped.code, 'CHAT_UNAVAILABLE');
      assert.equal(shaped.message, 'Room access required');
      assert.equal(shaped.hint, undefined);
      assert.deepEqual(shaped.recovery, { ...recovery, tool: surface === 'mcp' ? 'ziggs_access_request' : 'access_request' });
    });
  }
  it('direct client calls use the same strict reference validation', async () => {
    const fetch = mock.method(globalThis, 'fetch');
    await assert.rejects(new ContextOpenClient('op', 'assistant').open({ ref: 'work', artifactId: '' }), { code: 'INVALID_INPUT' });
    assert.equal(fetch.mock.callCount(), 0);
  });
});
