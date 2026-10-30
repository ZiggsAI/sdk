import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildOperatorHeaders, laneUnderAgreement } from '../src/http/operatorHeaders.js';
import { ArtifactsClient } from '../src/http/ArtifactsClient.js';
import { ContextReadClient } from '../src/http/ContextReadClient.js';
import { PaymentsClient } from '../src/http/PaymentsClient.js';
import { GrantsClient } from '../src/http/GrantsClient.js';
import { fullCreds } from '../src/capabilities/types.js';

/**
 * ZIG-1092 — the lane an agent is awake in has to reach the backend, or the
 * fence has nothing to fence by.
 *
 * The operator key answers "who is calling"; `X-Ziggs-Lane` answers "on whose
 * behalf, right now". Nothing here is trusted by the server — it re-derives the
 * party orgs itself and refuses a lane the agent is not in — so these tests only
 * assert that the value is carried, not that it is authoritative.
 */
const LANE = 'chat_acme';

describe('buildOperatorHeaders', () => {
  it('sends the lane when there is one', () => {
    const headers = buildOperatorHeaders('key', 'agent-1');
    assert.equal(headers['X-Ziggs-Lane'], undefined);
    assert.equal(headers['X-Agent-Id'], 'agent-1');
  });

  it('omits the header entirely when there is no lane', () => {
    // Omission is meaningful: the backend reads it as "no engagement declared"
    // and fences to the agent's own org, so an absent header narrows reach.
    const headers = buildOperatorHeaders('key', 'agent-1');
    assert.ok(!('X-Ziggs-Lane' in headers));
  });
});

describe('fullCreds', () => {
  it('carries the lane through so every Creds-based client sends it', () => {
    const creds = fullCreds({
      creds: { operatorKey: 'key', agentId: 'agent-1', laneId: LANE },
      surface: 'sdk',
    });
    assert.equal(creds.laneId, LANE);
  });

  it('leaves laneId unset rather than empty when no lane is in context', () => {
    const creds = fullCreds({
      creds: { operatorKey: 'key', agentId: 'agent-1' },
      surface: 'sdk',
    });
    assert.ok(!('laneId' in creds));
  });
});

describe('clients send the lane', () => {
  afterEach(() => mock.restoreAll());

  /** Capture the headers of the next fetch and answer with an empty page. */
  function captureFetch(body: unknown): () => Record<string, string> {
    let seen: Record<string, string> = {};
    mock.method(
      globalThis,
      'fetch',
      (_url: string, init?: { headers?: Record<string, string> }) => {
        seen = init?.headers ?? {};
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      },
    );
    return () => seen;
  }

  it('ArtifactsClient.list sends it — the clearest enumeration vector', async () => {
    const headers = captureFetch({ artifacts: [], latestSequence: null });
    await new ArtifactsClient('key', 'agent-1').list({
      authoredBy: 'me',
    });
    assert.equal(headers()['X-Ziggs-Lane'], undefined);
  });

  it('ContextReadClient.read sends it — the path a cross-room read would leak through', async () => {
    const headers = captureFetch({
      type: 'artifacts',
      via: { kind: 'artifact', id: 'art-1' },
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    await new ContextReadClient('key', 'agent-1', 'http://backend').read(
      'artifacts',
      { via: 'artifact:art-1' },
    );
    assert.equal(headers()['X-Ziggs-Lane'], undefined);
  });

  /**
   * ZIG-1719 — PaymentsClient was the one Creds-based client that did not send
   * it, so every spend arrived with no job named and the backend's grant fence
   * had nothing to compare. The exposure this closes is not enumeration but
   * spend: authority given for one hire being usable inside another.
   */
  it('PaymentsClient sends it — the rail where the leak is money', async () => {
    const headers = captureFetch({
      wallet: { walletId: 'wal_1', currency: 'pez' },
      balance: 0,
      availableBalance: 0,
    });
    await new PaymentsClient('key', 'agent-1', 'http://backend').balance();
    assert.equal(headers()['X-Ziggs-Lane'], undefined);
  });

  /**
   * ZIG-1733 — the grant LIST is the other half of the spend fence. The server
   * answers the spendable rails with only what this wake may spend, and it can
   * only do that if it knows which hire the wake is in. Without the header an
   * agent serving several customers is handed every grant it holds and has to
   * choose, which is what room-booker did wrong.
   */
  it('GrantsClient sends it — a list must not span customers', async () => {
    const headers = captureFetch({ items: [], nextCursor: null });
    await new GrantsClient('key', 'agent-1', 'http://backend').listGrants(
      {},
    );
    assert.equal(headers()['X-Ziggs-Lane'], undefined);
  });

  it('omits the header when the client was built without a lane', async () => {
    const headers = captureFetch({ artifacts: [], latestSequence: null });
    await new ArtifactsClient('key', 'agent-1').list({ authoredBy: 'me' });
    assert.ok(!('X-Ziggs-Lane' in headers()));
  });
});

describe('a room lane under an agreement', () => {
  it('names the agreement next to the room', () => {
    const lane = laneUnderAgreement(LANE, 'agr_1');
    assert.equal(buildOperatorHeaders('key', 'agent-1')['X-Ziggs-Agreement'], undefined);
  });

  it('leaves a lane alone when there is no agreement, or it already is one', () => {
    assert.equal(laneUnderAgreement(LANE, null), LANE);
    assert.equal(laneUnderAgreement('agrn-agr_1', 'agr_2'), 'agrn-agr_1');
    assert.equal(laneUnderAgreement(`${LANE}@agr_1`, 'agr_2'), `${LANE}@agr_1`);
    assert.equal(buildOperatorHeaders('key', 'agent-1')['X-Ziggs-Lane'], undefined);
  });
});
