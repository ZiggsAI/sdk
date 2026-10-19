import http from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { configureApiClient } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREDS = { operatorKey: 'test-operator-key', agentId: 'test-agent' };

let _loadSeq = 0;

/**
 * TaskClient captures `baseUrl` at module load; load a fresh module after the
 * base URL is configured.
 */
async function loadTaskClient(baseUrl: string) {
  configureApiClient({ httpUrl: baseUrl });
  const href = pathToFileURL(path.join(__dirname, '../src/http/TaskClient.js')).href;
  return import(`${href}?t=${_loadSeq++}`) as Promise<Record<string, (...args: unknown[]) => unknown>>;
}

type ServerHandler = (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void>;

function startServer(handler: ServerHandler): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          await handler(req, res, body);
        } catch (e) {
          res.statusCode = 500;
          res.end(String((e as Error)?.message || e));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('invalid listen address'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r(undefined))),
      });
    });
    server.on('error', reject);
  });
}

describe('TaskClient (integration, local HTTP)', () => {
  it('createTask posts JSON and maps response', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/tasks');
      assert.ok(String(req.headers.authorization || '').startsWith('Bearer '));
      assert.equal(req.headers['x-agent-id'], CREDS.agentId);
      const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal(parsed['title'], 'hello');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ task: { taskId: 'tid-1', id: 'tid-1', state: 'active', createdAt: 't0' } }));
    });
    try {
      const { createTask } = await loadTaskClient(baseUrl);
      const out = await createTask({ title: 'hello' }, CREDS) as Record<string, unknown>;
      assert.equal(out['taskId'], 'tid-1');
      assert.equal(out['state'], 'active');
    } finally {
      await close();
    }
  });

  it('createTask forwards assigneeId and maps assigneeId back from response (ZIG-586)', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal(parsed['assigneeId'], 'agent-2');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        task: { taskId: 'tid-2', state: 'active', assigneeId: 'agent-2' },
      }));
    });
    try {
      const { createTask } = await loadTaskClient(baseUrl);
      const out = await createTask({ description: 'd', agreementId: 'agr-1', assigneeId: 'agent-2' }, CREDS) as Record<string, unknown>;
      assert.equal(out['assigneeId'], 'agent-2');
    } finally {
      await close();
    }
  });

  it('createTask lifts idempotencyKey into the Idempotency-Key header, out of the body', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.headers['idempotency-key'], 'wk_wake_s_1234');
      const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal('idempotencyKey' in parsed, false);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ task: { taskId: 'tid-idem', state: 'active' } }));
    });
    try {
      const { createTask } = await loadTaskClient(baseUrl);
      const out = await createTask(
        { description: 'd', agreementId: 'agr-1', idempotencyKey: 'wk_wake_s_1234' },
        CREDS,
      ) as Record<string, unknown>;
      assert.equal(out['taskId'], 'tid-idem');
    } finally {
      await close();
    }
  });

  it('createTask sends no Idempotency-Key header when no key is given', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      assert.equal('idempotency-key' in req.headers, false);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ task: { taskId: 'tid-nokey', state: 'active' } }));
    });
    try {
      const { createTask } = await loadTaskClient(baseUrl);
      await createTask({ description: 'd', agreementId: 'agr-1' }, CREDS);
    } finally {
      await close();
    }
  });

  it('createTask omits assigneeId when not provided (backward compatible)', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal('assigneeId' in parsed, false);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ task: { taskId: 'tid-3', state: 'active' } }));
    });
    try {
      const { createTask } = await loadTaskClient(baseUrl);
      await createTask({ description: 'd', agreementId: 'agr-1' }, CREDS);
    } finally {
      await close();
    }
  });

  it('createTask throws with API error details', async () => {
    const { baseUrl, close } = await startServer(async (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ details: 'bad payload' }));
    });
    try {
      const { createTask } = await loadTaskClient(baseUrl);
      await assert.rejects(async () => createTask({ x: 1 }, CREDS), (err: unknown) => {
        assert.equal((err as Error).message, 'bad payload');
        assert.equal((err as Record<string, unknown>)['status'], 400);
        return true;
      });
    } finally {
      await close();
    }
  });

  it('getTask returns parsed task', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      assert.equal(req.method, 'GET');
      assert.equal(req.url, '/tasks/abc');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'abc', state: 'active' }));
    });
    try {
      const { getTask } = await loadTaskClient(baseUrl);
      const out = await getTask('abc', CREDS) as Record<string, unknown>;
      assert.equal(out['taskId'], 'abc');
    } finally {
      await close();
    }
  });

  it('getActiveTasksForChat composes links → per-agreement tasks', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      assert.equal(req.method, 'GET');
      const u = new URL(req.url || '', 'http://127.0.0.1');
      if (u.pathname === '/agreements/by-chat/c99') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ links: [{ agreementId: 'agr-1' }] }));
        return;
      }
      if (u.pathname === '/agreements/agr-1/tasks') {
        assert.equal(u.searchParams.get('state'), 'active');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tasks: [{ taskId: '1' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const { getActiveTasksForChat } = await loadTaskClient(baseUrl);
      const list = await getActiveTasksForChat('c99', CREDS) as Array<Record<string, unknown>>;
      assert.equal(list.length, 1);
      assert.equal(list[0]['taskId'], '1');
    } finally {
      await close();
    }
  });

  it('updateTaskState patches state endpoint', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.method, 'PATCH');
      assert.equal(req.url, '/tasks/t1/state');
      assert.deepEqual(JSON.parse(body || '{}'), { state: 'completed', note: 'n' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'updated', ok: true, taskId: 't1', state: 'completed' }));
    });
    try {
      const { updateTaskState } = await loadTaskClient(baseUrl);
      const out = await updateTaskState('t1', 'completed', { note: 'n' }, CREDS) as Record<string, unknown>;
      assert.equal(out['state'], 'completed');
      assert.equal(out['taskId'], 't1');
      assert.equal(out['ok'], true);
    } finally {
      await close();
    }
  });

  it('updateTaskPlanStep patches plan endpoint with stepId/status/result', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.method, 'PATCH');
      assert.equal(req.url, '/tasks/t7/plan');
      assert.deepEqual(JSON.parse(body || '{}'), { stepId: 's1', status: 'completed', result: 'shipped' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'updated', taskId: 't7', state: 'active', stepId: 's1', stepStatus: 'completed' }));
    });
    try {
      const { updateTaskPlanStep } = await loadTaskClient(baseUrl);
      const out = await updateTaskPlanStep('t7', 's1', 'completed', 'shipped', CREDS) as Record<string, unknown>;
      assert.equal(out['taskId'], 't7');
      assert.equal(out['ok'], true);
    } finally {
      await close();
    }
  });

  it('updateTaskPlanStep omits result when undefined', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.method, 'PATCH');
      assert.equal(req.url, '/tasks/t8/plan');
      assert.deepEqual(JSON.parse(body || '{}'), { stepId: 's2', status: 'in_progress' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, taskId: 't8', state: 'active', stepId: 's2', stepStatus: 'in_progress' }));
    });
    try {
      const { updateTaskPlanStep } = await loadTaskClient(baseUrl);
      await updateTaskPlanStep('t8', 's2', 'in_progress', undefined, CREDS);
    } finally {
      await close();
    }
  });

  it('updateTaskPlanSteps patches plan endpoint with patches array only', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.method, 'PATCH');
      assert.equal(req.url, '/tasks/t9/plan');
      assert.deepEqual(JSON.parse(body || '{}'), {
        patches: [{ stepId: 's3', status: 'completed', result: 'done' }],
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'updated', taskId: 't9', state: 'active', patchedCount: 1 }));
    });
    try {
      const { updateTaskPlanSteps } = await loadTaskClient(baseUrl);
      const out = await updateTaskPlanSteps('t9', [{ stepId: 's3', status: 'completed', result: 'done' }], CREDS) as Record<string, unknown>;
      assert.equal(out['taskId'], 't9');
      assert.equal(out['ok'], true);
    } finally {
      await close();
    }
  });

  it('getActiveTasksForAgent hits /agents/:id/tasks?state=active', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      const u = new URL(req.url || '', 'http://127.0.0.1');
      if (u.pathname === '/agreements') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ agreements: [] }));
        return;
      }
      assert.equal(u.pathname, '/agents/ag-9/tasks');
      assert.equal(u.searchParams.get('state'), 'active');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tasks: [] }));
    });
    try {
      const { getActiveTasksForAgent } = await loadTaskClient(baseUrl);
      const list = await getActiveTasksForAgent('ag-9', CREDS);
      assert.deepEqual(list, []);
    } finally {
      await close();
    }
  });


  it('cancelTask patches cancel endpoint', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      assert.equal(req.method, 'PATCH');
      assert.equal(req.url, '/tasks/t3/cancel');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ task: { taskId: 't3', state: 'cancelled' } }));
    });
    try {
      const { cancelTask } = await loadTaskClient(baseUrl);
      const out = await cancelTask('t3', CREDS) as Record<string, unknown>;
      assert.equal(out['state'], 'cancelled');
    } finally {
      await close();
    }
  });

  it('getSubtasks hits /tasks/:id/subtasks', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      const u = new URL(req.url || '', 'http://127.0.0.1');
      assert.equal(u.pathname, '/tasks/par-1/subtasks');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tasks: [{ taskId: 's1' }] }));
    });
    try {
      const { getSubtasks } = await loadTaskClient(baseUrl);
      const list = await getSubtasks('par-1', CREDS) as Array<Record<string, unknown>>;
      assert.equal(list[0]['taskId'], 's1');
    } finally {
      await close();
    }
  });


  it('reportTask posts report and returns task', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/tasks/t5/report');
      assert.deepEqual(JSON.parse(body || '{}'), { message: 'stuck' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'reported', task: { taskId: 't5', state: 'active' } }));
    });
    try {
      const { reportTask } = await loadTaskClient(baseUrl);
      const out = await reportTask('t5', 'stuck', CREDS) as Record<string, unknown>;
      assert.equal(out['taskId'], 't5');
    } finally {
      await close();
    }
  });

  it('setTaskSatisfaction patches satisfaction', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.method, 'PATCH');
      assert.equal(req.url, '/tasks/t6/satisfaction');
      assert.deepEqual(JSON.parse(body || '{}'), { satisfaction: 'positive' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'updated', task: { taskId: 't6', state: 'completed' } }));
    });
    try {
      const { setTaskSatisfaction } = await loadTaskClient(baseUrl);
      const out = await setTaskSatisfaction('t6', 'positive', CREDS) as Record<string, unknown>;
      assert.equal(out['taskId'], 't6');
    } finally {
      await close();
    }
  });

  it('countTasks GETs canonical /tasks/count with filters in query', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      assert.equal(req.method, 'GET');
      const u = new URL(req.url || '', 'http://127.0.0.1');
      assert.equal(u.pathname, '/tasks/count');
      assert.equal(u.searchParams.get('state'), 'active');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: 7 }));
    });
    try {
      const { countTasks } = await loadTaskClient(baseUrl);
      const out = await countTasks({ state: 'active' }, CREDS);
      assert.equal(out, 7);
    } finally {
      await close();
    }
  });

  it('listTasks GETs /tasks with state and limit query params', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      assert.equal(req.method, 'GET');
      const u = new URL(req.url || '', 'http://127.0.0.1');
      assert.equal(u.pathname, '/tasks');
      assert.equal(u.searchParams.get('state'), 'active');
      assert.equal(u.searchParams.get('limit'), '5');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tasks: [{ taskId: 't10' }], hasMore: false, nextCursor: null }));
    });
    try {
      const { listTasks } = await loadTaskClient(baseUrl);
      const out = await listTasks({ state: 'active', limit: 5 }, CREDS) as Record<string, unknown>;
      const tasks = out['tasks'] as Array<Record<string, unknown>>;
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]['taskId'], 't10');
      assert.equal(out['hasMore'], false);
    } finally {
      await close();
    }
  });

  it('listTasks forwards assignedTo query param (ZIG-586)', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      const u = new URL(req.url || '', 'http://127.0.0.1');
      assert.equal(u.pathname, '/tasks');
      assert.equal(u.searchParams.get('assignedTo'), 'agent-9');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tasks: [{ taskId: 't11', assigneeId: 'agent-9' }], hasMore: false, nextCursor: null }));
    });
    try {
      const { listTasks } = await loadTaskClient(baseUrl);
      const out = await listTasks({ assignedTo: 'agent-9' }, CREDS) as Record<string, unknown>;
      const tasks = out['tasks'] as Array<Record<string, unknown>>;
      assert.equal(tasks[0]['assigneeId'], 'agent-9');
    } finally {
      await close();
    }
  });

  it('listTasks omits assignedTo when not provided', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      const u = new URL(req.url || '', 'http://127.0.0.1');
      assert.equal(u.searchParams.has('assignedTo'), false);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tasks: [], hasMore: false, nextCursor: null }));
    });
    try {
      const { listTasks } = await loadTaskClient(baseUrl);
      await listTasks({}, CREDS);
    } finally {
      await close();
    }
  });

  it('listTasks supports cursor pagination', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      const u = new URL(req.url || '', 'http://127.0.0.1');
      assert.equal(u.searchParams.get('cursor'), 'cur-abc');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tasks: [], hasMore: false, nextCursor: null }));
    });
    try {
      const { listTasks } = await loadTaskClient(baseUrl);
      const out = await listTasks({ cursor: 'cur-abc' }, CREDS) as Record<string, unknown>;
      assert.deepEqual(out['tasks'], []);
    } finally {
      await close();
    }
  });
});

describe('TaskClient (input guards, no HTTP)', () => {
  it('createTask rejects missing operatorKey', async () => {
    const { createTask } = await loadTaskClient('http://127.0.0.1:9');
    await assert.rejects(async () => createTask({ a: 1 }, {}), /operatorKey is required/);
  });

  it('getTask throws for empty id', async () => {
    const { getTask } = await loadTaskClient('http://127.0.0.1:9');
    await assert.rejects(async () => getTask('', CREDS), /taskId is required/);
  });

  it('updateTaskPlanStep throws for missing stepId', async () => {
    const { updateTaskPlanStep } = await loadTaskClient('http://127.0.0.1:9');
    await assert.rejects(
      async () => updateTaskPlanStep('t1', '', 'completed', undefined, CREDS),
      /stepId is required/,
    );
  });

  it('updateTaskPlanSteps throws for an empty patch list', async () => {
    const { updateTaskPlanSteps } = await loadTaskClient('http://127.0.0.1:9');
    await assert.rejects(
      async () => updateTaskPlanSteps('t1', [], CREDS),
      /at least one step/,
    );
  });
});
