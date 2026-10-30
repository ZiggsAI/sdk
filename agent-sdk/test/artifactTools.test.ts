import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARTIFACT_TOOLS,
  recordArtifactTool,
} from '../src/platform/tools/tier2/artifactTools.js';

type FetchCall = {
  url: string;
  opts: { method?: string; headers?: Record<string, string>; body?: string };
};

function stubFetch(
  t: { after: (fn: () => void) => void },
  body: unknown,
  ok = true,
  status = 200,
): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (url: unknown, opts: unknown) => {
    calls.push({ url: String(url), opts: (opts || {}) as FetchCall['opts'] });
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

const CTX = { operatorKey: 'op_test', agentId: 'agent_7' };

test('ARTIFACT_TOOLS exposes the artifact rail', () => {
  const names = ARTIFACT_TOOLS.map((tool) => tool.schema.function['name']);
  // ZIG-1037 added the three surfaces a container-less artifact needs: a listing
  // (the scope reads walk attach tables and cannot see one), a share (authorship
  // is a root authority, so it is not a context_delegate), and an attach (put it
  // in a container after the fact).
  // ZIG-1875 added the search: the listing answers "what did I write", this one
  // answers "where is the thing about X" across everything the agent can reach.
  assert.deepEqual(names, [
    'artifact_record',
    'artifact_list',
    'artifact_find',
    'artifact_share',
    'artifact_attach',
    'artifact_contribution_review',
    'artifact_contribute',
    'artifact_upload_url',
    'artifact_complete_file',
    'artifact_download',
    'artifact_reextract',
  ]);
});

test('artifact_record validates visibility before any request', async () => {
  await assert.rejects(
    () =>
      recordArtifactTool.handler(
        { text: 'x', visibility: 'org-wide', chatId: 'c1' },
        CTX,
      ),
    /visibility must be chat or agent-private/,
  );
});

// ZIG-1037 — this used to reject with "Pass chatId or agreementId", the error
// that cost a live agent a turn while delivering on an agreement lane.
test('artifact_record accepts a write with no scope', async (t) => {
  const calls = stubFetch(t, { artifactId: 'art_free' });

  const out = (await recordArtifactTool.handler(
    { text: 'a spec with no home yet', visibility: 'chat' },
    CTX,
  )) as Record<string, unknown>;

  assert.equal(out['ok'], true);
  assert.equal(out['artifactId'], 'art_free');
  const body = JSON.parse(calls[0]!.opts.body ?? '{}') as Record<string, unknown>;
  assert.equal('chatId' in body, false);
  assert.equal('agreementId' in body, false);
});

test('artifact_record accepts taskId as the only anchor', async (t) => {
  const calls = stubFetch(t, { artifactId: 'art_task' });

  await recordArtifactTool.handler(
    { text: 'x', visibility: 'chat', taskId: 'tsk_1', contentType: 'result' },
    CTX,
  );

  const body = JSON.parse(calls[0]!.opts.body ?? '{}') as Record<string, unknown>;
  assert.equal(body['taskId'], 'tsk_1');
  assert.equal('chatId' in body, false);
  assert.equal('agreementId' in body, false);
});

// ZIG-1075 — both scopes is refused here, with the same verdict the server
// gives. This used to drop chatId and call the agreement the winner, so one call
// had two answers and the client's was the quiet one: the artifact landed
// somewhere the caller had just been told it would also appear. The refusal
// names the recovery, which is what the drop was standing in for (ZIG-924).
test('artifact_record refuses both scopes instead of dropping one (ZIG-1075)', async (t) => {
  const calls = stubFetch(t, { artifactId: 'art_2' });

  await assert.rejects(
    recordArtifactTool.handler(
      { text: 'x', visibility: 'chat', chatId: 'c1', agreementId: 'agr_1', taskId: 't1' },
      CTX,
    ),
    /at most one of chatId or agreementId/,
  );
  assert.equal(calls.length, 0, 'refused before any write');
});

test('artifact_record posts the artifact and returns the artifactId', async (t) => {
  const calls = stubFetch(t, { artifactId: 'art_1' });

  const out = (await recordArtifactTool.handler(
    {
      text: '  the deliverable  ',
      visibility: 'chat',
      agreementId: 'agr_1',
      taskId: 'task_1',
      contentType: 'result',
    },
    CTX,
  )) as Record<string, unknown>;

  assert.equal(out['ok'], true);
  assert.equal(out['artifactId'], 'art_1');
  const call = calls[0]!;
  assert.equal(call.opts.method, 'POST');
  assert.match(call.url, /\/artifacts$/);
  assert.equal(call.opts.headers?.['X-Agent-Id'], 'agent_7');
  assert.deepEqual(JSON.parse(call.opts.body ?? '{}'), {
    text: 'the deliverable',
    contentType: 'result',
    visibility: 'chat',
    agreementId: 'agr_1',
    taskId: 'task_1',
  });
});

test('artifact_record forwards externalRef (ZIG-1232)', async (t) => {
  const calls = stubFetch(t, { artifactId: 'art_ext' });

  await recordArtifactTool.handler(
    {
      text: 'the summary',
      visibility: 'chat',
      externalRef: {
        provider: 'Linear',
        url: 'https://tracker.example.com/issues/1232',
      },
    },
    CTX,
  );

  const body = JSON.parse(calls[0]!.opts.body ?? '{}') as Record<string, unknown>;
  assert.deepEqual(body['externalRef'], {
    provider: 'Linear',
    url: 'https://tracker.example.com/issues/1232',
  });
});

test('artifact_record forwards a writer-set name', async (t) => {
  const calls = stubFetch(t, { artifactId: 'art_named' });

  await recordArtifactTool.handler(
    {
      text: 'the body of a spec',
      name: 'Q3 pricing spec',
      visibility: 'chat',
    },
    CTX,
  );

  const body = JSON.parse(calls[0]!.opts.body ?? '{}') as Record<string, unknown>;
  assert.equal(body['name'], 'Q3 pricing spec');
});

test('artifact_record teaches the result slot on the success path (ZIG-560)', async (t) => {
  stubFetch(t, { artifactId: 'art_1' });

  const bound = (await recordArtifactTool.handler(
    { text: 'x', visibility: 'chat', chatId: 'c1', taskId: 't1', contentType: 'result' },
    CTX,
  )) as Record<string, unknown>;
  assert.match(String(bound['reportingHint']), /task-bound result artifact/);
  assert.match(String(bound['reportingHint']), /task_set_result/);

  const unbound = (await recordArtifactTool.handler(
    { text: 'x', visibility: 'chat', chatId: 'c1', contentType: 'result' },
    CTX,
  )) as Record<string, unknown>;
  assert.match(String(unbound['reportingHint']), /not bound to a task/);

  const plain = (await recordArtifactTool.handler(
    { text: 'x', visibility: 'chat', chatId: 'c1' },
    CTX,
  )) as Record<string, unknown>;
  assert.match(String(plain['reportingHint']), /contentType=result/);
});

test('artifact_record fails loudly when the backend rejects the write', async (t) => {
  stubFetch(t, { message: 'no access' }, false, 403);
  await assert.rejects(
    () =>
      recordArtifactTool.handler(
        { text: 'x', visibility: 'chat', chatId: 'c1' },
        CTX,
      ),
    // The stubbed body's own message, surfaced by the shared apiError parse —
    // not the raw `POST /artifacts <status>` dump.
    /no access/,
  );
});

test('artifact_record requires operatorKey and agentId', async () => {
  await assert.rejects(
    () => recordArtifactTool.handler({ text: 'x', visibility: 'chat', chatId: 'c1' }, {}),
    /operatorKey missing/,
  );
});

const attachArtifactTool = ARTIFACT_TOOLS.find(
  (tool) => tool.schema.function['name'] === 'artifact_attach',
);
if (!attachArtifactTool) {
  throw new Error('ARTIFACT_TOOLS is missing artifact_attach');
}

test('artifact_attach accepts chat, task, or agreement (ZIG-1070)', async (t) => {
  assert.ok(attachArtifactTool);
  const schema = attachArtifactTool.schema.function.parameters;
  assert.ok(schema?.properties && 'agreementId' in schema.properties);
  assert.ok('chatId' in (schema?.properties ?? {}));
  assert.ok('taskId' in (schema?.properties ?? {}));

  await assert.rejects(
    () => attachArtifactTool.handler({ artifactId: 'art_1' }, CTX),
    /exactly one of chatId, taskId, or agreementId/,
  );
  await assert.rejects(
    () =>
      attachArtifactTool.handler(
        { artifactId: 'art_1', chatId: 'c1', agreementId: 'agr_1' },
        CTX,
      ),
    /exactly one of chatId, taskId, or agreementId/,
  );

  const calls = stubFetch(t, { success: true });
  const out = (await attachArtifactTool.handler(
    { artifactId: 'art_1', agreementId: 'agr_1' },
    CTX,
  )) as Record<string, unknown>;
  assert.equal(out['ok'], true);
  assert.equal(out['agreementId'], 'agr_1');
  assert.equal(calls[0]?.opts.method, 'POST');
  assert.match(calls[0]?.url ?? '', /\/agreements\/agr_1\/artifacts$/);
  assert.deepEqual(JSON.parse(calls[0]?.opts.body ?? '{}'), { artifactId: 'art_1' });
});
