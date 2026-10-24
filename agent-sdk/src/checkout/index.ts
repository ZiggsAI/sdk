import { fileURLToPath } from 'node:url';

export type {
  CheckoutBox,
  CheckoutBoxEndpoint,
  CheckoutBoxSpec,
  CheckoutProvider,
  CheckoutCheckpointStore,
  CheckoutTarget,
  CheckoutRunResult,
  CheckoutPushResult,
} from './types.js';
export { CheckoutBoxClient, CheckoutBoxError, doorPathFor, doorHeaders, type GitDoorTarget } from './boxClient.js';
export { checkoutTargetFromText, checkoutTargetFromTask, checkoutBranchForTask } from './intake.js';
export {
  CHECKOUT_TOOLS,
  checkoutReadTool,
  checkoutWriteTool,
  checkoutRunTool,
  checkoutPushTool,
  type CheckoutSession,
} from './tools.js';
export { openCheckout, closeCheckout, type OpenCheckout, type OpenCheckoutDeps } from './open.js';

/**
 * The box server, as a file a host can run with Node, or embed as a task's
 * command. It depends on nothing but Node and git.
 */
export function checkoutBoxServerPath(): string {
  return fileURLToPath(new URL('./box/server.js', import.meta.url));
}
