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
      'GET /artifacts',
      'POST /artifacts',
      'PATCH /tasks/child/state',
      'POST /tasks/child/return',
    ]);
  });

  for (const stale of [
    'Execution context is no longer current',
    'The work audience or authority changed. Prepare the exact action for a fresh authorized execution context.',
  ])
  it(`returns once more outside the run when the run ended before the return landed (${stale.slice(0, 30)})`, async () => {
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
        if (execution) return Response.json({ message: stale }, { status: 409 });
        return Response.json({ taskId: 'child', parentTaskId: 'parent', artifactId: 'output-1', outcome: 'created' }, { status: 201 });
      }
      return Response.json({});
    });
    const service = new TaskService('key', 'worker');
    (service as unknown as { creds: { executionContextId?: string } }).creds.executionContextId = 'xec_done';
    await service.updateState('child', 'completed', { summary: 'done' }, 'complete-child');
    assert.deepEqual(returns, ['xec_done', null]);
  });

  it('carries the bodies of the other outputs it made in the one result it returns', async () => {
    let written = '';
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      if (method === 'GET' && u.pathname === '/tasks/child') return Response.json({ taskId: 'child', state: 'active', delegation: { instructionArtifactId: 'brief' } });
      if (method === 'GET' && u.pathname === '/artifacts' && u.searchParams.get('taskId') === 'child')
        return Response.json({ artifacts: [
          { artifactId: 'p1', name: 'Page W1', text: 'Opening checklist page body', linkRole: 'output', sender: { id: 'worker' } },
          { artifactId: 'in', name: 'Brief', text: 'the brief', linkRole: 'input', sender: { id: 'lead' } },
          { artifactId: 'x', name: 'Someone else', text: 'not mine', linkRole: 'output', sender: { id: 'other' } },
        ], latestSequence: null, truncated: [] });
      if (method === 'POST' && u.pathname === '/artifacts') {
        written = JSON.parse(String(init?.body)).text;
        return Response.json({ status: 'stored', artifactId: 'output-1' }, { status: 201 });
      }
      if (method === 'PATCH' && u.pathname === '/tasks/child/state') return Response.json({ success: true, taskId: 'child', state: 'completed' });
      if (method === 'POST' && u.pathname === '/tasks/child/return') return Response.json({ taskId: 'child', parentTaskId: 'parent', artifactId: 'output-1', outcome: 'created' }, { status: 201 });
      return Response.json({});
    });
    await new TaskService('key', 'worker').updateState('child', 'completed', { summary: '3 pages drafted' }, 'complete-child');
    assert.match(written, /^3 pages drafted/);
    assert.match(written, /## Page W1\n\nOpening checklist page body/);
    assert.doesNotMatch(written, /the brief|not mine/);
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
