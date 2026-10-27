import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proposeUnified, claimOpenAgreement } from '../src/http/agreementFlows.js';
import { ApiError } from '../src/types.js';

type FetchCall = {
  url: string;
  opts: { method?: string; headers?: Record<string, string>; body?: string };
};

const CREDS = { operatorKey: 'op_test', agentId: 'agent_7' };

/**
 * Route-sensitive fetch stub: responds per URL pattern so one test can cover
 * the read-then-route flows (claim fetches the agreement before deciding).
 */
function stubRoutes(
  t: { after: (fn: () => void) => void },
  routes: Array<{ match: RegExp; body: unknown; ok?: boolean; status?: number }>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (url: unknown, opts: unknown) => {
    calls.push({ url: String(url), opts: (opts || {}) as FetchCall['opts'] });
    const route = routes.find((r) => r.match.test(String(url)));
    if (!route) throw new Error(`unstubbed fetch: ${String(url)}`);
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      statusText: 'OK',
      text: async () => JSON.stringify(route.body),
      json: async () => route.body,
    };
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

// ── proposeUnified routing (ZIG-1022) ───────────────────────────────────────

test('proposeUnified: direct proposal posts to /agreements/proposals with providerId defaulted to proposedTo', async (t) => {
  const calls = stubRoutes(t, [
    { match: /\/agreements\/proposals$/, body: { agreement: { agreementId: 'agr_d' } } },
  ]);
  const { agreement, shape } = await proposeUnified(
    { proposedTo: 'agent_9', chatId: 'chat_1', description: 'do the thing' },
    CREDS,
  );
  assert.equal(shape, 'direct');
  assert.equal(agreement.agreementId, 'agr_d');
  const body = JSON.parse(calls[0]!.opts.body ?? '{}');
  assert.equal(body.proposedTo, 'agent_9');
  assert.equal(body.providerId, 'agent_9');
  assert.equal(body.chatId, 'chat_1');
});

/**
 * ZIG-1445 — a direct proposal with no room is a shape, not an error.
 *
 * This used to reject. The server has always accepted it, so the throw was the
 * only thing making the answer depend on which client you used, and it forced a
 * bookkeeping agreement between parties who have no conversation to invent a
 * chat id in order to exist — the lab's own self-hire passed `lab-hire-<run>`, a
 * chat that does not exist. Delivery never went through the room: the
 * create-time agreement event targets the party slots.
 *
 * The field is OMITTED rather than sent empty, so the server is not handed one
 * more falsy value to interpret.
 */
test('proposeUnified: a direct proposal may carry no room at all', async (t) => {
  const calls = stubRoutes(t, [
    { match: /\/agreements\/proposals$/, body: { agreement: { agreementId: 'agr_nochat' } } },
  ]);
  const { agreement, shape } = await proposeUnified(
    { proposedTo: 'agent_9', description: 'bookkeeping, no conversation' },
    CREDS,
  );
  assert.equal(shape, 'direct');
  assert.equal(agreement.agreementId, 'agr_nochat');
  const body = JSON.parse(calls[0]!.opts.body ?? '{}');
  assert.equal(body.proposedTo, 'agent_9');
  assert.ok(!('chatId' in body), 'no room means no field, not an empty one');
});

test('proposeUnified: broadcast without providerId publishes a request (proposedTo sentinel)', async (t) => {
  const calls = stubRoutes(t, [
    { match: /\/agreements\/proposals$/, body: { agreement: { agreementId: 'agr_q' } } },
  ]);
  const { shape } = await proposeUnified(
    { proposedTo: 'everyone', description: 'open work' },
    CREDS,
  );
  assert.equal(shape, 'request');
  const body = JSON.parse(calls[0]!.opts.body ?? '{}');
  assert.equal(body.proposedTo, 'everyone');
  assert.equal('providerId' in body, false);
});

test('proposeUnified: broadcast with providerId = self publishes a standing offer', async (t) => {
  const calls = stubRoutes(t, [
    // ZIG-1694: the publish answers `agreement`, like every other
    // agreement-creating route. It used to answer `offer`.
    { match: /\/marketplace\/offers\/publish$/, body: { agreement: { agreementId: 'agr_o' } } },
  ]);
  const { agreement, shape } = await proposeUnified(
    { proposedTo: 'org', description: 'I do research', providerId: 'agent_7', price: 500 },
    CREDS,
  );
  assert.equal(shape, 'offer');
  assert.equal(agreement.agreementId, 'agr_o');
  const body = JSON.parse(calls[0]!.opts.body ?? '{}');
  assert.equal(body.audience, 'org');
  assert.equal(body.price, 500);
});

test('proposeUnified: broadcast with a third-party providerId is rejected', async () => {
  await assert.rejects(
    () =>
      proposeUnified(
        { proposedTo: 'everyone', description: 'x', providerId: 'agent_other' },
        CREDS,
      ),
    /providerId must be your own agent id/,
  );
});

test('proposeUnified: a link is not a proposal shape any more', async (t) => {
  // ZIG-1478: the link arm is gone. A link has no price, no chat and no work,
  // and it is formed by `link_propose`, which takes an email or an agent id and
  // answers the same either way. Reaching one through the propose grammar would
  // have been a second door where neither the constant answer nor the
  // refusal of an org-rooted target applies.
  const calls = stubRoutes(t, [
    { match: /\/agreements\/proposals$/, body: { agreement: { agreementId: 'agr_d' } } },
  ]);
  const { shape } = await proposeUnified(
    { proposedTo: 'agent_peer', description: 'link us', engagementKind: 'link', chatId: 'chat_1' },
    CREDS,
  );
  // It falls through to the ordinary direct proposal, and nothing posts to the
  // link rail.
  assert.equal(shape, 'direct');
  assert.equal(
    calls.some((c) => /\/agreements\/links$/.test(c.url)),
    false,
  );
});

// ── claimOpenAgreement (ZIG-1021 / ZIG-1155) ────────────────────────────────
//
// ZIG-1155: this used to read GET /agreements/:id first, purely to decide which
// endpoint to post to. That read is party-scoped and a claimer is by definition
// not yet a party to the broadcast it is claiming, so every standing offer in
// the store failed with "Agreement not found" before either claim endpoint was
// called. Routing moved to the backend; these tests hold the client to ONE
// request, and to reporting the kind the route gives it rather than inferring one.

test('claimOpenAgreement: one request, no party-scoped read first', async (t) => {
  const calls = stubRoutes(t, [
    {
      match: /\/agreements\/agr_o\/claim$/,
      body: { ok: true, kind: 'offer', agreement: { agreementId: 'agr_o', status: 'active' } },
    },
  ]);

  const { kind, agreement } = await claimOpenAgreement('agr_o', CREDS);

  assert.equal(kind, 'offer');
  assert.equal(agreement.agreementId, 'agr_o');
  assert.equal(calls.length, 1, 'exactly one request — no routing read');
  assert.match(calls[0].url, /\/agreements\/agr_o\/claim$/);
  assert.equal(calls[0].opts.method, 'POST');
});

test('claimOpenAgreement: reports every kind the route returns', async (t) => {
  for (const expected of ['link', 'offer', 'request', 'hand-off'] as const) {
    const calls = stubRoutes(t, [
      {
        match: /\/agreements\/agr_k\/claim$/,
        body: { ok: true, kind: expected, agreement: { agreementId: 'agr_k', status: 'active' } },
      },
    ]);
    const { kind } = await claimOpenAgreement('agr_k', CREDS);
    assert.equal(kind, expected);
    assert.equal(calls.length, 1);
  }
});

test('claimOpenAgreement: a server that omits kind still claims', async (t) => {
  stubRoutes(t, [
    {
      match: /\/agreements\/agr_n\/claim$/,
      body: { ok: true, agreement: { agreementId: 'agr_n', status: 'active' } },
    },
  ]);

  const { kind, agreement } = await claimOpenAgreement('agr_n', CREDS);

  assert.equal(agreement.status, 'active');
  assert.equal(kind, 'request', 'falls back to the shape this route has always handled');
});

test('claimOpenAgreement: a rejected claim fails loudly', async (t) => {
  stubRoutes(t, [
    {
      match: /\/agreements\/agr_x\/claim$/,
      body: { message: 'Offer already claimed or not open' },
      ok: false,
      status: 400,
    },
  ]);
  await assert.rejects(
    () => claimOpenAgreement('agr_x', CREDS),
    /400|already claimed/i,
  );
});

// The company audience: every team in the active organization's company.

test('proposeUnified: proposedTo company posts a request to the company', async (t) => {
  const calls = stubRoutes(t, [
    { match: /\/agreements\/proposals$/, body: { agreement: { agreementId: 'agr_c' } } },
  ]);
  const { shape } = await proposeUnified(
    { proposedTo: 'company', description: 'Quarterly numbers' },
    CREDS,
  );
  assert.equal(shape, 'request');
  const body = JSON.parse(calls[0]!.opts.body ?? '{}');
  assert.equal(body.proposedTo, 'company');
});

test('proposeUnified: proposedTo company with providerId = self publishes an offer to the company', async (t) => {
  const calls = stubRoutes(t, [
    { match: /\/marketplace\/offers\/publish$/, body: { agreement: { agreementId: 'agr_co' } } },
  ]);
  const { shape } = await proposeUnified(
    { proposedTo: 'company', description: 'Ask Engineering', providerId: 'agent_7' },
    CREDS,
  );
  assert.equal(shape, 'offer');
  const body = JSON.parse(calls[0]!.opts.body ?? '{}');
  assert.equal(body.audience, 'company');
});

test('a backend that does not know company answers with its own error, not a client crash', async (t) => {
  const refusal = {
    message: ['audience must be one of the following values: everyone, org'],
    error: 'Bad Request',
  };
  stubRoutes(t, [
    { match: /\/marketplace\/offers\/publish$/, ok: false, status: 400, body: refusal },
  ]);
  await assert.rejects(
    () =>
      proposeUnified(
        { proposedTo: 'company', description: 'x', providerId: 'agent_7' },
        CREDS,
      ),
    (err: unknown) => {
      // The server's 400, passed through with its body, not a TypeError here.
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.match(err.body ?? '', /audience must be one of the following values/);
      return true;
    },
  );
});
