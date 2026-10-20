import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGREEMENT_PROPOSE_PROVIDER_ID_DESCRIPTION, AGREEMENT_TERMS_PARAMS, agreementClaimCapability } from '@ziggs-ai/api-client';
import {
  agreementProposeTool,
  agreementClaimTool,
  taskSetResultTool,
  taskUpdatePlanStepTool,
  taskCreateTool,
  agreementCounterTool,
  agreementGetTool,
  PROTOCOL_TOOLS,
} from '../src/platform/tools/tier1/protocolTools.js';

const stubContextReadClient = {
  snapshot: async () => ({ history: [], agreements: [], agents: [], users: [] }),
};

describe('task_update_plan_step waitingOn (ZIG-1941)', () => {
  it('declares the shape instead of leaving the model to guess it', () => {
    const properties = (
      taskUpdatePlanStepTool.schema.function.parameters as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties;
    const waitingOn = properties.waitingOn as {
      properties?: Record<string, { enum?: string[] }>;
      description?: string;
    };
    // A bare { type: 'object' } left the shape in prose only, so the model
    // guessed a kind the backend refuses with `Invalid waitingOn.kind`.
    assert.deepEqual(waitingOn.properties?.kind?.enum, ['user', 'agent']);
    assert.ok(waitingOn.properties?.id, 'waitingOn.id must be declared');
    assert.match(waitingOn.description ?? '', /both fields required/i);
  });
});

describe('agreement protocol tools', () => {
  it('agreementProposeTool providerId schema states the rule up front (ZIG-1274)', () => {
    const properties = (
      agreementProposeTool.schema.function.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    const desc = properties.providerId?.description ?? '';
    assert.equal(desc, AGREEMENT_PROPOSE_PROVIDER_ID_DESCRIPTION);
    assert.match(desc, /REQUIRED on a direct proposal/i);
    assert.match(desc, /your own id/i);
    assert.match(desc, /proposedTo id/i);
    assert.match(desc, /commissioning the recipient/i);
  });

  it('agreement tools use the shared commercial terms, including the ones the short copy omitted', () => {
    const propose = (
      agreementProposeTool.schema.function.parameters as {
        properties: Record<string, { description?: string; enum?: string[] }>;
      }
    ).properties;
    const counter = (
      agreementCounterTool.schema.function.parameters as {
        properties: Record<string, { description?: string; enum?: string[] }>;
      }
    ).properties;
    assert.equal(propose.price?.description, AGREEMENT_TERMS_PARAMS.price.description);
    assert.deepEqual(propose.interactionMode?.enum, ['messages', 'tasks', 'both']);
    assert.equal(
      propose.interactionMode?.description,
      AGREEMENT_TERMS_PARAMS.interactionMode.description,
    );
    assert.equal(propose.conversationAllowanceScope, undefined);
    assert.equal(counter.price?.description, AGREEMENT_TERMS_PARAMS.price.description);
    assert.deepEqual(counter.interactionMode?.enum, ['messages', 'tasks', 'both']);
    assert.equal(counter.conversationAllowanceScope, undefined);
    assert.equal(counter.description?.description, undefined);
  });

  it('agreementProposeTool throws without taskService', async () => {
    await assert.rejects(
      () =>
        agreementProposeTool.handler(
          { description: 'x' },
          { chatId: 'c', agents: [] },
        ),
      /taskService missing/,
    );
  });

  it('agreementProposeTool throws without agreementService', async () => {
    await assert.rejects(
      () =>
        agreementProposeTool.handler(
          { description: 'x' },
          { chatId: 'c', agents: [], taskService: {} },
        ),
      /agreementService missing/,
    );
  });

  it('taskCreateTool forwards to taskService.spawnUnderAgreement', async () => {
    const calls: Array<{ agreementId: unknown; taskData: unknown }> = [];
    const ctx = {
      chatId: 'c1',
      agents: [],
      agreementService: {},
      contextReadClient: stubContextReadClient,
      taskService: {
        spawnUnderAgreement: async (agreementId: unknown, taskData: unknown) => {
          calls.push({ agreementId, taskData });
          return { taskId: 't-spawned', agreementId, state: 'active' };
        },
      },
    };
    const out = await taskCreateTool.handler(
      { agreementId: 'agr_existing', description: 'this week\'s delivery' },
      ctx,
    ) as Record<string, unknown>;
    assert.equal(out.taskId, 't-spawned');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agreementId, 'agr_existing');
    assert.equal((calls[0].taskData as Record<string, unknown>).description, 'this week\'s delivery');
  });

  it('taskCreateTool declares assigneeId in its schema (ZIG-586 orchestrator delegation)', () => {
    const properties = (taskCreateTool.schema.function.parameters as { properties: Record<string, unknown> }).properties;
    assert.ok('assigneeId' in properties, 'task_create schema must expose assigneeId so the LLM knows it can delegate to a specific agent');
  });

  it('taskCreateTool forwards assigneeId to taskService.spawnUnderAgreement', async () => {
    const calls: Array<{ agreementId: unknown; taskData: unknown }> = [];
    const ctx = {
      chatId: 'c1',
      agents: [],
      agreementService: {},
      contextReadClient: stubContextReadClient,
      taskService: {
        spawnUnderAgreement: async (agreementId: unknown, taskData: unknown) => {
          calls.push({ agreementId, taskData });
          return { taskId: 't-spawned', agreementId, state: 'active' };
        },
      },
    };
    await taskCreateTool.handler(
      { agreementId: 'agr_existing', description: 'delegate to worker', assigneeId: 'agent_worker_1' },
      ctx,
    );
    assert.equal(calls.length, 1);
    assert.equal((calls[0].taskData as Record<string, unknown>).assigneeId, 'agent_worker_1');
  });

  it('taskSetResultTool forwards to taskService.updateState', async () => {
    const ctx = {
      chatId: 'c1',
      agents: [],
      agreementService: {},
      contextReadClient: stubContextReadClient,
      taskService: {
        updateState: async (taskId: unknown, status: unknown, result: unknown) => ({
          taskId,
          status,
          result,
        }),
      },
    };
    const out = await taskSetResultTool.handler(
      { taskId: 'tid', state: 'completed', result: { summary: 'ok' } },
      ctx,
    ) as Record<string, unknown>;
    assert.equal(out.status, 'completed');
  });

  // ── ZIG-132 (agreement-first) ─────────────────────────────────────

  it('agreementCounterTool forwards to agreementService.counter', async () => {
    const calls: Array<{ agreementId: unknown; counter: unknown }> = [];
    const ctx = {
      chatId: 'c1',
      agents: [],
      taskService: {},
      contextReadClient: stubContextReadClient,
      agreementService: {
        counter: async (agreementId: unknown, counter: unknown) => {
          calls.push({ agreementId, counter });
          return { taskId: 'task_counter_xyz', state: 'proposal' };
        },
      },
    };
    const out = await agreementCounterTool.handler(
      { agreementId: 'agr_orig', price: 3000, agreementDescription: 'cheaper' },
      ctx,
    ) as Record<string, unknown>;
    assert.equal(out.taskId, 'task_counter_xyz');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agreementId, 'agr_orig');
    assert.equal((calls[0].counter as Record<string, unknown>).price, 3000);
    assert.equal((calls[0].counter as Record<string, unknown>).agreementDescription, 'cheaper');
  });

  it('every protocol tool has a non-empty description', () => {
    for (const tool of PROTOCOL_TOOLS) {
      const name = (tool.schema.function as Record<string, unknown>).name;
      const desc = (tool.schema.function as Record<string, unknown>).description as string | undefined;
      assert.ok(desc && desc.length > 0, `${name} is missing a description`);
    }
  });

  it('agreement_claim description and params come from the shared capability (ZIG-1123)', () => {
    const desc = (agreementClaimTool.schema.function as Record<string, unknown>).description;
    assert.equal(desc, agreementClaimCapability.descriptions.sdk);
    const properties = (
      agreementClaimTool.schema.function.parameters as {
        properties: Record<string, unknown>;
      }
    ).properties;
    assert.deepEqual(
      Object.keys(properties).sort(),
      Object.keys(agreementClaimCapability.params).sort(),
    );
  });

  it('agreementGetTool forwards to agreementService.getStatus', async () => {
    const ctx = {
      chatId: 'c1',
      agents: [],
      taskService: {},
      contextReadClient: stubContextReadClient,
      agreementService: {
        getStatus: async (agreementId: unknown) => ({
          agreementId,
          proposalStatus: 'pending',
          counterDepth: 0,
        }),
      },
    };
    const out = await agreementGetTool.handler(
      { agreementId: 'agr-1' },
      ctx,
    ) as Record<string, unknown>;
    assert.equal(out.agreementId, 'agr-1');
    assert.equal(out.proposalStatus, 'pending');
  });
});
