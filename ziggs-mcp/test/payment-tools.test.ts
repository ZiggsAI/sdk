import assert from 'node:assert/strict';
import { describe, it, mock, afterEach } from 'node:test';
import { registerPaymentTools } from '../src/paymentTools.js';
import { mcpDescription, paymentBalanceCapability } from '@ziggs-ai/api-client';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

function registerAll(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      tools.set(name, handler);
      return { disable: () => undefined, enable: () => undefined };
    },
  };
  registerPaymentTools(server as never, { operatorKey: 'op', agentId: 'delegate-a' });
  return tools;
}

function parsed(out: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(out.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('points are a meter, not money (ZIG-1366 Shape 2)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('no verb on this surface moves value on its own', () => {
    const tools = registerAll();
    // Every free-standing money-movement verb, plus the three grant mutations
    // that let an agent hand spend around on the owner's behalf. Points move
    // as a consequence of an agreement settling, and nowhere else.
    for (const name of [
      'ziggs_payment_transfer',
      'ziggs_payment_hold',
      'ziggs_payment_release',
      'ziggs_payment_wait_for_approval',
      'ziggs_payment_resolve_wallet',
      'ziggs_payment_issue_grant',
      'ziggs_payment_attenuate_grant',
      'ziggs_payment_revoke_grant',
    ]) {
      assert.equal(tools.has(name), false, `${name} must not be on the agent surface`);
    }
    // And there was never an agent-side approve/decide tool — the human decides.
    assert.equal(tools.has('ziggs_payment_decide'), false);
  });

  it('reading your own points balance survives', () => {
    assert.deepEqual([...registerAll().keys()], ['ziggs_payment_balance']);
  });

  it('ziggs_payment_balance unwraps the wallet envelope and impersonates the delegate', async () => {
    const headers: Record<string, string>[] = [];
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      headers.push((init?.headers as Record<string, string>) ?? {});
      return new Response(
        JSON.stringify({
          wallet: { walletId: 'wal_1', currency: 'pez' },
          balance: 900,
          availableBalance: 400,
        }),
        { status: 200 },
      );
    });

    const out = await registerAll().get('ziggs_payment_balance')!({});
    const body = parsed(out);
    assert.equal(body['walletId'], 'wal_1');
    assert.equal(body['availableBalance'], 400);
    assert.equal(body['currency'], 'points');
    assert.equal(body['unit'], 'hundredths of a point');
    assert.equal(JSON.stringify(body).includes('pez'), false);
    assert.equal(headers[0]?.['X-Agent-Id'], 'delegate-a');
  });

  it('describes points without pegging them to a currency', () => {
    // The thing that must never appear is a currency peg. What must NOT appear
    // either is our compliance argument: whether points are legally
    // non-redeemable is still with counsel, and a published package is a
    // commitment we would be held to. So the surface states the operational
    // fact — they move when an agreement settles — and makes no claim about
    // what they are worth or what they can be exchanged for.
    const description = mcpDescription(
      paymentBalanceCapability.names.mcp,
      paymentBalanceCapability.annotation,
    );
    assert.match(description, /points/i);
    assert.match(description, /settle through work/i);
    assert.equal(/\$|dollar|cents\b/i.test(description), false, description);
    assert.equal(
      /never sold|redeemed|redeemable|pegged|exchanged for currency/i.test(description),
      false,
      `the balance description makes a compliance claim that is still under review: ${description}`,
    );
  });
});
