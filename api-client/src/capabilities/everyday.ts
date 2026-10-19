/**
 * The tools a cold session gets with their full schemas.
 *
 * One list for both doors. The MCP door imports this as its native
 * set. The hosted brain loads the same set under the SDK names — the `ziggs_`
 * prefix stripped — except the tools that have no hosted twin: the host owns
 * the inbox, and the SDK has no context-grant revoke.
 *
 * Everything else stays callable. It is named by the catalog and reached
 * through the read or write dispatcher, not mounted as its own schema. A
 * tool's destructive hint never decides this list: the write dispatcher is
 * itself marked destructive, so a host can warn before any dispatched write,
 * and nothing has to be native just to carry the hint.
 */
export const EVERYDAY_MCP_TOOLS = [
  'ziggs_inbox',
  // Count-only orientation: who you are and whether mail is waiting, without
  // taking the mailbox. The full read below is the one that acquires.
  'ziggs_inbox_peek',
  // The ack is native beside the read it follows: a readPlan ends with it, and
  // a caller that had to go through the catalog to close its loop would pay the
  // dispatcher on every pass.
  'ziggs_inbox_ack',
  'ziggs_open',
  'ziggs_context_read',
  'ziggs_chat_open',
  'ziggs_chat_send',
  'ziggs_task_set_result',
  // The two ways out, everyday because taking access back must never need a
  // lookup first (Ido, 2026-09-16).
  'ziggs_agreement_revoke',
  'ziggs_context_revoke_grant',
] as const;

/** Everyday MCP tools the hosted brain does not register. */
export const EVERYDAY_NO_SDK_TWIN = [
  'ziggs_inbox',
  'ziggs_inbox_peek',
  'ziggs_inbox_ack',
  'ziggs_context_revoke_grant',
] as const;

const noSdkTwin = new Set<string>(EVERYDAY_NO_SDK_TWIN);

/** SDK names of the everyday set. Same order as the MCP list, twins only. */
export const EVERYDAY_SDK_TOOLS: readonly string[] = EVERYDAY_MCP_TOOLS
  .filter((name) => !noSdkTwin.has(name))
  .map((name) => name.slice('ziggs_'.length));
