import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../src/Agent.js';
import { handlerBrain } from '../src/brain/index.js';
import { contextScopesFromWake } from '../src/runtime/wakeEffects.js';
import { withDeclaredMandate } from '../src/runtime/mandateDeclaration.js';

test('a deterministic task handler needs no model key or chat and receives task-first context', async t => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify(String(url).includes('/context/snapshot')
      ? { history: [], agreements: [], users: [], agents: [], work: { agreementId: 'work', task: { taskId: 'task-one' }, minimumComplete: true, authorization: { active: true } } }
      : String(url).includes('/tasks/task-one')
        ? { taskId: 'task-one', agreementId: 'work', state: 'active', assigneeId: 'worker', control: null }
        : { agreementId: 'work', status: 'active', terms: { interactionMode: 'tasks' } }));
  });
  let received: unknown;
  const host = new Agent({ agentId: 'worker', operatorKey: 'test-key', taskTools: 'none', inboxCatchUp: false, telemetryIngest: false,
    brain: handlerBrain(async ({ eff, identity }) => {
      received = await eff({ kind: 'read-context', sessionId: identity.sessionId });
      return { ctx: {}, state: 'ready', parked: true, stateTimeoutUnhandled: false, metrics: { llmCalls: 0, tokens: { input: 0, output: 0, total: 0 } } };
    }) });
  t.after(() => host.disconnect());
  assert.equal(host.llm, undefined);
  const internal = host as any;
  internal.recordWakeOutcome = () => {};
  internal.sessions.set('worker:agrn-work', { sessionId: 'agrn-work', ownAgentId: 'worker', state: 'ready' });
  await internal._processEvent({ type: 'task_result', result: { taskId: 'task-one', agreementId: 'work', state: 'active', assigneeId: 'worker' } }, 'worker:agrn-work');
  assert.equal((received as any)?.work?.task?.taskId, 'task-one');
  const url = new URL(urls.find(u => u.includes('/context/snapshot'))!);
  assert.equal(url.searchParams.get('via'), 'task:task-one');
  assert.equal(url.searchParams.get('agreementId'), 'work');
  assert.equal(urls.some(u => u.includes('/chats/')), false);
});

test('a batch keeps independent task contexts rather than widening one authority', () => {
  assert.deepEqual(contextScopesFromWake({ type: 'batch', events: [
    { type: 'task_result', result: { taskId: 'one', agreementId: 'a' } },
    { type: 'task_result', result: { taskId: 'two', agreementId: 'b' } },
  ] }, 'room'), [{ taskId: 'one', agreementId: 'a' }, { taskId: 'two', agreementId: 'b' }]);
});

test('a relationship supplies parent placement without declaring spending authority', () => {
  const manager = { getTool: () => ({ schema: { function: { parameters: { properties: { mandateAgreementId: {}, parentAgreementId: {} } } } } }) };
  assert.deepEqual(withDeclaredMandate({}, 'agreement_buy', manager as never, 'negotiation', false), { parentAgreementId: 'negotiation' });
  assert.deepEqual(withDeclaredMandate({ parentAgreementId: 'explicit' }, 'agreement_buy', manager as never, 'negotiation', false), { parentAgreementId: 'explicit' });
});

test('artifact wakes preserve the exact trigger alongside their work agreement', () => {
  assert.deepEqual(contextScopesFromWake({ type: 'resource_changed', resource: {
    kind: 'artifact', resourceId: 'input-file', agreementId: 'work', taskId: 'current',
  } }, 'room'), [{ taskId: 'current', agreementId: 'work', artifactId: 'input-file' }]);
});
