import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TitledAnnotations } from './toolAnnotations.js';

/** The same reviewed OAuth surface for ChatGPT, Claude and Cursor. */
const directories = new WeakSet<McpServer>();
export const DIRECTORY_TOOLS = new Set(`
ziggs_auth_status ziggs_org_list ziggs_workspace_sync ziggs_context_snapshot
ziggs_notification_status
ziggs_agreement_list ziggs_agreement_get ziggs_chat_list ziggs_chat_open ziggs_chat_send
ziggs_agreement_buy ziggs_agreement_bid ziggs_agreement_broker ziggs_agreement_request
ziggs_agreement_handoff
ziggs_agreement_claim ziggs_agreement_subcontract ziggs_marketplace_view
ziggs_agreement_respond ziggs_agreement_revoke ziggs_agreement_counter ziggs_agreement_fulfill
ziggs_inbox_changes ziggs_inbox_peek ziggs_inbox ziggs_inbox_show ziggs_inbox_claim ziggs_inbox_ack ziggs_inbox_defer
ziggs_grant_list ziggs_context_expand_reach ziggs_context_discover_grantable
ziggs_open ziggs_access_explain ziggs_context_read
ziggs_artifact_record ziggs_artifact_list ziggs_artifact_find ziggs_artifact_share
ziggs_artifact_attach ziggs_artifact_contribute ziggs_artifact_upload_url ziggs_artifact_complete_file ziggs_artifact_download
ziggs_task_create ziggs_task_set_result ziggs_task_replace_plan ziggs_task_update_steps
ziggs_task_acknowledge_control ziggs_task_list ziggs_task_cancel ziggs_task_delegate ziggs_task_get
ziggs_connection_list ziggs_agent_search ziggs_agent_get
ziggs_context_delegate ziggs_access_request
ziggs_link_propose ziggs_link_list ziggs_introduction_mint ziggs_introduction_redeem
ziggs_introduction_list ziggs_introduction_revoke ziggs_context_revoke_grant ziggs_payment_balance
`.trim().split(/\s+/));

/**
 * Tools the allow-list names but a credential may not be able to use. The
 * roster sync needs a connection key; a device-boarded key names one assistant
 * in one workspace, so tools.ts registers it only when the key carries a
 * connection. Tests subtract this set for such a key.
 */
export const CONNECTION_ONLY_DIRECTORY_TOOLS = new Set(['ziggs_workspace_sync', 'ziggs_notification_status']);

/** Public discovery and actions accepting new counterparties or audiences. */
const OPEN_WORLD = new Set(`
ziggs_agent_search ziggs_agent_get ziggs_marketplace_view
ziggs_agreement_buy ziggs_agreement_bid ziggs_agreement_broker ziggs_agreement_request
ziggs_agreement_handoff ziggs_agreement_claim ziggs_agreement_subcontract
ziggs_task_delegate ziggs_chat_open ziggs_chat_send ziggs_artifact_share ziggs_artifact_attach ziggs_artifact_contribute
ziggs_context_delegate ziggs_access_request
ziggs_link_propose ziggs_introduction_mint ziggs_introduction_redeem
`.trim().split(/\s+/));

export function installDirectorySurface(server: McpServer): void {
  directories.add(server);
}
export function isDirectorySurface(server: McpServer): boolean {
  return directories.has(server);
}

/**
 * No host-specific names or sniffing: all directory clients get these hints.
 *
 * Read-only and destructive come from the tool's own annotation, audited per
 * tool where it is registered against the directories' definition: a write is
 * destructive when it sends, commits, overwrites, cancels or revokes, and being
 * able to undo it does not make it additive. Only private additive writes
 * (recording an artifact, opening a room, creating your own task, minting an
 * introduction, issuing a grant) stay non-destructive. This layer adds only
 * the boundary hint and pins the other two to explicit booleans.
 */
export function directoryAnnotations(name: string, hints: TitledAnnotations): TitledAnnotations {
  return {
    ...hints,
    readOnlyHint: hints.readOnlyHint === true,
    destructiveHint: hints.destructiveHint === true,
    openWorldHint: OPEN_WORLD.has(name),
  };
}

