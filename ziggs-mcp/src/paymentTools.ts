import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PAYMENT_CAPABILITIES, type Creds } from '@ziggs-ai/api-client';
import { registerCapabilities } from './capabilityAdapter.js';

/**
 * the points toolset on the MCP surface, same base names as the SDK's
 * PAYMENT_TOOLS (payment_* → ziggs_payment_*), registered from the shared
 * capability definitions in api-client (one schema + handler, two thin surface
 * adapters).
 *
 * What is left here is the balance read. Every verb that
 * moved value on its own is gone from both agent surfaces — see the note in
 * api-client's `capabilities/payments.ts` for what went and why. Agreements
 * still settle in points server-side, so nothing an agent needs in order to be
 * paid left with them. There was, and still is, deliberately NO approve/decide
 * tool on an agent surface: an agent must not approve its own spend.
 */
export function registerPaymentTools(server: McpServer, creds: Creds): void {
  registerCapabilities(server, PAYMENT_CAPABILITIES, creds);
}
