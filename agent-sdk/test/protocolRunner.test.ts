import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchProtocolOp } from '../src/platform/tools/tier1/protocolRunner.js';
import { createDeliveryWriteKeys } from '../src/runtime/deliveryWriteKeys.js';

type Services = Parameters<typeof dispatchProtocolOp>[0];

function makeServices(spies: Record<string, Array<unknown>>): Services {
  const taskService = {
    spawnUnderAgreement: async (agreementId: unknown, taskData: unknown) => {
      spies.spawnUnderAgreement?.push({ agreementId, taskData });
      return { taskId: 'spawned', agreementId, ...(taskData as object) };
    },
    getActiveTasksForAgent: async () => [],
    updateState: async (taskId: unknown, state: unknown, result: unknown, idempotencyKey?: unknown) => {
      spies.updateState?.push({ taskId, state, result, ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) });
      return { taskId, state };
    },
    updatePlanStep: async (taskId: unknown, stepId: unknown, status: unknown, result: unknown) => {
      spies.updatePlanStep?.push({ taskId, stepId, status, result });
      return { taskId, stepId, status };
    },
  };
  const agreementService = {
    propose: async (payload: unknown) => {
      spies.propose?.push(payload);
      return { taskId: 'prop', agreementId: 'agr-prop', state: 'proposal', ...(payload as object) };
    },
    proposeUnified: async (payload: unknown) => {
      spies.proposeUnified?.push(payload);
      spies.propose?.push(payload);
      return {
        agreement: {
          taskId: 'prop',
          agreementId: 'agr-prop',
          state: 'proposal',
          ...(payload as object),
        },
        shape: 'direct',
      };
    },
    delegate: async (payload: unknown) => {
      spies.delegate?.push(payload);
      return { taskId: 'del', agreementId: 'agr-del', state: 'proposal', ...(payload as object) };
    },
    respond: async (agreementId: unknown, action: unknown) => {
      spies.respond?.push({ agreementId, action });
      return { agreementId, action };
    },
    claim: async (agreementId: unknown) => {
      spies.claim?.push({ agreementId });
      return {
        kind: 'link',
        agreement: {
          agreementId,
          engagementKind: 'link',
          status: 'active',
          proposalStatus: 'approved',
          parties: { creator: { actor: 'a1' }, provider: { actor: 'a2' } },
          createdAt: '2026-07-01T00:00:00.000Z',
          money: { amount: 0 },
          approvals: [{ partyId: 'a2', status: 'approved' }],
          _id: 'leak',
        },
      };
    },
    revoke: async (agreementId: unknown) => {
      spies.revoke?.push({ agreementId });
      return {
        ok: true,
        agreement: {
          agreementId,
          engagementKind: 'link',
          status: 'cancelled',
          proposalStatus: 'rejected',
          parties: { creator: { actor: 'a1' }, provider: { actor: 'a2' } },
          createdAt: '2026-07-01T00:00:00.000Z',
          money: { amount: 0 },
          approvals: [],
          _id: 'leak',
        },
      };
    },
    requestLink: async (providerId: unknown, description: unknown) => {
      spies.requestLink?.push({ providerId, description });
      return {
        agreementId: 'agr_link_new',
        engagementKind: 'link',
        status: 'open',
        proposalStatus: 'pending',
        parties: { creator: { actor: 'a1' }, provider: { actor: providerId } },
        createdAt: '2026-07-01T00:00:00.000Z',
        description,
        money: { amount: 0 },
        approvals: [{ partyId: providerId, status: 'pending' }],
        _id: 'leak',
      };
    },
    counter: async (agreementId: unknown, counter: unknown) => {
      spies.counter?.push({ agreementId, counter });
      return { taskId: 'task_counter_new', state: 'proposal' };
    },
    getStatus: async (agreementId: unknown) => {
      spies.getStatus?.push({ agreementId });
      return { agreementId, proposalStatus: 'pending', counterDepth: 0 };
    },
  };
  const contextReadClient = {
    snapshot: async () => ({ history: [], agreements: [], agents: [], users: [] }),
  };
  return { taskService, agreementService, contextReadClient } as unknown as Services;
}

