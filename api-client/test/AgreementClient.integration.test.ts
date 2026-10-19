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

async function loadAgreementClient(baseUrl: string) {
  configureApiClient({ httpUrl: baseUrl });
  const href = pathToFileURL(path.join(__dirname, '../src/http/AgreementClient.js')).href;
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
      if (!addr || typeof addr === 'string') { reject(new Error('invalid listen address')); return; }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r(undefined))),
      });
    });
    server.on('error', reject);
  });
}

describe('AgreementClient — proposal lifecycle', () => {
  it('proposeAgreement returns Agreement', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/agreements/proposals');
      const j = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal(j['description'], 'do work');
      assert.equal(j['proposedTo'], 'user-1');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreement: { agreementId: 'agr-prop-1' } }));
    });
    try {
      const { proposeAgreement } = await loadAgreementClient(baseUrl);
      const out = await proposeAgreement(
        { description: 'do work', proposedTo: 'user-1', chatId: 'c' },
        CREDS,
      ) as Record<string, unknown>;
      assert.equal(out['agreementId'], 'agr-prop-1');
    } finally { await close(); }
  });

  it('proposeDirectTo posts 1:1 proposal without forcing engagementKind', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      const j = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal(j['proposedTo'], 'user-42');
      assert.equal(j['engagementKind'], undefined);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreement: { agreementId: 'agr-direct' } }));
    });
    try {
      const { proposeDirectTo } = await loadAgreementClient(baseUrl);
      const out = await proposeDirectTo(
        { description: 'job', proposedTo: 'user-42', chatId: 'c' },
        CREDS,
      ) as Record<string, unknown>;
      assert.equal(out['agreementId'], 'agr-direct');
    } finally { await close(); }
  });

  it('proposeBroadcast sets proposedTo to everyone', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      const j = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal(j['proposedTo'], 'everyone');
      assert.equal(j['engagementKind'], undefined);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreement: { agreementId: 'agr-bcast' } }));
    });
    try {
      const { proposeBroadcast } = await loadAgreementClient(baseUrl);
      const out = await proposeBroadcast({ description: 'request', chatId: 'c' }, CREDS) as Record<string, unknown>;
      assert.equal(out['agreementId'], 'agr-bcast');
    } finally { await close(); }
  });

  it('proposeDirectTo forwards engagementKind hire when set', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      const j = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal(j['engagementKind'], 'hire');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreement: { agreementId: 'agr-hire' } }));
    });
    try {
      const { proposeDirectTo } = await loadAgreementClient(baseUrl);
      await proposeDirectTo(
        { description: 'assistant', proposedTo: 'user-1', chatId: 'c', engagementKind: 'hire' },
        CREDS,
      );
    } finally { await close(); }
  });

  it('delegateAgreement returns Agreement', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/agreements/parent-1/delegations');
      const j = JSON.parse(body || '{}') as Record<string, unknown>;
      // parentAgreementId lives in the path; body keeps it too because
      // backend `DelegateTaskDto` validates it as required. Controller
      // merges path over body (path wins) so duplication is harmless.
      // ZIG-270 fix for the ZIG-207 #72 regression that stripped it.
      assert.equal(j['parentAgreementId'], 'parent-1');
      assert.equal(j['executorId'], 'e1');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreement: { agreementId: 'agr-del-1' } }));
    });
    try {
      const { delegateAgreement } = await loadAgreementClient(baseUrl);
      const out = await delegateAgreement(
        { description: 'd', executorId: 'e1', chatId: 'c', parentAgreementId: 'parent-1' },
        CREDS,
      ) as Record<string, unknown>;
      assert.equal(out['agreementId'], 'agr-del-1');
    } finally { await close(); }
  });

  it('delegateAgreement throws when parentAgreementId is missing', async () => {
    const { baseUrl, close } = await startServer(async (_req, res) => {
      // Should never be called — the client must reject before fetching.
      res.writeHead(500); res.end();
    });
    try {
      const { delegateAgreement } = await loadAgreementClient(baseUrl);
      await assert.rejects(
        async () => delegateAgreement(
          { description: 'd', executorId: 'e1', chatId: 'c' } as unknown as Parameters<typeof delegateAgreement>[0],
          CREDS,
        ),
        /parentAgreementId/,
      );
    } finally { await close(); }
  });

  it('uses the backend-authorized customer slot instead of guessing from identity', async () => {
    let wrote = false;
    const { baseUrl, close } = await startServer(async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET') {
        res.end(JSON.stringify({ agreement: { agreementId: 'delegated', engagementKind: 'hire',
          approvals: [{ partyId: 'test-agent', status: 'pending' }, { partyId: 'customer', status: 'pending' }],
          approvalAction: { state: 'available', partyId: 'customer', explanation: 'Existing customer grant' } } }));
      } else {
        assert.equal(req.url, '/agreements/delegated/approvals/customer');
        wrote = true;
        res.end(JSON.stringify({ agreement: { agreementId: 'delegated' } }));
      }
    });
    try {
      const { respondToAgreement } = await loadAgreementClient(baseUrl);
      await respondToAgreement('delegated', 'approve', CREDS);
      assert.equal(wrote, true);
    } finally { await close(); }
  });

  it('does not submit an own-identity slot when the server requires a decision', async () => {
    let writes = 0;
    const { baseUrl, close } = await startServer(async (req, res) => {
      if (req.method !== 'GET') writes++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreement: { agreementId: 'held', engagementKind: 'hire',
        approvals: [{ partyId: 'test-agent', status: 'pending' }],
        approvalAction: { state: 'needs_decision', explanation: 'Ask the accountable party' } } }));
    });
    try {
      const { respondToAgreement } = await loadAgreementClient(baseUrl);
      await assert.rejects(async () => respondToAgreement('held', 'approve', CREDS), /Ask the accountable party/);
      assert.equal(writes, 0);
    } finally { await close(); }
  });

  it('respondToAgreement routes ledger row to PUT /approvals/:partyId', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      if (req.method === 'GET' && req.url === '/agreements/p1') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          agreement: {
            agreementId: 'p1',
            parties: { proposedTo: { principal: null, actor: 'test-agent' } },
            approvals: [{ partyId: 'test-agent', status: 'pending' }],
          },
        }));
        return;
      }
      assert.equal(req.method, 'PUT');
      assert.equal(req.url, '/agreements/p1/approvals/test-agent');
      assert.deepEqual(JSON.parse(body || '{}'), { status: 'approved' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreement: { agreementId: 'p1', status: 'active' } }));
    });
    try {
      const { respondToAgreement } = await loadAgreementClient(baseUrl);
      const out = await respondToAgreement('p1', 'approve', CREDS) as Record<string, unknown>;
      assert.equal(out['agreementId'], 'p1');
    } finally { await close(); }
  });

  /**
   * ZIG-1087 / ZIG-1316 — the slot may belong to the principal. The client used
   * to pre-refuse; now the server accepts under an approval-authority grant
   * (or 403s with an explicit grant message). The PUT must reach the server.
   */
  it('respondToAgreement submits a principal-bound slot so the server can apply a consent grant', async () => {
    let putPath: string | null = null;
    const { baseUrl, close } = await startServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/agreements/p2') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          agreement: {
            agreementId: 'p2',
            parties: { proposedTo: { principal: 'user-owner', actor: null } },
            approvals: [{ partyId: 'user-owner', status: 'pending' }],
          },
        }));
        return;
      }
      if (req.method === 'PUT') {
        putPath = req.url ?? null;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ agreement: { agreementId: 'p2' } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const { respondToAgreement } = await loadAgreementClient(baseUrl);
      const out = await respondToAgreement('p2', 'approve', CREDS, {
        ownerUserId: 'user-owner',
        appUrl: 'https://ziggsai.com/app/agreements/p2',
      }) as Record<string, unknown>;
      assert.equal(out['agreementId'], 'p2');
      assert.match(putPath ?? '', /\/agreements\/p2\/approvals\/user-owner/);
    } finally { await close(); }
  });

  it('respondToAgreement still submits the agent\'s OWN slot when its human also owes one', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      if (req.method === 'GET' && req.url === '/agreements/p3') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          agreement: {
            agreementId: 'p3',
            parties: { proposedTo: { principal: 'user-owner', actor: null } },
            approvals: [
              { partyId: 'user-owner', status: 'pending' },
              { partyId: 'test-agent', status: 'pending' },
            ],
          },
        }));
        return;
      }
      assert.equal(req.url, '/agreements/p3/approvals/test-agent');
      assert.deepEqual(JSON.parse(body || '{}'), { status: 'approved' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreement: { agreementId: 'p3', status: 'active' } }));
    });
    try {
      const { respondToAgreement } = await loadAgreementClient(baseUrl);
      const out = (await respondToAgreement('p3', 'approve', CREDS, {
        ownerUserId: 'user-owner',
      })) as Record<string, unknown>;
      assert.equal(out['agreementId'], 'p3');
    } finally { await close(); }
  });

  // ZIG-1021: respond is approve/reject on DIRECT proposals only. A broadcast
  // has no personal approval slot — neither action may mutate; both point the
  // caller at the claim verb (ZIG-719's honest-failure rule, now symmetric).
  for (const action of ['approve', 'reject'] as const) {
    it(`respondToAgreement ${action} on an open broadcast fails honestly, pointing at agreement_claim`, async () => {
      let mutated = false;
      const { baseUrl, close } = await startServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/agreements/open-1') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            agreement: {
              agreementId: 'open-1',
              parties: { proposedTo: { principal: 'everyone', actor: null } },
            },
          }));
          return;
        }
        // Any non-GET here would mean the client tried to change state — it must not.
        mutated = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ agreement: { agreementId: 'open-1' } }));
      });
      try {
        const { respondToAgreement } = await loadAgreementClient(baseUrl);
        await assert.rejects(
          () => respondToAgreement('open-1', action, CREDS),
          /open broadcast.*agreement_claim/,
        );
        assert.equal(mutated, false, 'respond must not hit any mutating endpoint on a broadcast');
      } finally { await close(); }
    });
  }

  // ZIG-1077: the ONE broadcast a caller may respond to — a hand-off that
  // pins THEM as provider carries their real pending approval slot even as an
  // open broadcast (ZIG-1059). The old guard rejected before looking, so the
  // provider could not consent through any surface and the hand-off sat
  // unclaimable forever (caught live in the ZIG-1049 rehearsal).
  it('respondToAgreement approves a broadcast when the caller holds the pending approval (pinned provider)', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      if (req.method === 'GET' && req.url === '/agreements/handoff-1') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          agreement: {
            agreementId: 'handoff-1',
            providerPinned: true,
            parties: {
              proposedTo: { principal: 'everyone', actor: null },
              provider: { principal: null, actor: 'test-agent' },
              payer: { principal: 'user-publisher', actor: null },
            },
            approvals: [{ partyId: 'test-agent', role: 'provider', status: 'pending' }],
          },
        }));
        return;
      }
      assert.equal(req.method, 'PUT');
      assert.equal(req.url, '/agreements/handoff-1/approvals/test-agent');
      assert.deepEqual(JSON.parse(body || '{}'), { status: 'approved' });
      res.writeHead(200, { 'content-type': 'application/json' });
      // The backend keeps a consented broadcast OPEN for claims (ZIG-1059).
      res.end(JSON.stringify({ agreement: { agreementId: 'handoff-1', status: 'open' } }));
    });
    try {
      const { respondToAgreement } = await loadAgreementClient(baseUrl);
      const out = await respondToAgreement('handoff-1', 'approve', CREDS) as Record<string, unknown>;
      assert.equal(out['agreementId'], 'handoff-1');
      assert.equal(out['status'], 'open');
    } finally { await close(); }
  });

  it('respondToAgreement uses PUT /approvals when no ledger row but proposedTo matches', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      if (req.method === 'GET' && req.url === '/agreements/legacy-1') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          agreement: {
            agreementId: 'legacy-1',
            parties: { proposedTo: { principal: 'user-999', actor: null } },
            approvals: [],
          },
        }));
        return;
      }
      assert.equal(req.method, 'PUT');
      assert.equal(req.url, '/agreements/legacy-1/approvals/user-999');
      assert.deepEqual(JSON.parse(body || '{}'), { status: 'rejected' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreement: { agreementId: 'legacy-1' } }));
    });
    try {
      const { respondToAgreement } = await loadAgreementClient(baseUrl);
      const out = await respondToAgreement('legacy-1', 'reject', {
        ...CREDS,
        agentId: 'user-999',
      }, { ownerUserId: 'user-999' }) as Record<string, unknown>;
      assert.equal(out['agreementId'], 'legacy-1');
    } finally { await close(); }
  });

  it('counterAgreement returns Agreement', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/agreements/a1/counter');
      const j = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal(j['price'], 500);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreement: { agreementId: 'agr-c1' } }));
    });
    try {
      const { counterAgreement } = await loadAgreementClient(baseUrl);
      const out = await counterAgreement('a1', { price: 500 }, CREDS) as Record<string, unknown>;
      assert.equal(out['agreementId'], 'agr-c1');
    } finally { await close(); }
  });

  it('getAgreementStatus returns status object', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      assert.equal(req.url, '/agreements/a2/status');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreementId: 'a2', proposalStatus: 'pending' }));
    });
    try {
      const { getAgreementStatus } = await loadAgreementClient(baseUrl);
      const out = await getAgreementStatus('a2', CREDS) as Record<string, unknown>;
      assert.equal(out['agreementId'], 'a2');
    } finally { await close(); }
  });

  it('getAgreementStatus returns null on 404', async () => {
    const { baseUrl, close } = await startServer(async (_req, res) => {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
    });
    try {
      const { getAgreementStatus } = await loadAgreementClient(baseUrl);
      assert.equal(await getAgreementStatus('missing', CREDS), null);
    } finally { await close(); }
  });
});

