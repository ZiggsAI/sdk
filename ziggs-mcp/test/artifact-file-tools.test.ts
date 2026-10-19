import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Creds } from '@ziggs-ai/api-client';
import { createZiggsMcpServer } from '../src/server.js';
import type { ZiggsMcpConfig } from '../src/config.js';
import { callZiggsTool, surfaceTools } from './support/surface.js';

async function withClient(
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createZiggsMcpServer(
    { operatorKey: 'op_test', agentId: 'agent_1' } as unknown as Creds,
    {} as unknown as ZiggsMcpConfig,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

test('file artifact MCP tools are registered under Locked names', async () => {
  await withClient(async (client) => {
    const listed = { tools: await surfaceTools(client) };
    const names = new Set(listed.tools.map((t) => t.name));
    for (const n of [
      'ziggs_artifact_upload_url',
      'ziggs_artifact_complete_file',
      'ziggs_artifact_download',
    ]) {
      assert.ok(names.has(n), `missing ${n}`);
    }
    // ZIG-1384 #2 — re-extraction is a repair operation on our storage, not an
    // agent intent, so it is off this surface entirely.
    assert.equal(names.has('ziggs_artifact_reextract'), false);
    const upload = listed.tools.find((t) => t.name === 'ziggs_artifact_upload_url');
    assert.doesNotMatch(String(upload?.description ?? ''), /ZIG-\d+/);
    // ZIG-1384 #3 — and the two that remain say plainly that they are for a
    // file too large for the one-call record, so nobody learns the dance by default.
    assert.match(String(upload?.description ?? ''), /too large/i);
    assert.match(String(upload?.description ?? ''), /ziggs_artifact_record/);
  });
});

// ZIG-1384 #3 — the ordinary way to record a file: one call that presigns,
// PUTs and completes. The three-step form above stays only for bytes too big
// to travel inside a tool call.
test('ziggs_artifact_record takes the bytes and does the upload dance itself', async (t) => {
  const bytes = Buffer.from('%PDF-1.4 fake\n', 'utf8');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const seen: string[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (url: unknown, opts: unknown) => {
    const u = String(url);
    seen.push(u);
    const o = (opts || {}) as { method?: string; body?: string };
    if (u.includes('/artifacts/upload-url')) {
      const body = JSON.parse(String(o.body)) as Record<string, unknown>;
      // The presign signs a byte count, and S3 rejects a mismatch — so the
      // handler must measure the decoded bytes, not the base64 envelope.
      assert.equal(body.byteSize, bytes.byteLength);
      assert.equal(body.filename, 'report.pdf');
      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () =>
          JSON.stringify({
            artifactId: 'art_pdf',
            uploadUrl: 'https://s3.example/put',
            expiresAt: '2099-01-01T00:00:00.000Z',
            storageKey: 'artifacts/art_pdf',
          }),
        json: async () => ({}),
      };
    }
    if (u === 'https://s3.example/put') {
      return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({}) };
    }
    if (u.includes('/complete')) {
      assert.equal(JSON.parse(String(o.body)).checksum, checksum);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({ artifactId: 'art_pdf', extractionStatus: 'pending' }),
        json: async () => ({}),
      };
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof globalThis.fetch;

  await withClient(async (client) => {
    const out = await callZiggsTool(client, 'ziggs_artifact_record', {
      filename: 'report.pdf',
      mime: 'application/pdf',
      contentBase64: bytes.toString('base64'),
      visibility: 'chat',
      taskId: 'task_1',
    });
    const text = JSON.stringify(out);
    assert.equal((out as { isError?: boolean }).isError, undefined, text);
    assert.match(text, /art_pdf/);
    // One call from the caller, all three steps performed for them.
    assert.ok(seen.some((u) => u.includes('/artifacts/upload-url')));
    assert.ok(seen.includes('https://s3.example/put'));
    assert.ok(seen.some((u) => u.includes('/complete')));
  });
});

// A truncated payload is the ordinary failure when a model inlines a long file,
// and Node's base64 decoder does not report it: it drops what it cannot read and
// returns the shorter buffer. Everything downstream then agrees — the sha256 is
// taken over the survivors, the upload completes, and the caller is told the
// file stored. The only place to catch it is before the presign.
test('ziggs_artifact_record refuses a payload that lost bytes on the way', async (t) => {
  const bytes = Buffer.from('%PDF-1.4 a body long enough to truncate\n', 'utf8');
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (url: unknown) => {
    throw new Error(`nothing should be uploaded, but got ${String(url)}`);
  }) as unknown as typeof globalThis.fetch;

  const whole = bytes.toString('base64');
  await withClient(async (client) => {
    for (const damaged of [
      whole.slice(0, whole.length - 7), // truncated mid-payload
      `${whole.slice(0, 10)}!${whole.slice(11)}`, // a character that carries nothing
    ]) {
      const out = await callZiggsTool(client, 'ziggs_artifact_record', {
        filename: 'report.pdf',
        mime: 'application/pdf',
        contentBase64: damaged,
        visibility: 'chat',
      });
      assert.equal((out as { isError?: boolean }).isError, true);
      assert.match(JSON.stringify(out), /not intact base64/);
    }
  });
});

test('ziggs_artifact_record takes base64 however it was wrapped or encoded', async (t) => {
  // Refusing corruption must not refuse the legitimate spellings: transports
  // wrap long base64, and base64url is what a caller reaching for a URL-safe
  // encoder produces.
  const bytes = Buffer.from([0xfb, 0xff, 0xfe, 0x01, 0x02, 0x03]);
  const sent: number[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (url: unknown, opts: unknown) => {
    const u = String(url);
    const o = (opts || {}) as { body?: string };
    if (u.includes('/artifacts/upload-url')) {
      sent.push(JSON.parse(String(o.body)).byteSize as number);
      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () =>
          JSON.stringify({
            artifactId: 'art_bin',
            uploadUrl: 'https://s3.example/put',
            expiresAt: '2099-01-01T00:00:00.000Z',
            storageKey: 'artifacts/art_bin',
          }),
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ artifactId: 'art_bin' }),
      json: async () => ({}),
    };
  }) as unknown as typeof globalThis.fetch;

  const standard = bytes.toString('base64');
  await withClient(async (client) => {
    for (const spelling of [
      standard,
      standard.replace(/(.{4})/g, '$1\n'), // wrapped
      standard.replace(/\+/g, '-').replace(/\//g, '_'), // base64url
    ]) {
      const out = await callZiggsTool(client, 'ziggs_artifact_record', {
        filename: 'blob.bin',
        mime: 'application/octet-stream',
        contentBase64: spelling,
        visibility: 'chat',
      });
      assert.equal((out as { isError?: boolean }).isError, undefined, JSON.stringify(out));
    }
  });
  // Same bytes every time — the encoding is a spelling, not a size.
  assert.deepEqual(sent, [bytes.byteLength, bytes.byteLength, bytes.byteLength]);
});