describe('dispatchProtocolOp', () => {
  it('returns null without operation', async () => {
    const services = makeServices({});
    assert.equal(await dispatchProtocolOp(services, {}, 'c1'), null);
  });

  // ── Runtime layer ─────────────────────────────────────────────────

  it('routes task-spawn to taskService.spawnUnderAgreement', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { spawnUnderAgreement: [] };
    const services = makeServices(spies);
    const out = await dispatchProtocolOp(
      services,
      {
        operation: 'task-spawn',
        agreementId: 'agr_existing',
        description: 'this week\'s delivery',
      },
      'chat',
    ) as Record<string, unknown>;
    assert.equal(out?.taskId, 'spawned');
    assert.equal(spies.spawnUnderAgreement.length, 1);
    assert.equal(spies.spawnUnderAgreement[0].agreementId, 'agr_existing');
    assert.equal((spies.spawnUnderAgreement[0].taskData as Record<string, unknown>).description, 'this week\'s delivery');
  });

  it('routes task-spawn assigneeId to taskService.spawnUnderAgreement (ZIG-586 orchestrator delegation)', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { spawnUnderAgreement: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      {
        operation: 'task-spawn',
        agreementId: 'agr_existing',
        description: 'hand this to the worker agent',
        assigneeId: 'agent_worker_1',
      },
      'chat',
    );
    assert.equal(spies.spawnUnderAgreement.length, 1);
    assert.equal((spies.spawnUnderAgreement[0].taskData as Record<string, unknown>).assigneeId, 'agent_worker_1');
  });

  it('routes task-spawn inputArtifactIds to taskService.spawnUnderAgreement (ZIG-734)', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { spawnUnderAgreement: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      {
        operation: 'task-spawn',
        agreementId: 'agr_existing',
        description: 'step 2',
        inputArtifactIds: ['art_step1'],
      },
      'chat',
    );
    assert.deepEqual(
      (spies.spawnUnderAgreement[0].taskData as Record<string, unknown>).inputArtifactIds,
      ['art_step1'],
    );
  });

  it('task-spawn omits assigneeId from taskData when not provided', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { spawnUnderAgreement: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      { operation: 'task-spawn', agreementId: 'agr_existing', description: 'unassigned' },
      'chat',
    );
    assert.equal(spies.spawnUnderAgreement.length, 1);
    assert.equal((spies.spawnUnderAgreement[0].taskData as Record<string, unknown>).assigneeId, undefined);
  });

  it('task-spawn returns null without agreementId', async () => {
    const services = makeServices({});
    assert.equal(
      await dispatchProtocolOp(
        services,
        { operation: 'task-spawn', description: 'no contract' },
        'c',
      ),
      null,
    );
  });

  it('routes task-update to taskService.updateState', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { updateState: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      {
        operation: 'task-update',
        taskId: 't1',
        state: 'completed',
        result: 'ok',
      },
      'chat',
    );
    assert.equal(spies.updateState.length, 1);
    assert.deepEqual(spies.updateState[0], {
      taskId: 't1',
      state: 'completed',
      result: 'ok',
    });
  });

  it('task-update ignores legacy status alias (ZIG-1057: state only)', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { updateState: [] };
    const services = makeServices(spies);
    const out = await dispatchProtocolOp(
      services,
      {
        operation: 'task-update',
        taskId: 't1',
        status: 'completed',
        result: { summary: 'ok' },
      },
      'chat',
    );
    assert.equal(out, null);
    assert.equal(spies.updateState.length, 0);
  });

  it('returns null for task-update missing fields', async () => {
    const services = makeServices({});
    assert.equal(
      await dispatchProtocolOp(services, { operation: 'task-update' }, 'c'),
      null,
    );
  });

  it('task-update carries a wake-derived idempotency key that a replay reproduces', async () => {
    const run = async () => {
      const spies: Record<string, Array<Record<string, unknown>>> = { updateState: [] };
      const services = makeServices(spies);
      // Fresh keys per run from the same durable wake inputs — as a crash-replay would derive.
      const writeKeys = createDeliveryWriteKeys('agent-1:chat', { type: 'message', messageId: 'm-7' });
      await dispatchProtocolOp(
        services,
        { operation: 'task-update', taskId: 't1', state: 'done', result: 'ok' },
        'chat',
        [],
        null,
        writeKeys,
      );
      return spies.updateState[0];
    };

    const first = await run();
    const replay = await run();

    // Key derives from the NORMALIZED state ('done' → 'completed'), matching what is sent.
    assert.equal(first.state, 'completed');
    assert.match(String(first.idempotencyKey), /^wk_[0-9a-f]{40}_t_[0-9a-f]{16}$/);
    assert.deepEqual(replay, first);
  });

  it('task-spawn carries a wake-derived idempotency key that a replay reproduces', async () => {
    const run = async () => {
      const spies: Record<string, Array<Record<string, unknown>>> = { spawnUnderAgreement: [] };
      const services = makeServices(spies);
      const writeKeys = createDeliveryWriteKeys('agent-1:chat', { type: 'message', messageId: 'm-7' });
      await dispatchProtocolOp(
        services,
        { operation: 'task-spawn', agreementId: 'agr_existing', description: 'review chunk', assigneeId: 'agent_worker_1' },
        'chat',
        [],
        null,
        writeKeys,
      );
      return spies.spawnUnderAgreement[0].taskData as Record<string, unknown>;
    };

    const first = await run();
    const replay = await run();

    assert.match(String(first.idempotencyKey), /^wk_[0-9a-f]{40}_s_[0-9a-f]{16}$/);
    assert.equal(replay.idempotencyKey, first.idempotencyKey);

    // Two spawns in ONE wake with different content stay distinct.
    const spies: Record<string, Array<Record<string, unknown>>> = { spawnUnderAgreement: [] };
    const services = makeServices(spies);
    const writeKeys = createDeliveryWriteKeys('agent-1:chat', { type: 'message', messageId: 'm-7' });
    await dispatchProtocolOp(services, { operation: 'task-spawn', agreementId: 'agr_existing', description: 'review chunk', assigneeId: 'agent_worker_1' }, 'chat', [], null, writeKeys);
    await dispatchProtocolOp(services, { operation: 'task-spawn', agreementId: 'agr_existing', description: 'review chunk', assigneeId: 'agent_worker_2' }, 'chat', [], null, writeKeys);
    const [s1, s2] = spies.spawnUnderAgreement.map((s) => (s.taskData as Record<string, unknown>).idempotencyKey);
    assert.notEqual(s1, s2);
  });

  it('task-spawn goes keyless when the wake has no durable identity', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { spawnUnderAgreement: [] };
    const services = makeServices(spies);
    const writeKeys = createDeliveryWriteKeys('agent-1:chat', { type: 'state-timeout', state: 'idle', waitedMs: 5 });
    await dispatchProtocolOp(
      services,
      { operation: 'task-spawn', agreementId: 'agr_existing', description: 'unkeyed' },
      'chat',
      [],
      null,
      writeKeys,
    );
    assert.equal((spies.spawnUnderAgreement[0].taskData as Record<string, unknown>).idempotencyKey, undefined);
  });

  it('routes task-update-plan-step to taskService.updatePlanStep', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { updatePlanStep: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      { operation: 'task-update-plan-step', taskId: 't', stepId: 's', status: 'completed', result: 'r' },
      'c',
    );
    assert.equal(spies.updatePlanStep.length, 1);
    assert.deepEqual(spies.updatePlanStep[0], {
      taskId: 't',
      stepId: 's',
      status: 'completed',
      result: 'r',
    });
  });

  it('task-update-plan-step throws when stepId is missing', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { updatePlanStep: [] };
    const services = makeServices(spies);
    await assert.rejects(
      dispatchProtocolOp(
        services,
        { operation: 'task-update-plan-step', taskId: 't', status: 'completed' },
        'c',
      ),
      /stepId/,
    );
    assert.equal(spies.updatePlanStep.length, 0);
  });

  // ── Contract layer ────────────────────────────────────────────────

  it('routes agreement-respond to agreementService.respond', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { respond: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      { operation: 'agreement-respond', agreementId: 'agr-1', action: 'approve' },
      'c',
    );
    assert.deepEqual(spies.respond[0], {
      agreementId: 'agr-1',
      action: 'approve',
    });
  });

  // ZIG-1111: shaping moved to AgreementClient, at the point the agreement
  // document is parsed — see api-client/test/AgreementClient.linkShape.test.ts.
  // The runner's contract is now pass-through: it must NOT re-shape, re-word or
  // drop anything the service layer hands it. Every verb inherits the rule
  // through the client instead of restating it, which is how counter, fulfill
  // and subcontract came to return the raw document while the others did not.
  it('passes agreement results through untouched — the client already shaped them', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = {
      revoke: [],
      claim: [],
      requestLink: [],
    };
    const services = makeServices(spies);

    const revoked = (await dispatchProtocolOp(
      services,
      { operation: 'agreement-revoke', agreementId: 'agr_link_1' },
      'c',
    )) as { ok: boolean; agreement: Record<string, unknown> };
    assert.equal(revoked.ok, true);
    assert.equal(revoked.agreement.agreementId, 'agr_link_1');

    const claimed = (await dispatchProtocolOp(
      services,
      { operation: 'agreement-claim', agreementId: 'agr_link_1' },
      'c',
    )) as { kind: string; status: string; message: string; agreement: Record<string, unknown> };
    assert.equal(claimed.kind, 'link');
    assert.equal(claimed.status, 'linked');
    assert.match(claimed.message, /linked/);
    assert.equal(claimed.agreement.agreementId, 'agr_link_1');

    const proposed = (await dispatchProtocolOp(
      services,
      {
        operation: 'agreement-propose',
        engagementKind: 'link',
        proposedTo: 'agent-2',
        description: 'trust',
      },
      'c',
    )) as Record<string, unknown>;
    assert.equal(proposed.agreementId, 'agr_link_new');
    assert.equal(spies.requestLink.length, 1);
  });

  it('routes agreement-counter-proposal to agreementService.counter', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { counter: [] };
    const services = makeServices(spies);
    const out = await dispatchProtocolOp(
      services,
      {
        operation: 'agreement-counter-proposal',
        agreementId: 'agr-1',
        price: 1500,
        agreementDescription: 'less',
      },
      'c',
    ) as Record<string, unknown>;
    assert.equal(out.taskId, 'task_counter_new');
    assert.equal(spies.counter.length, 1);
    assert.equal(spies.counter[0].agreementId, 'agr-1');
    assert.equal((spies.counter[0].counter as Record<string, unknown>).price, 1500);
    assert.equal((spies.counter[0].counter as Record<string, unknown>).agreementDescription, 'less');
  });

  it('agreement-counter-proposal forwards the shared allowance terms', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { counter: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      {
        operation: 'agreement-counter-proposal',
        agreementId: 'agr-1',
        interactionMode: 'tasks',
        conversationAllowanceScope: 'subtree',
        conversationAllowance: 4,
      },
      'c',
    );
    const counter = spies.counter[0].counter as Record<string, unknown>;
    assert.equal(counter.interactionMode, 'tasks');
    assert.equal(counter.conversationAllowanceScope, undefined);
    assert.equal(counter.conversationAllowance, 4);
  });

  it('agreement-counter-proposal returns null without agreementId', async () => {
    const services = makeServices({});
    assert.equal(
      await dispatchProtocolOp(
        services,
        { operation: 'agreement-counter-proposal', price: 100 },
        'c',
      ),
      null,
    );
  });

  it('routes agreement-check-proposal to agreementService.getStatus', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { getStatus: [] };
    const services = makeServices(spies);
    const out = await dispatchProtocolOp(
      services,
      { operation: 'agreement-check-proposal', agreementId: 'agr-q' },
      'c',
    ) as Record<string, unknown>;
    assert.equal(out.proposalStatus, 'pending');
    assert.equal(spies.getStatus.length, 1);
    assert.equal(spies.getStatus[0].agreementId, 'agr-q');
  });

  it('routes agreement-propose through the shared proposeUnified flow', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { proposeUnified: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      {
        operation: 'agreement-propose',
        description: 'd',
        proposedTo: 'agent-x',
        providerId: 'agent-x',
      },
      'c1',
      [{ agentId: 'agent-x' }],
    );
    assert.equal(spies.proposeUnified.length, 1);
    assert.equal(spies.proposeUnified[0].chatId, 'c1');
    assert.equal(spies.proposeUnified[0].proposedTo, 'agent-x');
    assert.equal(spies.proposeUnified[0].providerId, 'agent-x');
  });

  it('agreement-propose forwards shared terms and drops a mode the server does not accept', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { proposeUnified: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      {
        operation: 'agreement-propose',
        description: 'd',
        proposedTo: 'agent-x',
        providerId: 'agent-x',
        interactionMode: 'tasks',
        conversationAllowanceScope: 'subtree',
        billing: 'per_task',
      },
      'c1',
      [],
    );
    assert.equal(spies.proposeUnified[0].interactionMode, 'tasks');
    assert.equal(spies.proposeUnified[0].conversationAllowanceScope, undefined);
    assert.equal(spies.proposeUnified[0].billing, 'per_task');

    const dropped: Record<string, Array<Record<string, unknown>>> = { proposeUnified: [] };
    await dispatchProtocolOp(
      makeServices(dropped),
      {
        operation: 'agreement-propose',
        description: 'd',
        proposedTo: 'agent-x',
        interactionMode: 'email',
        conversationAllowanceScope: 'room',
      },
      'c1',
      [],
    );
    assert.equal(dropped.proposeUnified[0].interactionMode, undefined);
    assert.equal(dropped.proposeUnified[0].conversationAllowanceScope, undefined);
  });

  it('agreement-propose carries a wake-derived idempotency key that a replay reproduces', async () => {
    const run = async () => {
      const spies: Record<string, Array<Record<string, unknown>>> = { proposeUnified: [] };
      const services = makeServices(spies);
      const writeKeys = createDeliveryWriteKeys('agent-1:chat', { type: 'message', messageId: 'm-7' });
      await dispatchProtocolOp(
        services,
        { operation: 'agreement-propose', description: 'make a logo', proposedTo: 'agent-x', providerId: 'agent-x' },
        'c1',
        [],
        null,
        writeKeys,
      );
      return spies.proposeUnified[0];
    };
    const first = await run();
    const replay = await run();
    assert.match(String(first.idempotencyKey), /^wk_[0-9a-f]{40}_ap_[0-9a-f]{16}$/);
    assert.equal(replay.idempotencyKey, first.idempotencyKey);
  });

  it('agreement-propose goes keyless when the wake has no durable identity', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { proposeUnified: [] };
    const services = makeServices(spies);
    const writeKeys = createDeliveryWriteKeys('agent-1:chat', { type: 'state-timeout', state: 'idle', waitedMs: 5 });
    await dispatchProtocolOp(
      services,
      { operation: 'agreement-propose', description: 'd', proposedTo: 'agent-x', providerId: 'agent-x' },
      'c1',
      [],
      null,
      writeKeys,
    );
    assert.equal(spies.proposeUnified[0].idempotencyKey, undefined);
  });

  it('agreement-propose without providerId on a direct proposal still reaches the shared flow (ZIG-1123)', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { proposeUnified: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      { operation: 'agreement-propose', description: 'd', proposedTo: 'agent-x' },
      'c1',
      [],
    );
    assert.equal(spies.proposeUnified.length, 1);
    assert.equal(spies.proposeUnified[0].proposedTo, 'agent-x');
    assert.equal(spies.proposeUnified[0].providerId, undefined);
  });

  it('agreement-propose refuses a standing listing (ZIG-1979)', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { proposeUnified: [] };
    const services = makeServices(spies);
    await assert.rejects(
      () =>
        dispatchProtocolOp(
          services,
          { operation: 'agreement-propose', description: 'd', proposedTo: 'everyone', providerId: 'agent-x' },
          'c1',
          [],
        ),
      /person or the deploy/,
    );
    assert.equal(spies.proposeUnified.length, 0);
  });

  it('routes agreement-subcontract to agreementService.delegate', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { delegate: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      {
        operation: 'agreement-subcontract',
        description: 'd',
        executorId: 'exec-1',
      },
      'c1',
      [{ agentId: 'exec-1' }],
    );
    assert.equal(spies.delegate.length, 1);
    assert.equal(spies.delegate[0]?.chatId, 'c1');
  });

  it('agreement-subcontract uses a named chat when the tool passed one', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { delegate: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      {
        operation: 'agreement-subcontract',
        description: 'd',
        executorId: 'exec-1',
        chatId: 'chat_named',
      },
      'c-wake',
      [{ agentId: 'exec-1' }],
    );
    assert.equal(spies.delegate[0]?.chatId, 'chat_named');
  });

  it('agreement-subcontract carries a wake-derived idempotency key that a replay reproduces', async () => {
    const run = async () => {
      const spies: Record<string, Array<Record<string, unknown>>> = { delegate: [] };
      const services = makeServices(spies);
      const writeKeys = createDeliveryWriteKeys('agent-1:chat', { type: 'message', messageId: 'm-7' });
      await dispatchProtocolOp(
        services,
        { operation: 'agreement-subcontract', description: 'do the thing', executorId: 'exec-1', parentAgreementId: 'agr-1' },
        'c1',
        [],
        null,
        writeKeys,
      );
      return spies.delegate[0];
    };
    const first = await run();
    const replay = await run();
    assert.match(String(first.idempotencyKey), /^wk_[0-9a-f]{40}_asc_[0-9a-f]{16}$/);
    assert.equal(replay.idempotencyKey, first.idempotencyKey);
  });

  // ── ZIG-858: terminal spawn targets and subcontract term repair ────

  function withChatAgreements(services: Services, ags: Array<Record<string, unknown>>): Services {
    (services as unknown as { contextReadClient: Record<string, unknown> }).contextReadClient = {
      snapshot: async () => ({ history: [], agreements: ags, agents: [], users: [] }),
    };
    return services;
  }

  it('task-spawn against a terminal agreement returns an actionable spawn-target-terminal skip (ZIG-858)', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { spawnUnderAgreement: [] };
    const services = withChatAgreements(makeServices(spies), [
      { agreementId: 'agr_sub', status: 'fulfilled', parties: { provider: { actor: 'agent_w' } } },
    ]);
    const out = await dispatchProtocolOp(
      services,
      { operation: 'task-spawn', agreementId: 'agr_sub', description: 'second task', assigneeId: 'agent_w' },
      'chat',
    ) as Record<string, unknown>;
    assert.equal(out.skipped, 'spawn-target-terminal');
    assert.match(String(out.reason), /Subcontract a new sub-agreement/);
    assert.equal(spies.spawnUnderAgreement.length, 0);
  });

  it('task-spawn citing a terminal sub redirects to the fresh ACTIVE sub for the same executor (ZIG-858)', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { spawnUnderAgreement: [] };
    const services = withChatAgreements(makeServices(spies), [
      { agreementId: 'agr_old', status: 'fulfilled', rootAgreementId: 'agr_root', parties: { provider: { actor: 'agent_w' } } },
      { agreementId: 'agr_new', status: 'active', rootAgreementId: 'agr_root', parties: { provider: { actor: 'agent_w' } } },
    ]);
    await dispatchProtocolOp(
      services,
      { operation: 'task-spawn', agreementId: 'agr_old', description: 'second task', assigneeId: 'agent_w' },
      'chat',
    );
    assert.equal(spies.spawnUnderAgreement.length, 1);
    assert.equal(spies.spawnUnderAgreement[0].agreementId, 'agr_new');
  });

  // ZIG-2055 — the terms the model stated reach the server untouched. With no
  // end date and no task count the server writes a standing sub-agreement,
  // the same as over MCP; this used to become one count-bound task.
  it('agreement-subcontract passes the stated terms through, adding no close condition', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { delegate: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      { operation: 'agreement-subcontract', description: 'd', executorId: 'exec-1' },
      'c1',
      [{ agentId: 'exec-1' }],
    );
    assert.equal(spies.delegate[0].lifecycle, undefined);
    assert.equal(spies.delegate[0].maxExecutions, undefined);

    await dispatchProtocolOp(
      services,
      { operation: 'agreement-subcontract', description: 'd', executorId: 'exec-1', maxExecutions: 2 },
      'c1',
      [{ agentId: 'exec-1' }],
    );
    assert.equal(spies.delegate[1].lifecycle, undefined);
    assert.equal(spies.delegate[1].maxExecutions, 2);
  });

  it('agreement-subcontract does not reuse an open sub-agreement for the same worker', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { delegate: [] };
    const services = makeServices(spies);
    const open = {
      agreementId: 'agr_sub_old',
      status: 'active',
      parentAgreementId: 'agr-1',
      parties: { provider: { actor: 'exec-1' } },
    };
    await dispatchProtocolOp(
      services,
      { operation: 'agreement-subcontract', description: 'd', executorId: 'exec-1', parentAgreementId: 'agr-1' },
      'c1',
      [{ agentId: 'exec-1' }],
      null,
      null,
      [open],
    );
    assert.equal(spies.delegate.length, 1);
  });

  // ZIG-1586 (Ido, 2026-10-01) — the agent sets the price, never the SDK: a
  // propose carries a price only when the model stated one. The server falls
  // back to the provider's listing price, then to free.
  it('sends no price on a propose the model left unpriced, whoever acts', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { propose: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      { operation: 'agreement-propose', description: 'Order coffee', proposedTo: 'user-abc', providerId: 'ziggs-agent' },
      'c1',
      [],
      'ziggs-agent',
    );
    assert.equal(spies.propose.length, 1);
    assert.equal(spies.propose[0].price, undefined);
  });

  it('sends the price the model stated on a propose, unchanged', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { propose: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      { operation: 'agreement-propose', description: 'Order coffee', proposedTo: 'user-abc', providerId: 'ziggs-agent', price: 700 },
      'c1',
      [],
      'ziggs-agent',
    );
    assert.equal(spies.propose[0].price, 700);
  });

  it('sends no price on a counter or a subcontract the model left unpriced', async () => {
    const spies: Record<string, Array<Record<string, unknown>>> = { counter: [], delegate: [] };
    const services = makeServices(spies);
    await dispatchProtocolOp(
      services,
      { operation: 'agreement-counter-proposal', agreementId: 'agr-1', agreementDescription: 'later' },
      'c1',
      [],
      'email-agent',
    );
    await dispatchProtocolOp(
      services,
      { operation: 'agreement-subcontract', description: 'research', executorId: 'company-research', parentAgreementId: 'agr-parent' },
      'c1',
      [],
      'seo-growth',
    );
    assert.equal((spies.counter[0].counter as Record<string, unknown>).price, undefined);
    assert.equal(spies.delegate[0].price, undefined);
  });

  it('agreement-propose without proposedTo throws a descriptive error', async () => {
    const services = makeServices({});
    await assert.rejects(
      dispatchProtocolOp(
        services,
        { operation: 'agreement-propose', description: 'job' },
        'chat-x',
        [],
      ),
      /proposedTo/,
    );
  });

  it('throws for unknown/removed operation agreement-propose-with-subtasks', async () => {
    // agreement-propose-with-subtasks was removed from dispatchProtocolOp; the
    // hardened `default` now throws on unknown operations instead of silently
    // returning null (which the tool layer would surface as a vague error).
    const spies: Record<string, Array<Record<string, unknown>>> = { spawnUnderAgreement: [] };
    const services = makeServices(spies);
    await assert.rejects(
      dispatchProtocolOp(
        services,
        {
          operation: 'agreement-propose-with-subtasks',
          description: 'root',
          agreementId: 'agr-existing',
          subtasks: ['a', 'b'],
        },
        'c1',
      ),
      /Unknown protocol operation/,
    );
    assert.equal(spies.spawnUnderAgreement.length, 0);
  });
});
