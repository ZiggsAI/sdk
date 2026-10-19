import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ArtifactsClient } from '../src/http/ArtifactsClient.js';

type FetchCall = {
  url: string;
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer };
};

function stubFetch(
  t: { after: (fn: () => void) => void },
  handler: (call: FetchCall) => { ok: boolean; status: number; body: unknown },
): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (url: unknown, opts: unknown) => {
    const call = { url: String(url), opts: (opts || {}) as FetchCall['opts'] };
    calls.push(call);
    const out = handler(call);
    return {
      ok: out.ok,
      status: out.status,
      statusText: out.ok ? 'OK' : 'Error',
      text: async () => JSON.stringify(out.body),
      json: async () => out.body,
    };
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

test('uploadUrl posts create then PUTs content and returns checksum', async (t) => {
  const bytes = Buffer.from('hello file\n', 'utf8');
  const calls = stubFetch(t, (call) => {
    if (call.url.includes('/artifacts/upload-url')) {
      return {
        ok: true,
        status: 201,
        body: {
          artifactId: 'art_f1',
          uploadUrl: 'https://s3.example/put',
          expiresAt: '2099-01-01T00:00:00.000Z',
          storageKey: 'artifacts/art_f1',
        },
      };
    }
    if (call.url === 'https://s3.example/put') {
      assert.equal(call.opts.method, 'PUT');
      return { ok: true, status: 200, body: {} };
    }
    throw new Error(`unexpected url ${call.url}`);
  });

  const client = new ArtifactsClient('op_test', 'agent_1');
  const out = await client.uploadUrl({
    filename: 'note.txt',
    mime: 'text/plain',
    byteSize: bytes.byteLength,
    content: bytes,
  });

  assert.equal(out.artifactId, 'art_f1');
  assert.equal(out.putOk, true);
  assert.equal(out.checksum, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /\/artifacts\/upload-url$/);
});

test('completeFile posts checksum', async (t) => {
  const checksum = 'a'.repeat(64);
  stubFetch(t, (call) => {
    assert.match(call.url, /\/artifacts\/art_f1\/complete$/);
    assert.equal(call.opts.method, 'POST');
    assert.equal(JSON.parse(String(call.opts.body)).checksum, checksum);
    return {
      ok: true,
      status: 200,
      body: { artifactId: 'art_f1', extractionStatus: 'pending' },
    };
  });
  const out = await new ArtifactsClient('op_test', 'agent_1').completeFile(
    'art_f1',
    checksum,
  );
  assert.equal(out.extractionStatus, 'pending');
});

test('download returns presign fields', async (t) => {
  stubFetch(t, () => ({
    ok: true,
    status: 200,
    body: {
      downloadUrl: 'https://s3.example/get',
      expiresAt: '2099-01-01T00:00:00.000Z',
      filename: 'note.txt',
    },
  }));
  const out = await new ArtifactsClient('op_test', 'agent_1').download('art_f1');
  assert.equal(out.downloadUrl, 'https://s3.example/get');
  assert.equal(out.filename, 'note.txt');
});

test('reExtract posts to re-extract', async (t) => {
  stubFetch(t, (call) => {
    assert.match(call.url, /\/artifacts\/art_f1\/re-extract$/);
    return {
      ok: true,
      status: 200,
      body: { artifactId: 'art_f1', extractionStatus: 'pending' },
    };
  });
  const out = await new ArtifactsClient('op_test', 'agent_1').reExtract('art_f1');
  assert.equal(out.extractionStatus, 'pending');
});
