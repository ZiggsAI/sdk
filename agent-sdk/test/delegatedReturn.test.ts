import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskService } from '../src/platform/tasks/TaskService.js';

describe('TaskService completing a delegated task', () => {
  afterEach(() => { mock.restoreAll(); });

  const run = async (delegation: unknown) => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      if (method === 'GET' && path === '/tasks/child') return Response.json({ taskId: 'child', state: 'active', delegation });
      if (method === 'POST' && path === '/artifacts') {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.taskId, 'child');
        assert.equal(body.text, 'Collected: 0 articles in window');
        return Response.json({ status: 'stored', artifactId: 'output-1' }, { status: 201 });
      }
      if (method === 'PATCH' && path === '/tasks/child/state') return Response.json({ success: true, taskId: 'child', state: 'completed' });
      if (method === 'POST' && path === '/tasks/child/return') {
        assert.deepEqual(JSON.parse(String(init?.body)), { artifactId: 'output-1' });
        return Response.json({ taskId: 'child', parentTaskId: 'parent', artifactId: 'output-1', outcome: 'created' }, { status: 201 });
      }
      return Response.json({});
    });
    await new TaskService('key', 'worker').updateState('child', 'completed', { summary: 'Collected: 0 articles in window' }, 'complete-child');
    return calls.filter(c => !c.includes('/agreements') && !c.includes('/presentation'));
  };

  it('records the result as an output before completing, then returns it to the delegator', async () => {
    const calls = await run({ instructionArtifactId: 'brief' });
    assert.deepEqual(calls.filter(c => /tasks\/child|artifacts/.test(c)), [
      'GET /tasks/child',
      'POST /artifacts',
      'PATCH /tasks/child/state',
      'POST /tasks/child/return',
    ]);
  });

  it('returns once more outside the run when the run ended before the return landed', async () => {
    const returns: Array<string | null> = [];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      if (method === 'GET' && path === '/tasks/child') return Response.json({ taskId: 'child', state: 'active', delegation: { instructionArtifactId: 'brief' } });
      if (method === 'POST' && path === '/artifacts') return Response.json({ status: 'stored', artifactId: 'output-1' }, { status: 201 });
      if (method === 'PATCH' && path === '/tasks/child/state') return Response.json({ success: true, taskId: 'child', state: 'completed' });
      if (method === 'POST' && path === '/tasks/child/return') {
        const execution = new Headers(init?.headers).get('X-Ziggs-Execution');
        returns.push(execution);
        if (execution) return Response.json({ message: 'Execution context is no longer current' }, { status: 409 });
        return Response.json({ taskId: 'child', parentTaskId: 'parent', artifactId: 'output-1', outcome: 'created' }, { status: 201 });
      }
      return Response.json({});
    });
    const service = new TaskService('key', 'worker');
    (service as unknown as { creds: { executionContextId?: string } }).creds.executionContextId = 'xec_done';
    await service.updateState('child', 'completed', { summary: 'done' }, 'complete-child');
    assert.deepEqual(returns, ['xec_done', null]);
  });

  it('only completes a task that was not delegated', async () => {
    const calls = await run(null);
    assert.deepEqual(calls.filter(c => /tasks\/child|artifacts/.test(c)), ['GET /tasks/child', 'PATCH /tasks/child/state']);
  });

  it('does not return twice', async () => {
    const calls = await run({ instructionArtifactId: 'brief', returnedArtifactId: 'earlier' });
    assert.ok(!calls.includes('POST /tasks/child/return'));
    assert.ok(!calls.includes('POST /artifacts'));
  });
});
