import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defineTool } from '../src/tools/defineTool.js';
import { withDeclaredMandate } from '../src/runtime/mandateDeclaration.js';
import type { ToolManager } from '../src/tools/ToolManager.js';

/**
 * The runtime declares the job a wake is executing inside, so an agent buying
 * the help its assigned work needs is not held for a human who already approved
 * that work. The declaration is only ever ADDED — never invented for a tool that
 * does not ask, never written over something the model said.
 */
const noop = async () => ({});

const managerOf = (...tools: ReturnType<typeof defineTool>[]): ToolManager => {
  const byName = new Map(tools.map((t) => [t.schema.function.name as string, t]));
  return { getTool: (name: string) => byName.get(name) } as unknown as ToolManager;
};

const claimTool = defineTool(
  'agreement_claim',
  { agreementId: { type: 'string', required: true }, mandateAgreementId: 'string' },
  noop,
);
const proposeTool = defineTool(
  'agreement_propose',
  { description: { type: 'string', required: true }, parentAgreementId: 'string' },
  noop,
);
const chatTool = defineTool('chat_send', { message: { type: 'string', required: true } }, noop);

describe('withDeclaredMandate', () => {
  const tm = managerOf(claimTool, proposeTool, chatTool);

  it('names the wake’s own job on a tool that asks for one', () => {
    assert.deepEqual(
      withDeclaredMandate({ agreementId: 'agr-open' }, 'agreement_claim', tm, 'agr-job'),
      { agreementId: 'agr-open', mandateAgreementId: 'agr-job' },
    );
  });

  it('uses the parent field on a tool that parents what it creates', () => {
    assert.deepEqual(
      withDeclaredMandate({ description: 'help' }, 'agreement_propose', tm, 'agr-job'),
      { description: 'help', parentAgreementId: 'agr-job' },
    );
  });

  it('leaves a tool that declares no mandate untouched', () => {
    const args = { message: 'hi' };
    assert.deepEqual(withDeclaredMandate(args, 'chat_send', tm, 'agr-job'), args);
  });

  it('never overwrites a job the model named itself', () => {
    assert.deepEqual(
      withDeclaredMandate(
        { agreementId: 'agr-open', mandateAgreementId: 'agr-other' },
        'agreement_claim',
        tm,
        'agr-job',
      ),
      { agreementId: 'agr-open', mandateAgreementId: 'agr-other' },
    );
  });

  it('takes an explicit empty string as "this belongs to no job"', () => {
    // Saying none is a different answer from saying nothing, and only the
    // second one is ours to fill in.
    assert.deepEqual(
      withDeclaredMandate(
        { agreementId: 'agr-open', mandateAgreementId: '' },
        'agreement_claim',
        tm,
        'agr-job',
      ),
      { agreementId: 'agr-open', mandateAgreementId: '' },
    );
  });

  it('declares nothing when the wake is running inside no job', () => {
    const args = { agreementId: 'agr-open' };
    assert.deepEqual(withDeclaredMandate(args, 'agreement_claim', tm, null), args);
  });

  it('survives an unknown tool and a toolManager that has none', () => {
    const args = { agreementId: 'agr-open' };
    assert.deepEqual(withDeclaredMandate(args, 'nope', tm, 'agr-job'), args);
    assert.deepEqual(withDeclaredMandate(args, 'agreement_claim', undefined, 'agr-job'), args);
  });
});
