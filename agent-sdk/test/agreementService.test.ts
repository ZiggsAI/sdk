import { test } from 'node:test';
import assert from 'node:assert/strict';

const mockArgs = (m: { mock: { calls: unknown[] } }) =>
  (m.mock.calls as Array<{ arguments: unknown[] }>)[0].arguments;

// mock.module() is only available on the TestContext (t.mock), not the global
// mock tracker. We set up the mock inside a top-level test and run subtests
// so that everything shares the same mocked import.

const FAKE_PAIR   = { agreement: { agreementId: 'agr_test' }, task: { taskId: 'tsk_test' } };
const FAKE_STATUS = { agreementId: 'agr_test', proposalStatus: 'pending' };
const FAKE_AGR    = { agreementId: 'agr_test', status: 'open' };
const FAKE_LINK   = { success: true, link: { agreementId: 'agr_test' } };
const CREDS       = { operatorKey: 'opk.test', agentId: 'agent-test' };

test('AgreementService', async (t) => {
  const mockPropose   = t.mock.fn(async () => FAKE_PAIR);
  const mockProposeUnified = t.mock.fn(async () => ({ agreement: FAKE_AGR, shape: 'direct' }));
  const mockProposeBroadcast = t.mock.fn(async () => FAKE_PAIR);
  const mockDelegate  = t.mock.fn(async () => FAKE_PAIR);
  const mockRespond   = t.mock.fn(async () => FAKE_PAIR);
  const mockClaimOpen = t.mock.fn(async () => ({ agreement: FAKE_AGR, kind: 'request' }));
  const mockCounter   = t.mock.fn(async () => FAKE_PAIR);
  const mockGetStatus = t.mock.fn(async () => FAKE_STATUS);
  const mockList      = t.mock.fn(async () => [FAKE_AGR]);
  const mockMine      = t.mock.fn(async () => [FAKE_AGR]);
  const mockGet       = t.mock.fn(async () => FAKE_AGR);
  // ZIG-1478: the route answers only that it went, plus a share URL when the
  // caller named nobody. It used to hand back the agreement row.
  const mockCreateLink = t.mock.fn(async () => ({ ok: true, status: 'sent', shareUrl: null }));
  const mockPublishOffer = t.mock.fn(async () => FAKE_AGR);
  const mockRevoke    = t.mock.fn(async () => ({ ok: true, agreement: FAKE_AGR }));
  const mockFulfill   = t.mock.fn(async () => ({ ok: true, agreement: FAKE_AGR }));
  const mockLinkChat  = t.mock.fn(async () => FAKE_LINK);
  const mockGetChats  = t.mock.fn(async () => [{ chatId: 'c1' }]);
  const mockLinkArt   = t.mock.fn(async () => FAKE_LINK);
  const mockGetArts   = t.mock.fn(async () => [{ artifactId: 'art-1' }]);

  t.mock.module('@ziggs-ai/api-client', {
    namedExports: {
      proposeAgreement:       mockPropose,
      proposeUnified:         mockProposeUnified,
      proposeBroadcast:       mockProposeBroadcast,
      delegateAgreement:      mockDelegate,
      respondToAgreement:     mockRespond,
      claimOpenAgreement:     mockClaimOpen,
      counterAgreement:       mockCounter,
      getAgreementStatus:     mockGetStatus,
      listAgreements:         mockList,
      getMyAgreements:        mockMine,
      getAgreement:           mockGet,
      createLink:             mockCreateLink,
      publishOffer:           mockPublishOffer,
      revokeAgreement:        mockRevoke,
      fulfillAgreement:       mockFulfill,
      linkAgreementToChat:    mockLinkChat,
      getChatsForAgreement:   mockGetChats,
      linkArtifactToAgreement: mockLinkArt,
      getArtifactsForAgreement: mockGetArts,
      OPEN_AGREEMENT_TARGET:  'everyone',
      ORG_AGREEMENT_TARGET:   'org',
    },
  });

  const { AgreementService } = await import('../src/platform/agreements/AgreementService.js');

  // ── Constructor ─────────────────────────────────────────────────────────────

  await t.test('throws when operatorKey is missing', () => {
    assert.throws(
      () => new AgreementService(null as unknown as string, 'agent-test'),
      /operatorKey is required/,
    );
  });

  await t.test('throws when agentId is missing', () => {
    assert.throws(
      () => new AgreementService('opk.test', null as unknown as string),
      /agentId is required/,
    );
  });

  await t.test('stores creds with operatorKey and agentId', () => {
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);
    assert.deepEqual((svc as any).creds, CREDS);
  });

  // ── propose ─────────────────────────────────────────────────────────────────

  await t.test('propose delegates to proposeAgreement with payload and creds', async () => {
    mockPropose.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);
    const payload = { description: 'test', proposedTo: 'user-1', chatId: 'chat-1' };

    const result = await svc.propose(payload);

    assert.equal(mockPropose.mock.calls.length, 1);
    assert.deepEqual(mockArgs(mockPropose)[0], payload);
    assert.deepEqual(mockArgs(mockPropose)[1], CREDS);
    assert.deepEqual(result, FAKE_PAIR);
  });

  await t.test('proposeDirect delegates to proposeAgreement', async () => {
    mockPropose.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);
    const payload = { description: 'direct', proposedTo: 'user-2', chatId: 'chat-2' };

    await svc.proposeDirect(payload);

    assert.equal(mockPropose.mock.calls.length, 1);
    assert.deepEqual(mockArgs(mockPropose)[0], payload);
  });

  await t.test('proposeUnified delegates to the shared flow with creds (ZIG-1123)', async () => {
    mockProposeUnified.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);
    const payload = { description: 'test', proposedTo: 'user-1', chatId: 'chat-1' };

    const result = await svc.proposeUnified(payload);

    assert.equal(mockProposeUnified.mock.calls.length, 1);
    assert.deepEqual(mockArgs(mockProposeUnified)[0], payload);
    assert.deepEqual(mockArgs(mockProposeUnified)[1], CREDS);
    assert.deepEqual(result, { agreement: FAKE_AGR, shape: 'direct' });
  });

  await t.test('proposeBroadcast delegates to api-client proposeBroadcast (default audience)', async () => {
    mockProposeBroadcast.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);
    const payload = { description: 'request', chatId: 'chat-3' };

    await svc.proposeBroadcast(payload);

    assert.equal(mockProposeBroadcast.mock.calls.length, 1);
    assert.deepEqual(mockArgs(mockProposeBroadcast)[0], payload);
    assert.deepEqual(mockArgs(mockProposeBroadcast)[1], CREDS);
  });

  await t.test('proposeBroadcast forwards audience: org for an org-scoped request', async () => {
    mockProposeBroadcast.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);
    const payload = { description: 'request', chatId: 'chat-3', audience: 'org' as const };

    await svc.proposeBroadcast(payload);

    assert.equal(mockProposeBroadcast.mock.calls.length, 1);
    assert.deepEqual(mockArgs(mockProposeBroadcast)[0], payload);
  });

  // ── delegate ────────────────────────────────────────────────────────────────

  await t.test('delegate delegates to delegateAgreement with payload and creds', async () => {
    mockDelegate.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);
    const payload = { description: 'sub', executorId: 'agent-2', chatId: 'c', parentAgreementId: 'agr_p' };

    const result = await svc.delegate(payload);

    assert.equal(mockDelegate.mock.calls.length, 1);
    assert.deepEqual(mockArgs(mockDelegate)[0], payload);
    assert.deepEqual(mockArgs(mockDelegate)[1], CREDS);
    assert.deepEqual(result, FAKE_PAIR);
  });

  // ── respond ─────────────────────────────────────────────────────────────────

  await t.test('respond forwards agreementId, action, and creds', async () => {
    mockRespond.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.respond('agr_test', 'approve');

    const [id, action, creds] = mockArgs(mockRespond);
    assert.equal(id, 'agr_test');
    assert.equal(action, 'approve');
    assert.deepEqual(creds, CREDS);
    assert.deepEqual(result, FAKE_PAIR);
  });

  await t.test('respond forwards reject action unchanged', async () => {
    mockRespond.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    await svc.respond('agr_test', 'reject');

    assert.equal(mockArgs(mockRespond)[1], 'reject');
  });

  // ── counter ─────────────────────────────────────────────────────────────────

  await t.test('counter forwards agreementId, payload, and creds', async () => {
    mockCounter.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);
    const counter = { price: 500, description: 'revised' };

    await svc.counter('agr_test', counter);

    const [id, payload, creds] = mockArgs(mockCounter);
    assert.equal(id, 'agr_test');
    assert.deepEqual(payload, counter);
    assert.deepEqual(creds, CREDS);
  });

  await t.test('counter defaults payload to {} when argument is omitted', async () => {
    mockCounter.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    await svc.counter('agr_test', undefined as unknown as Record<string, unknown>);

    assert.deepEqual(mockArgs(mockCounter)[1], {});
  });

  await t.test('counter defaults payload to {} when null is passed', async () => {
    mockCounter.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    await svc.counter('agr_test', null as unknown as Record<string, unknown>);

    assert.deepEqual(mockArgs(mockCounter)[1], {});
  });

  // ── getStatus ────────────────────────────────────────────────────────────────

  await t.test('getStatus forwards agreementId and creds', async () => {
    mockGetStatus.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.getStatus('agr_test');

    const [id, creds] = mockArgs(mockGetStatus);
    assert.equal(id, 'agr_test');
    assert.deepEqual(creds, CREDS);
    assert.deepEqual(result, FAKE_STATUS);
  });

  // ── CRUD ───────────────────────────────────────────────────────────────────

  await t.test('list forwards filters and creds', async () => {
    mockList.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);
    const filters = { status: 'active' };

    const result = await svc.list(filters);

    assert.deepEqual(mockArgs(mockList), [filters, CREDS]);
    assert.deepEqual(result, [FAKE_AGR]);
  });

  await t.test('mine forwards filters and creds', async () => {
    mockMine.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.mine({ engagementKind: 'hire' });

    assert.deepEqual(mockArgs(mockMine)[1], CREDS);
    assert.deepEqual(result, [FAKE_AGR]);
  });

  await t.test('get forwards agreementId and creds', async () => {
    mockGet.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.get('agr_test');

    assert.deepEqual(mockArgs(mockGet), ['agr_test', CREDS]);
    assert.deepEqual(result, FAKE_AGR);
  });

  await t.test('createLink forwards body and creds', async () => {
    mockCreateLink.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);
    const body = { targetAgentId: 'ag-1' };

    const result = await svc.createLink(body);

    assert.deepEqual(mockArgs(mockCreateLink), [body, CREDS]);
    assert.equal(result.ok, true);
  });

  // The link rail is the only create left on this service: work agreements go
  // through `propose` / the marketplace claim routes, which run term
  // normalisation and the consent gates the old direct create skipped.
  await t.test('requestLink names the target in one field, and there is no generic create', async () => {
    mockCreateLink.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    await svc.requestLink('agent_peer', 'link us');

    // ZIG-1478: one field, whether it holds an email or an agent id. The link is
    // with the PERSON either way, so `targetAgentId` named a side that no longer
    // exists and the caller had to know which of two fields applied.
    assert.deepEqual(mockArgs(mockCreateLink), [
      { to: 'agent_peer', description: 'link us' },
      CREDS,
    ]);
    assert.equal(
      (svc as unknown as Record<string, unknown>).create,
      undefined,
    );
  });

  await t.test('revoke forwards agreementId and creds', async () => {
    mockRevoke.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.revoke('agr_test');

    assert.deepEqual(mockArgs(mockRevoke), ['agr_test', CREDS]);
    assert.equal(result.ok, true);
  });

  await t.test('fulfill forwards agreementId and creds', async () => {
    mockFulfill.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.fulfill('agr_test');

    assert.deepEqual(mockArgs(mockFulfill), ['agr_test', CREDS]);
    assert.equal(result.ok, true);
  });

  // ── Chat links ─────────────────────────────────────────────────────────────

  await t.test('linkToChat forwards all args and creds', async () => {
    mockLinkChat.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    await svc.linkToChat('agr_test', 'chat-1', 'mention');

    assert.deepEqual(mockArgs(mockLinkChat), ['agr_test', 'chat-1', 'mention', CREDS]);
  });

  await t.test('linkToChat defaults linkType to mention', async () => {
    mockLinkChat.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    await svc.linkToChat('agr_test', 'chat-1');

    assert.equal(mockArgs(mockLinkChat)[2], 'mention');
  });

  await t.test('getChats forwards agreementId and creds', async () => {
    mockGetChats.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    await svc.getChats('agr_test');

    assert.deepEqual(mockArgs(mockGetChats), ['agr_test', CREDS]);
  });

  // ── Artifact links ─────────────────────────────────────────────────────────
  await t.test('linkArtifact forwards all args and creds', async () => {
    mockLinkArt.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    await svc.linkArtifact('agr_test', 'art-1', 'referenced');

    assert.deepEqual(mockArgs(mockLinkArt), ['agr_test', 'art-1', 'referenced', CREDS]);
  });

  await t.test('linkArtifact defaults linkType to produced', async () => {
    mockLinkArt.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    await svc.linkArtifact('agr_test', 'art-1');

    assert.equal(mockArgs(mockLinkArt)[2], 'produced');
  });

  await t.test('getArtifacts forwards agreementId and creds', async () => {
    mockGetArts.mock.resetCalls();
    const svc = new AgreementService(CREDS.operatorKey, CREDS.agentId);

    const result = await svc.getArtifacts('agr_test');

    assert.deepEqual(mockArgs(mockGetArts), ['agr_test', CREDS]);
    assert.equal((result as Array<Record<string, unknown>>)[0].artifactId, 'art-1');
  });

});
