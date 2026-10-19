import { PaymentsClient } from '../http/PaymentsClient.js';
import {
  type CapabilityDefinition,
  type CapabilityEnv,
  rethrowWithContext,
} from './types.js';

function client(env: CapabilityEnv): PaymentsClient {
  // laneId too, like every other Creds-based client. Only the balance read is
  // on this surface today, and a read does not spend — but the lane is what
  // fences a spend to the job it was authorised in, so it is wired here rather
  // than left for whoever brings a spending verb back to remember. Omitting it
  // can only leave a spend unfenced; it can never widen one.
  const { operatorKey, agentId, laneId } = env.creds;
  if (!operatorKey) throw new Error('operatorKey missing from tool context');
  return new PaymentsClient(operatorKey, agentId, env.baseUrl, laneId);
}

/**
 * Reading the balance is the whole rail on an agent surface.
 *
 * What left this surface is every verb that moved value on its own:
 * `payment_transfer`, `payment_hold`, `payment_release`,
 * `payment_wait_for_approval` and `payment_resolve_wallet`, plus the three
 * grant mutations (issue / attenuate / revoke), which are now the wallet
 * owner's to make in the web app rather than an agent's to make on their
 * behalf. An agent holding a free-standing "move value from A to B" verb is
 * what reads as transferring a financial asset between third parties, and it
 * is the shape assistant-store connector policy rejects.
 *
 * What did NOT change: agreements still settle in points. The hold on
 * activation, the transfer in `settleCompletedTask` and the settle on fulfill
 * all stay exactly as they were, and priced agreements keep moving points
 * between org wallets. That double-entry IS the meter — the chain and the
 * middleman margins are the measurement we want — so removing the verbs costs
 * no capability: nothing an agent could do through them was load-bearing for
 * getting paid under an agreement.
 *
 * Balance stays readable, because "see your points" is the intended
 * experience. Note that `ZIGGS_MCP_CORE_ONLY` gates this whole group off
 * including balance, so it is not the lever for this on its own.
 */
export const paymentBalanceCapability: CapabilityDefinition = {
  key: 'payment_balance',
  names: { sdk: 'payment_balance', mcp: 'ziggs_payment_balance' },
  title: 'Check your points',
  descriptions: {
    sdk: "Check the caller's points balance and available balance (total minus points held against active agreements). Points settle through work. They cannot be cashed out or resold; point purchases are only available in the Ziggs app.",
  },
  annotation: 'read-only',
  params: {},
  handler: async (_args, env) => {
    try {
      return await client(env).balance();
    } catch (e) {
      rethrowWithContext(e, 'Failed to read points balance');
    }
  },
};

export const PAYMENT_CAPABILITIES: CapabilityDefinition[] = [
  paymentBalanceCapability,
];
