import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactsClient } from '../src/http/ArtifactsClient.js';

function mockFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): Array<{ url: string; method: string; body: unknown }> {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return responder(String(url), init);
  });
  return calls;
}

describe('ArtifactsClient.writeStrict (ZIG-899)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('posts the artifact and returns the artifactId', async () => {
    const calls = mockFetch(
      () => new Response(JSON.stringify({ artifactId: 'art_9' }), { status: 200 }),
    );

    const res = await new ArtifactsClient('op', 'agent-a').writeStrict({
      text: ' deliverable ',
      visibility: 'chat',
      agreementId: 'agr_1',
      taskId: 't1',
      contentType: 'result',
    });

    assert.equal(res.artifactId, 'art_9');
    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.url ?? '', /\/artifacts$/);
    assert.equal((calls[0]?.body as Record<string, unknown>)['text'], 'deliverable');
    // ZIG-1009: the posted field name is the thing this migration can break, so
    // it is asserted rather than assumed.
    assert.equal(
      (calls[0]?.body as Record<string, unknown>)['contentType'],
      'result',
    );
  });

  it('forwards externalRef when the deliverable lives elsewhere (ZIG-1232)', async () => {
    const calls = mockFetch(
      () => new Response(JSON.stringify({ artifactId: 'art_ext' }), { status: 200 }),
    );

    await new ArtifactsClient('op', 'agent-a').writeStrict({
      text: 'summary',
      visibility: 'chat',
      externalRef: {
        provider: 'Linear',
        url: 'https://tracker.example.com/issues/1232',
      },
    });

    assert.deepEqual(
      (calls[0]?.body as Record<string, unknown>)['externalRef'],
      {
        provider: 'Linear',
        url: 'https://tracker.example.com/issues/1232',
      },
    );
  });

  it('validates text and rejects only BOTH containers at once', async () => {
    const client = new ArtifactsClient('op');
    await assert.rejects(
      client.writeStrict({ text: '  ', chatId: 'c1' }),
      /text is required/,
    );
    await assert.rejects(
      client.writeStrict({ text: 'x', chatId: 'c1', agreementId: 'a1' }),
      /at most one of chatId or agreementId/,
    );
  });

  // ZIG-1320 — over the inline cap must name the file rail / multi-part hatch
  // before hitting the wire (bare class-validator was the live failure mode).
  it('rejects text over the inline cap with the named escape hatch', async () => {
    const calls = mockFetch(() => new Response('{}', { status: 200 }));
    const tooLong = 'x'.repeat(50_001);
    await assert.rejects(
      new ArtifactsClient('op').writeStrict({ text: tooLong, chatId: 'c1' }),
      /50000 characters.*ziggs_artifact_upload_url.*index artifact.*does not auto-split/s,
    );
    assert.equal(calls.length, 0);
  });

  // ZIG-1037 — a scope-less write used to be a client-side throw ("pass exactly
  // one of chatId or agreementId"), which is what failed a live deliverable for
  // naming no container. It is now a free-standing artifact.
  it('allows a write with no scope at all', async () => {
    const calls = mockFetch(
      () =>
        new Response(JSON.stringify({ status: 'stored', artifactId: 'art_free' }), {
          status: 201,
        }),
    );

    const res = await new ArtifactsClient('op', 'agent-a').writeStrict({
      text: 'a spec with no home yet',
      visibility: 'chat',
    });

    assert.equal(res.artifactId, 'art_free');
    const body = calls[0]?.body as Record<string, unknown>;
    assert.equal(body['chatId'], undefined);
    assert.equal(body['agreementId'], undefined);
  });

  it('allows taskId as the only anchor', async () => {
    const calls = mockFetch(
      () =>
        new Response(JSON.stringify({ status: 'stored', artifactId: 'art_task' }), {
          status: 201,
        }),
    );

    await new ArtifactsClient('op', 'agent-a').writeStrict({
      text: 'the deliverable',
      contentType: 'result',
      taskId: 'tsk_1',
    });

    const body = calls[0]?.body as Record<string, unknown>;
    assert.equal(body['taskId'], 'tsk_1');
    assert.equal(body['chatId'], undefined);
    assert.equal(body['agreementId'], undefined);
  });

  it('forwards a writer-set name on the create', async () => {
    const calls = mockFetch(
      () =>
        new Response(JSON.stringify({ status: 'stored', artifactId: 'art_named' }), {
          status: 201,
        }),
    );

    await new ArtifactsClient('op', 'agent-a').writeStrict({
      text: 'the body',
      name: 'Q3 pricing spec',
      visibility: 'chat',
    });

    const body = calls[0]?.body as Record<string, unknown>;
    assert.equal(body['name'], 'Q3 pricing spec');
  });

  it('lists artifacts the caller authored', async () => {
    const calls = mockFetch(
      () =>
        new Response(JSON.stringify({ artifacts: [], latestSequence: null }), {
          status: 200,
        }),
    );

    await new ArtifactsClient('op', 'agent-a').list({ authoredBy: 'me' });

    assert.match(calls[0]?.url ?? '', /authoredBy=me/);
  });

  it('still requires exactly one list selector', async () => {
    const client = new ArtifactsClient('op', 'agent-a');
    await assert.rejects(
      client.list({}),
      /exactly one of chatId, agreementId, taskId, or authoredBy/,
    );
    await assert.rejects(
      client.list({ chatId: 'c1', authoredBy: 'me' }),
      /exactly one of chatId, agreementId, taskId, or authoredBy/,
    );
  });

  it('throws the server message on a backend rejection (unlike the soft-fail write)', async () => {
    // The one error shape: `{ error }` from the backend's global filter. The
    // thrown ApiError surfaces that message and keeps the status — not the raw
    // `POST /artifacts <status>` dump this client used to produce.
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'not authorized for this scope' }), {
          status: 403,
        }),
    );
    await assert.rejects(
      new ArtifactsClient('op').writeStrict({ text: 'x', chatId: 'c1' }),
      (e: unknown) => {
        assert.match((e as Error).message, /not authorized for this scope/);
        assert.equal((e as { status?: number }).status, 403);
        return true;
      },
    );
  });

  it('write keeps the soft-fail contract on wire errors but still throws on caller mistakes', async () => {
    mockFetch(() => new Response('boom', { status: 500 }));
    const client = new ArtifactsClient('op');
    // Wire failure → swallowed (breadcrumbs are not load-bearing).
    await assert.doesNotReject(client.write({ text: 'x', chatId: 'c1' }));
    // Caller mistake → still loud.
    await assert.rejects(
      client.write({ text: 'x', chatId: 'c1', agreementId: 'a1' }),
      /at most one of chatId or agreementId/,
    );
    // ZIG-1037: no scope is NOT a caller mistake — a breadcrumb with no
    // container is a free-standing artifact, so this stays soft-fail.
    await assert.doesNotReject(client.write({ text: 'x' }));
    // Empty text → silent no-op, no request.
    const calls = mockFetch(() => new Response('{}', { status: 200 }));
    await client.write({ text: '   ', chatId: 'c1' });
    assert.equal(calls.length, 0);
  });
});

describe('ArtifactsClient.attach (ZIG-1070)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('attachToAgreement POSTs /agreements/:id/artifacts', async () => {
    const calls = mockFetch(
      () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    const res = await new ArtifactsClient('op', 'agent-a').attachToAgreement(
      'art_1',
      'agr_1',
    );
    assert.equal(res.success, true);
    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.url ?? '', /\/agreements\/agr_1\/artifacts$/);
    assert.deepEqual(calls[0]?.body, { artifactId: 'art_1' });
  });

  it('attachToChat POSTs /chats/:id/artifacts', async () => {
    const calls = mockFetch(
      () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    await new ArtifactsClient('op').attachToChat('art_1', 'c1');
    assert.match(calls[0]?.url ?? '', /\/chats\/c1\/artifacts$/);
  });
});