test('ziggs_artifact_record refuses a file without the two things a file needs', async () => {
  await withClient(async (client) => {
    const out = await callZiggsTool(client, 'ziggs_artifact_record', {
      contentBase64: Buffer.from('x').toString('base64'),
      visibility: 'chat',
    });
    assert.equal((out as { isError?: boolean }).isError, true);
    assert.match(JSON.stringify(out), /filename is required/);
  });
});

test('ziggs_artifact_record refuses text and bytes together rather than picking one', async () => {
  await withClient(async (client) => {
    const out = await callZiggsTool(client, 'ziggs_artifact_record', {
      text: 'hello',
      contentBase64: Buffer.from('x').toString('base64'),
      filename: 'x.txt',
      mime: 'text/plain',
      visibility: 'chat',
    });
    assert.equal((out as { isError?: boolean }).isError, true);
    assert.match(JSON.stringify(out), /not both/);
  });
});

test('ziggs_artifact_upload_url + complete_file happy path (mocked fetch)', async (t) => {
  const bytes = Buffer.from('# note\n한글\n', 'utf8');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (url: unknown, opts: unknown) => {
    const u = String(url);
    const o = (opts || {}) as { method?: string; body?: string };
    if (u.includes('/artifacts/upload-url')) {
      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () =>
          JSON.stringify({
            artifactId: 'art_md',
            uploadUrl: 'https://s3.example/put',
            expiresAt: '2099-01-01T00:00:00.000Z',
            storageKey: 'artifacts/art_md',
          }),
        json: async () => ({}),
      };
    }
    if (u === 'https://s3.example/put') {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({}),
      };
    }
    if (u.includes('/complete')) {
      assert.equal(o.method, 'POST');
      assert.equal(JSON.parse(String(o.body)).checksum, checksum);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            artifactId: 'art_md',
            extractionStatus: 'pending',
          }),
        json: async () => ({}),
      };
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof globalThis.fetch;

  await withClient(async (client) => {
    const up = await callZiggsTool(client, 'ziggs_artifact_upload_url', {
        filename: 'note.md',
        mime: 'text/markdown',
        byteSize: bytes.byteLength,
        contentBase64: bytes.toString('base64'),
      });
    const upText = JSON.stringify(up);
    assert.match(upText, /art_md/);
    assert.match(upText, new RegExp(checksum));

    const done = await callZiggsTool(client, 'ziggs_artifact_complete_file', { artifactId: 'art_md', checksum });
    assert.match(JSON.stringify(done), /pending/);
  });
});