describe('AgreementClient — CRUD', () => {
  it('listAgreements passes query params', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      const u = new URL(req.url || '', 'http://127.0.0.1');
      assert.equal(u.pathname, '/agreements');
      assert.equal(u.searchParams.get('status'), 'active');
      assert.equal(u.searchParams.get('engagementKind'), 'hire');
      // `scope` must NOT be set — listAgreements is the basic-list path.
      assert.equal(u.searchParams.get('scope'), null);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreements: [{ agreementId: 'a1' }] }));
    });
    try {
      const { listAgreements } = await loadAgreementClient(baseUrl);
      const out = await listAgreements({ status: 'active', engagementKind: 'hire' }, CREDS) as Array<Record<string, unknown>>;
      assert.equal(out.length, 1);
      assert.equal(out[0]['agreementId'], 'a1');
    } finally { await close(); }
  });

  it('getMyAgreements returns enriched agreements (scope=mine)', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      const u = new URL(req.url || '', 'http://127.0.0.1');
      assert.equal(u.pathname, '/agreements');
      assert.equal(u.searchParams.get('scope'), 'mine');
      // No partyOnly unless explicitly requested — reachable-in-org default.
      assert.equal(u.searchParams.get('partyOnly'), null);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreements: [{ agreementId: 'a2' }] }));
    });
    try {
      const { getMyAgreements } = await loadAgreementClient(baseUrl);
      const out = await getMyAgreements({}, CREDS) as Array<Record<string, unknown>>;
      assert.equal(out[0]['agreementId'], 'a2');
    } finally { await close(); }
  });

  it('getMyAgreements passes partyOnly=true for a true caller-is-party "mine" (ZIG-942)', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      const u = new URL(req.url || '', 'http://127.0.0.1');
      assert.equal(u.pathname, '/agreements');
      assert.equal(u.searchParams.get('scope'), 'mine');
      assert.equal(u.searchParams.get('partyOnly'), 'true');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreements: [] }));
    });
    try {
      const { getMyAgreements } = await loadAgreementClient(baseUrl);
      assert.deepEqual(await getMyAgreements({ partyOnly: true }, CREDS), []);
    } finally { await close(); }
  });

  it('listAgreements / getMyAgreements return [] for a genuine empty 200 (ZIG-699)', async () => {
    const { baseUrl, close } = await startServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreements: [] }));
    });
    try {
      const { listAgreements, getMyAgreements } = await loadAgreementClient(baseUrl);
      assert.deepEqual(await listAgreements({}, CREDS), []);
      assert.deepEqual(await getMyAgreements({}, CREDS), []);
    } finally { await close(); }
  });

  it('listAgreements throws (not []) on 500 so the tool reports a real error (ZIG-699)', async () => {
    const { baseUrl, close } = await startServer(async (_req, res) => {
      res.writeHead(500); res.end('upstream exploded');
    });
    try {
      const { listAgreements } = await loadAgreementClient(baseUrl);
      await assert.rejects(
        () => listAgreements({}, CREDS),
        (err: Error & { status?: number }) => {
          assert.equal(err.status, 500);
          assert.match(err.message, /upstream exploded/);
          return true;
        },
      );
    } finally { await close(); }
  });

  it('getMyAgreements throws (not []) on 403 (ZIG-699)', async () => {
    const { baseUrl, close } = await startServer(async (_req, res) => {
      res.writeHead(403); res.end(JSON.stringify({ error: 'not authorized' }));
    });
    try {
      const { getMyAgreements } = await loadAgreementClient(baseUrl);
      await assert.rejects(
        () => getMyAgreements({}, CREDS),
        (err: Error & { status?: number }) => {
          assert.equal(err.status, 403);
          assert.match(err.message, /not authorized/);
          return true;
        },
      );
    } finally { await close(); }
  });

  it('getAgreement returns agreement object', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      assert.equal(req.url, '/agreements/a3');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agreement: { agreementId: 'a3', status: 'open' } }));
    });
    try {
      const { getAgreement } = await loadAgreementClient(baseUrl);
      const out = await getAgreement('a3', CREDS) as Record<string, unknown>;
      assert.equal(out['agreementId'], 'a3');
    } finally { await close(); }
  });

  it('getAgreement returns null on 404', async () => {
    const { baseUrl, close } = await startServer(async (_req, res) => {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
    });
    try {
      const { getAgreement } = await loadAgreementClient(baseUrl);
      assert.equal(await getAgreement('missing', CREDS), null);
    } finally { await close(); }
  });

  it('getAgreement throws (not null) on 403 so callers can tell denied from not-found (ZIG-698)', async () => {
    const { baseUrl, close } = await startServer(async (_req, res) => {
      res.writeHead(403); res.end(JSON.stringify({ error: 'not authorized' }));
    });
    try {
      const { getAgreement } = await loadAgreementClient(baseUrl);
      await assert.rejects(
        () => getAgreement('a5', CREDS),
        (err: Error & { status?: number }) => {
          assert.equal(err.status, 403);
          assert.match(err.message, /not authorized/);
          return true;
        },
      );
    } finally { await close(); }
  });

  it('getAgreement throws on 500 (ZIG-698)', async () => {
    const { baseUrl, close } = await startServer(async (_req, res) => {
      res.writeHead(500); res.end('upstream exploded');
    });
    try {
      const { getAgreement } = await loadAgreementClient(baseUrl);
      await assert.rejects(
        () => getAgreement('a6', CREDS),
        (err: Error & { status?: number }) => {
          assert.equal(err.status, 500);
          assert.match(err.message, /upstream exploded/);
          return true;
        },
      );
    } finally { await close(); }
  });

  // The link rail. This used to be `createAgreement` against POST /agreements,
  // which also created work agreements inline and skipped the proposal path's
  // term normalisation and consent gates. Work goes through proposeAgreement.
  it('createLink sends one target field and reads back the row it named', async () => {
    // ZIG-1478 put one target field on the route and one constant `status`.
    // ZIG-1613 adds `agreementId` for a NAMED agent id: the route resolves an
    // agent id through root authority and refuses a name that answers to
    // nobody, so that arm already discloses its target's existence and an id
    // leaks nothing further. What it buys is a caller that can reference the row
    // it just created.
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/agreements/links');
      const j = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal(j['to'], 'ag-1');
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, status: 'sent', agreementId: 'agr_link', shareUrl: null }),
      );
    });
    try {
      const { createLink } = await loadAgreementClient(baseUrl);
      assert.deepEqual(await createLink({ to: 'ag-1' }, CREDS), {
        ok: true,
        status: 'sent',
        agreementId: 'agr_link',
        shareUrl: null,
      });
    } finally { await close(); }
  });

  it('createLink reports no row for an email, whatever the knock found', async () => {
    // The half of ZIG-1478 that ZIG-1613 does not touch. The knock answers the
    // same for "no such person", "already linked", "already knocked" and "that
    // is yourself", so the route sends no id on this arm and the client must not
    // invent one from an absent field.
    const { baseUrl, close } = await startServer(async (_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'sent', agreementId: null, shareUrl: null }));
    });
    try {
      const { createLink } = await loadAgreementClient(baseUrl);
      const out = await createLink({ to: 'dana@acme.com' }, CREDS);
      assert.equal(out.agreementId, null);
      assert.equal(out.shareUrl, null);
    } finally { await close(); }
  });

  it('createLink hands back a share URL when nothing was named', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      const j = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal(j['to'], undefined);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          status: 'sent',
          agreementId: 'a4',
          shareUrl: 'https://app.test/connect/a4',
        }),
      );
    });
    try {
      const { createLink } = await loadAgreementClient(baseUrl);
      const out = await createLink({}, CREDS);
      assert.equal(out.shareUrl, 'https://app.test/connect/a4');
      // The invite is the row: an open invite's id is already in the URL.
      assert.equal(out.agreementId, 'a4');
    } finally { await close(); }
  });

  it('createLink refuses a reply that is not the one constant shape', async () => {
    // The old envelope was `{ ok, agreement }`. A server still answering that
    // way would otherwise be read as success with no share link at all.
    const { baseUrl, close } = await startServer(async (_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agreement: { agreementId: 'a4' } }));
    });
    try {
      const { createLink } = await loadAgreementClient(baseUrl);
      await assert.rejects(() => createLink({}, CREDS), /status: "sent"/);
    } finally { await close(); }
  });

  it('createLink throws on error', async () => {
    const { baseUrl, close } = await startServer(async (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
    });
    try {
      const { createLink } = await loadAgreementClient(baseUrl);
      await assert.rejects(async () => createLink({}, CREDS), (err: unknown) => {
        assert.equal((err as Record<string, unknown>)['status'], 400);
        return true;
      });
    } finally { await close(); }
  });

  it('revokeAgreement DELETEs the agreement', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      assert.equal(req.method, 'DELETE');
      assert.equal(req.url, '/agreements/a5');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agreement: { agreementId: 'a5', status: 'cancelled' } }));
    });
    try {
      const { revokeAgreement } = await loadAgreementClient(baseUrl);
      const out = await revokeAgreement('a5', CREDS) as Record<string, Record<string, unknown>>;
      assert.equal(out['agreement']['status'], 'cancelled');
    } finally { await close(); }
  });
});

