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
 * MarketplaceClient captures `baseUrl` at module load; load a fresh module
 * after the base URL is configured.
 */
async function loadMarketplaceClient(baseUrl: string) {
  configureApiClient({ httpUrl: baseUrl });
  const href = pathToFileURL(path.join(__dirname, '../src/http/MarketplaceClient.js')).href;
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

/**
 * pullRequests lives here rather than in TaskClient.ts, where it sat under its
 * own "Marketplace: Requests" heading despite hitting the same /marketplace/*
 * base as publishOffer/pullOffers below. Requests are the buyer-broadcast
 * mirror of offers (seller-broadcast) — same domain, same file.
 *
 * Two things are deliberately absent. No claim function: claiming anything is
 * `claimOpenAgreement`, one route for one operation. And since ZIG-1492, no
 * PUBLISH function either — publishing a request is `proposeBroadcast`, the one
 * creation path and the only one that can carry the supplier triage string.
 * The version that used to be tested here had no callers and no way to set
 * `match`, which is exactly how the two doors drifted.
 */
describe('MarketplaceClient (integration, local HTTP)', () => {
  it('pullRequests gets requests with query params', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      assert.equal(req.method, 'GET');
      assert.match(req.url ?? '', /^\/marketplace\/requests\?limit=3$/);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreements: [{ agreementId: 'x' }] }));
    });
    try {
      const { pullRequests } = await loadMarketplaceClient(baseUrl);
      const list = await pullRequests({ limit: 3 }, CREDS) as unknown[];
      assert.equal(list.length, 1);
    } finally {
      await close();
    }
  });

  /**
   * ZIG-1694 — publishing speaks the agreements API's wire shape. The replay
   * handle is the `Idempotency-Key` header, the way `proposeAgreement` sends
   * it, and the response arrives under `agreement`. Both used to be this one
   * route's own convention: the key rode in the body, the row came back as
   * `offer`.
   */
  it('publishOffer sends the key as a header and reads back { agreement }', async () => {
    let seen: { key?: string | string[]; body?: Record<string, unknown> } = {};
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/marketplace/offers/publish');
      seen = {
        key: req.headers['idempotency-key'],
        body: JSON.parse(body || '{}') as Record<string, unknown>,
      };
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'published', agreement: { agreementId: 'agr_o' } }));
    });
    try {
      const { publishOffer } = await loadMarketplaceClient(baseUrl);
      const agreement = await publishOffer(
        { description: 'I do research', price: 500, idempotencyKey: 'offer:a:v1' },
        CREDS,
      ) as { agreementId: string };

      assert.equal(agreement.agreementId, 'agr_o');
      assert.equal(seen.key, 'offer:a:v1');
      assert.equal(seen.body?.description, 'I do research');
      // Not in the body: the route's validation pipe drops unknown keys, so a
      // body field would silently stop being a replay handle.
      assert.equal('idempotencyKey' in (seen.body ?? {}), false);
    } finally {
      await close();
    }
  });

  it('publishOffer refuses a response that carries no agreement', async () => {
    const { baseUrl, close } = await startServer(async (_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'published', offer: { agreementId: 'agr_o' } }));
    });
    try {
      const { publishOffer } = await loadMarketplaceClient(baseUrl);
      await assert.rejects(
        () => publishOffer({ description: 'x' }, CREDS) as Promise<unknown>,
        /expected \{ agreement \}/,
      );
    } finally {
      await close();
    }
  });
});
