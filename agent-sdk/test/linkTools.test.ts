import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LINK_TOOLS,
  linkListTool,
  linkProposeTool,
} from '../src/platform/tools/tier2/linkTools.js';

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

const RAW_LINK_AGREEMENT = {
  agreementId: 'agr_link_1',
  status: 'open',
  proposalStatus: 'proposed',
  engagementKind: 'link',
  // ZIG-1654: what a reader actually receives, which is not what is stored.
  // `buildLinkParties` writes both people's user ids, and the persona pass then
  // masks every party the viewer does not own — a link's two people are in
  // different orgs, so the peer always arrives as a `psn_` face. This fixture
  // used to carry the peer's raw `user_peer` in `provider.principal`, a shape
  // no cross-org reader is ever handed, which is how a client that addressed
  // that slot passed its tests and failed against the server.
  //
  // The addressable peer arrives separately, resolved server-side per viewer.
  parties: {
    creator: { principal: 'user_me', actor: 'agent_7' },
    provider: { principal: 'psn_peerface_0001', actor: null },
    proposedTo: { principal: 'psn_peerface_0001', actor: null },
  },
  peer: { id: 'user_peer', name: 'Peer Person' },
  description: 'demo link',
  createdAt: '2026-07-21T00:00:00.000Z',
  // Noise that must NOT survive into the link summary (ZIG-670 rule):
  money: { price: 0 },
  approvals: [{ role: 'provider' }],
  _id: 'mongo-internal',
};

// ZIG-1021/1022 — the link rail is two tools. Claiming an invite is
// agreement_claim (routing covered in api-client's agreementFlows tests),
// revoking is agreement_revoke.
test('LINK_TOOLS exposes the link rail under SDK base names', () => {
  const names = LINK_TOOLS.map((tool) => tool.schema.function['name']);
  // ZIG-1478: `link_create_invite` is gone. It was `link_propose` with a
  // different way of naming the other side — an assistant had to choose between
  // them before knowing which applied, and could not name a person at all. One
  // verb takes an email, an agent id, or nothing.
  assert.deepEqual(names, ['link_propose', 'link_list']);
});

test('link tools require operatorKey and agentId in context', async () => {
  await assert.rejects(
    () => linkListTool.handler({}, {}),
    /operatorKey missing/,
  );
  await assert.rejects(
    () => linkListTool.handler({}, { operatorKey: 'op' }),
    /agentId missing/,
  );
});

const SENT = { ok: true, status: 'sent', shareUrl: null };

test('link_propose takes an email and answers only that it went', async (t) => {
  const calls = stubFetch(t, SENT);

  const out = (await linkProposeTool.handler(
    { to: 'dana@acme.com' },
    CTX,
  )) as Record<string, unknown>;

  assert.match(calls[0]!.url, /\/agreements\/links$/);
  assert.deepEqual(JSON.parse(calls[0]!.opts.body ?? '{}'), { to: 'dana@acme.com' });
  assert.equal(out['status'], 'sent');
  // Nothing about the recipient comes back: not whether they had an account,
  // not whether the two were already connected, not whether this repeated an
  // earlier invitation. The message says so, so an agent does not go looking.
  assert.equal(out['shareUrl'], null);
  assert.match(String(out['message']), /the answer is the same in every case/);
});

test('link_propose takes an agent id in the same field', async (t) => {
  const calls = stubFetch(t, SENT);

  await linkProposeTool.handler({ to: 'agent_peer' }, CTX);

  // One field, and the server decides what it is. Two fields meant a caller
  // choosing between them before knowing which applied.
  assert.deepEqual(JSON.parse(calls[0]!.opts.body ?? '{}'), { to: 'agent_peer' });
});

test('link_propose with no target hands back the one shareable URL', async (t) => {
  const calls = stubFetch(t, {
    ok: true,
    status: 'sent',
    shareUrl: 'https://app.test/connect/agr_link_1',
  });

  const out = (await linkProposeTool.handler({}, CTX)) as Record<string, unknown>;

  assert.deepEqual(JSON.parse(calls[0]!.opts.body ?? '{}'), {});
  // The public landing, not an in-app claim route: it works with no account,
  // and an assistant handed the same URL reads the connect steps off the page.
  assert.match(String(out['shareUrl']), /\/connect\/agr_link_1$/);
  assert.match(String(out['message']), /shareUrl/);
});

test('link_propose sends seats only for a share link', async (t) => {
  const calls = stubFetch(t, SENT);

  await linkProposeTool.handler({ maxClaims: 5 }, CTX);
  assert.deepEqual(JSON.parse(calls[0]!.opts.body ?? '{}'), { maxClaims: 5 });

  // Seats mean nothing once someone is named: an invitation to one person is
  // for that person, and the server binds it to them.
  await linkProposeTool.handler({ to: 'dana@acme.com', maxClaims: 5 }, CTX);
  assert.deepEqual(JSON.parse(calls[1]!.opts.body ?? '{}'), { to: 'dana@acme.com' });
});

test('link_list filters to engagementKind=link and strips agreement noise', async (t) => {
  const calls = stubFetch(t, {
    agreements: [
      { ...RAW_LINK_AGREEMENT, status: 'active' },
      { ...RAW_LINK_AGREEMENT, agreementId: 'agr_link_2', status: 'active' },
    ],
  });

  const out = (await linkListTool.handler({}, CTX)) as Record<string, unknown>;

  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get('engagementKind'), 'link');
  assert.equal(url.searchParams.get('status'), 'active');
  assert.equal(out['count'], 2);
  const links = out['links'] as Array<Record<string, unknown>>;
  assert.equal('money' in links[0]!, false);
  assert.equal('_id' in links[0]!, false);
  // Active links carry the reach-only next step.
  assert.match(String(out['nextSteps']), /reach-only/);

  // ZIG-1654: the pre-filled follow-up names the peer PERSON, by the one id
  // chat_open accepts. Never a slot out of `parties` — those are display faces,
  // and a face is refused as an address.
  const readPlan = out['readPlan'] as Array<Record<string, unknown>>;
  const opens = readPlan.filter((c) => c['tool'] === 'chat_open');
  assert.ok(opens.length > 0, 'an active link suggests opening a room');
  assert.deepEqual(opens[0]!['args'], { participantId: 'user_peer' });
});

test('link_list status=all drops the status filter and omits nextSteps without actives', async (t) => {
  const calls = stubFetch(t, {
    agreements: [{ ...RAW_LINK_AGREEMENT, status: 'cancelled' }],
  });

  const out = (await linkListTool.handler({ status: 'all' }, CTX)) as Record<
    string,
    unknown
  >;

  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get('status'), null);
  assert.equal('nextSteps' in out, false);
});

test('link_list rejects an unknown status value', async () => {
  await assert.rejects(
    () => linkListTool.handler({ status: 'bogus' }, CTX),
    /status must be one of/,
  );
});

test('link tool errors surface the backend status instead of an empty result', async (t) => {
  stubFetch(t, { message: 'forbidden' }, false, 403);
  await assert.rejects(
    () => linkListTool.handler({}, CTX),
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /forbidden/);
      return true;
    },
  );
});