describe('AgreementClient — chat links', () => {
  it('linkAgreementToChat posts link', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.url, '/agreements/a1/link');
      const j = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal(j['chatId'], 'c1');
      assert.equal(j['linkType'], 'mention');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    try {
      const { linkAgreementToChat } = await loadAgreementClient(baseUrl);
      const out = await linkAgreementToChat('a1', 'c1', 'mention', CREDS) as Record<string, unknown>;
      assert.equal(out['success'], true);
    } finally { await close(); }
  });

  it('getChatsForAgreement returns links', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      assert.equal(req.url, '/agreements/a1/chats');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ links: [{ chatId: 'c1' }, { chatId: 'c2' }] }));
    });
    try {
      const { getChatsForAgreement } = await loadAgreementClient(baseUrl);
      const out = await getChatsForAgreement('a1', CREDS) as unknown[];
      assert.equal(out.length, 2);
    } finally { await close(); }
  });

});

describe('AgreementClient — artifact links', () => {
  it('linkArtifactToAgreement posts artifact link', async () => {
    const { baseUrl, close } = await startServer(async (req, res, body) => {
      assert.equal(req.url, '/agreements/a1/artifacts');
      const j = JSON.parse(body || '{}') as Record<string, unknown>;
      assert.equal(j['artifactId'], 'art-1');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    try {
      const { linkArtifactToAgreement } = await loadAgreementClient(baseUrl);
      const out = await linkArtifactToAgreement('a1', 'art-1', 'produced', CREDS) as Record<string, unknown>;
      assert.equal(out['success'], true);
    } finally { await close(); }
  });

  it('getArtifactsForAgreement returns enriched artifacts', async () => {
    const { baseUrl, close } = await startServer(async (req, res) => {
      assert.equal(req.url, '/agreements/a1/artifacts');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ artifacts: [{ artifactId: 'art-1' }] }));
    });
    try {
      const { getArtifactsForAgreement } = await loadAgreementClient(baseUrl);
      const out = await getArtifactsForAgreement('a1', CREDS) as Array<Record<string, unknown>>;
      assert.equal(out.length, 1);
      assert.equal(out[0]['artifactId'], 'art-1');
    } finally { await close(); }
  });
});

describe('AgreementClient — input guards', () => {
  it('getAgreement returns null for empty id', async () => {
    const { getAgreement } = await loadAgreementClient('http://127.0.0.1:9');
    assert.equal(await getAgreement('', CREDS), null);
  });

  it('createLink rejects missing body', async () => {
    const { createLink } = await loadAgreementClient('http://127.0.0.1:9');
    await assert.rejects(async () => createLink(null, CREDS), /Body is required/);
  });

  it('proposeAgreement rejects missing creds', async () => {
    const { proposeAgreement } = await loadAgreementClient('http://127.0.0.1:9');
    await assert.rejects(async () => proposeAgreement({ description: 'x' }, {}), /operatorKey is required/);
  });
});
