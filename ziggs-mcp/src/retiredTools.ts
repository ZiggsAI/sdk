import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError } from './toolError.js';

/**
 * Tools we removed, and what replaced them.
 *
 * An assistant that loaded its Ziggs tool list before a removal still holds the
 * old name. Without this table the call dies on the MCP SDK's bare "not found",
 * and the assistant tells its person Ziggs is broken. Every way of reaching a
 * tool by name reads this table: a direct call, both dispatchers, and describe.
 *
 * Retired names are never registered, so they never appear in `tools/list`.
 * Removing a tool adds its row in the same change; retiredTools.test.ts fails
 * when a name leaves the registered set without one.
 */
export interface Replacement {
  tool: string;
  /** When to use this one, for a job that was split across several tools. */
  when?: string;
}

export interface RetiredTool {
  /** The tools that do the job now. Empty when nothing replaces it. */
  use: Replacement[];
  /** What changed, in one line. */
  note?: string;
}

const same = (tool: string, note?: string): RetiredTool => ({ use: [{ tool }], ...(note ? { note } : {}) });
const gone = (note: string): RetiredTool => ({ use: [], note });
const split = (...use: Array<[string, string]>): RetiredTool => ({
  use: use.map(([tool, when]) => ({ tool, when })),
});

/** One tool does the same job under a new name. */
const RENAMED: ReadonlyArray<readonly [string, string, string?]> = [
  ['ziggs_agreement_commission', 'ziggs_agreement_buy'],
  ['ziggs_agreement_quest', 'ziggs_agreement_request'],
  ['ziggs_cancel_task', 'ziggs_task_cancel'],
  ['ziggs_chat_open', 'ziggs_message_send', 'There is no room to open; send the message.'],
  ['ziggs_chat_send', 'ziggs_message_send'],
  ['ziggs_claim_link_invite', 'ziggs_agreement_claim'],
  ['ziggs_claim_offer', 'ziggs_agreement_claim'],
  ['ziggs_connection_status', 'ziggs_auth_status'],
  ['ziggs_context_request', 'ziggs_access_request'],
  ['ziggs_conversation_send', 'ziggs_message_send'],
  ['ziggs_counter_agreement', 'ziggs_agreement_counter'],
  ['ziggs_create_link_invite', 'ziggs_link_propose'],
  ['ziggs_create_party_connection_invite', 'ziggs_link_propose'],
  ['ziggs_create_task', 'ziggs_task_create'],
  ['ziggs_delegate_grant', 'ziggs_context_delegate'],
  ['ziggs_discover_grantable', 'ziggs_context_discover_grantable'],
  ['ziggs_expand_context', 'ziggs_context_expand_reach'],
  ['ziggs_fulfill_agreement', 'ziggs_agreement_fulfill'],
  ['ziggs_get_active_tasks', 'ziggs_task_list'],
  ['ziggs_get_agent', 'ziggs_agent_get'],
  ['ziggs_get_agreement', 'ziggs_agreement_get'],
  ['ziggs_get_scope', 'ziggs_context_snapshot'],
  ['ziggs_get_task', 'ziggs_task_get'],
  ['ziggs_inbox_park', 'ziggs_inbox_defer'],
  ['ziggs_issue_grant', 'ziggs_context_delegate'],
  ['ziggs_link_create_invite', 'ziggs_link_propose'],
  ['ziggs_list_connections', 'ziggs_connection_list'],
  ['ziggs_list_grants', 'ziggs_grant_list'],
  ['ziggs_list_links', 'ziggs_link_list'],
  ['ziggs_list_messages', 'ziggs_message_list'],
  ['ziggs_list_my_agreements', 'ziggs_agreement_list'],
  ['ziggs_list_my_connections', 'ziggs_connection_list'],
  ['ziggs_list_my_grants', 'ziggs_grant_list'],
  ['ziggs_list_my_orgs', 'ziggs_org_list'],
  ['ziggs_list_party_connections', 'ziggs_link_list'],
  ['ziggs_list_tasks', 'ziggs_task_list'],
  ['ziggs_open_conversation', 'ziggs_message_send'],
  ['ziggs_pending_decisions', 'ziggs_inbox', 'A fresh inbox read carries the decisions.'],
  ['ziggs_publish_quest', 'ziggs_agreement_request'],
  ['ziggs_read_context', 'ziggs_context_read'],
  ['ziggs_record_artifact', 'ziggs_artifact_record'],
  ['ziggs_redeem_party_connection_invite', 'ziggs_agreement_claim'],
  ['ziggs_request_connection_status', 'ziggs_connection_list'],
  ['ziggs_request_link', 'ziggs_link_propose'],
  ['ziggs_request_party_connection', 'ziggs_link_propose'],
  ['ziggs_respond_to_agreement', 'ziggs_agreement_respond'],
  ['ziggs_respond_to_party_connection', 'ziggs_agreement_respond'],
  ['ziggs_revoke_agreement', 'ziggs_agreement_revoke'],
  ['ziggs_revoke_grant', 'ziggs_context_revoke_grant'],
  ['ziggs_revoke_link', 'ziggs_agreement_revoke'],
  ['ziggs_revoke_party_connection', 'ziggs_agreement_revoke'],
  ['ziggs_search_agents', 'ziggs_agent_search'],
  ['ziggs_send_message', 'ziggs_message_send'],
  ['ziggs_set_task_result', 'ziggs_task_set_result'],
];

const PROPOSE = split(
  ['ziggs_agreement_buy', 'you pay a named party'],
  ['ziggs_agreement_bid', 'you offer your work to a named party'],
  ['ziggs_agreement_request', 'an open call for anyone'],
  ['ziggs_agreement_broker', 'you arrange a deal between others'],
  ['ziggs_agreement_handoff', 'you pass your work on to someone else'],
  ['ziggs_link_propose', 'you want a link'],
);

const LISTING = gone("Posting and pausing a listing is the person's job in the web app. Claim someone's listing with ziggs_agreement_claim; browse with ziggs_marketplace_view.");
const ROOMS = gone('Rooms are gone. Read with ziggs_inbox or ziggs_message_list.');
const ANSWERS = gone('Messages are fyi or request now; there are no answer requests. Read replies with ziggs_message_replies.');
const PAYMENT = gone('Agents do not move points. ziggs_payment_balance is the only payment tool.');

const OTHER: ReadonlyArray<readonly [string, RetiredTool]> = [
  ['ziggs_agreement_propose', PROPOSE],
  ['ziggs_propose_agreement', PROPOSE],
  ['ziggs_context_issue_grant', split(
    ['ziggs_context_delegate', 'a slice of a grant you hold'],
    ['ziggs_bucket_insert', 'one file: add it to a bucket'],
  )],
  ['ziggs_conversation_read', split(
    ['ziggs_message_read', 'one message'],
    ['ziggs_message_list', 'the whole thread, with conversationOf'],
  )],
  ['ziggs_discover_context', split(
    ['ziggs_grant_list', 'what you hold'],
    ['ziggs_context_discover_grantable', 'what exists that you cannot read yet'],
  )],
  ['ziggs_list_artifacts', split(
    ['ziggs_artifact_list', 'what you wrote'],
    ['ziggs_context_read', 'what is in a scope, with type artifacts'],
  )],
  ['ziggs_post_task_plan_step', split(
    ['ziggs_task_replace_plan', 'the whole plan'],
    ['ziggs_task_update_steps', 'progress only'],
  )],
  ['ziggs_tool', split(
    ['ziggs_tool_read', 'reads'],
    ['ziggs_tool_write', 'writes'],
  )],
  ['ziggs_bucket_move', {
    use: [
      { tool: 'ziggs_bucket_insert', when: 'copy an item into another bucket' },
      { tool: 'ziggs_bucket_duplicate', when: 'copy items into a new bucket' },
    ],
    note: 'Items are copied between buckets, never moved. Take the original out with ziggs_bucket_remove if it should leave.',
  }],
  ['ziggs_agreement_offer', LISTING],
  ['ziggs_publish_offer', LISTING],
  ['ziggs_listing_pause', LISTING],
  ['ziggs_listing_resume', LISTING],
  ['ziggs_chat_list', ROOMS],
  ['ziggs_list_chats', ROOMS],
  ['ziggs_message_answers', ANSWERS],
  ['ziggs_message_answer_cancel', ANSWERS],
  ['ziggs_payment_attenuate_grant', PAYMENT],
  ['ziggs_payment_hold', PAYMENT],
  ['ziggs_payment_issue_grant', PAYMENT],
  ['ziggs_payment_release', PAYMENT],
  ['ziggs_payment_resolve_wallet', PAYMENT],
  ['ziggs_payment_revoke_grant', PAYMENT],
  ['ziggs_payment_transfer', PAYMENT],
  ['ziggs_payment_wait_for_approval', PAYMENT],
  ['ziggs_context_record_message', gone('Send messages with ziggs_message_send.')],
  ['ziggs_context_record_thought', gone('Nothing replaces it. Save finished work with ziggs_artifact_record.')],
  ['ziggs_get_subtasks', gone('Nothing replaces it. Nearest: ziggs_task_list, ziggs_task_get.')],
  ['ziggs_mark_task_processing', gone('Nothing replaces it. Nearest: ziggs_inbox_claim.')],
  ['ziggs_update_task_state', gone('Nothing replaces it. Finish with ziggs_task_set_result or stop with ziggs_task_cancel.')],
  ['ziggs_switch_org', gone('The workspace is chosen when Ziggs is connected. See them with ziggs_org_list.')],
  ['ziggs_request_connection', gone('Requesting a connection is not a Ziggs MCP tool any more. See yours with ziggs_connection_list.')],
  ['ziggs_artifact_reextract', gone('Not an agent tool any more.')],
  ['ziggs_provision_relay_workers', gone('Not an agent tool any more. Engage agents with the agreement tools and ziggs_task_create.')],
];

export const RETIRED_TOOLS: Readonly<Record<string, RetiredTool>> = Object.freeze({
  ...Object.fromEntries(RENAMED.map(([name, tool, note]) => [name, same(tool, note)])),
  ...Object.fromEntries(OTHER),
});

export function retiredTool(name: string): RetiredTool | undefined {
  return Object.hasOwn(RETIRED_TOOLS, name) ? RETIRED_TOOLS[name] : undefined;
}

/** The replacement tools for a search word such as `commission` or `ziggs_quest`. */
export function retiredReplacementsFor(needle: string): string[] {
  const hits = new Set<string>();
  for (const candidate of [needle, `ziggs_${needle}`, `ziggs_agreement_${needle}`]) {
    for (const entry of retiredTool(candidate)?.use ?? []) hits.add(entry.tool);
  }
  return [...hits];
}

export type Door = 'compact' | 'directory';

/** How a person refreshes Ziggs in the app the connection came from. */
export function refreshSteps(clientName: string | undefined): string {
  const name = (clientName ?? '').toLowerCase();
  if (name.includes('chatgpt') || name.includes('openai'))
    return 'In ChatGPT: Settings → Apps & Connectors → Ziggs → Refresh. ChatGPT never refreshes by itself. On Business and Enterprise plans a workspace admin refreshes or republishes it.';
  if (name.includes('cursor'))
    return 'In Cursor: turn Ziggs off and on in MCP settings, or restart Cursor. Cursor ignores the list-changed signal.';
  if (name.includes('claude-code') || name.includes('claude code'))
    return 'In Claude Code: run /mcp and reconnect Ziggs, or start a new session.';
  if (name.includes('claude'))
    return 'In Claude: Settings → Connectors → Ziggs → ⋯ → refresh the tool list, or remove Ziggs and add it again.';
  return "Reconnect Ziggs in the app's connector settings, or start a new conversation.";
}

/**
 * The tool result for a call to a removed tool: an ordinary error the assistant
 * can act on. The compact door can call the replacement through its dispatcher
 * at once; the directory door cannot call a tool that is not in its list, so
 * its message asks the person to refresh, once.
 */
export function retiredToolResult(
  name: string,
  retired: RetiredTool,
  ctx: { door: Door; clientName?: string },
) {
  const lines = [`${name} was removed from Ziggs, so your list of Ziggs tools is out of date.`];
  if (retired.note) lines.push(retired.note);
  if (retired.use.length === 1) {
    lines.push(`Use ${retired.use[0].tool} for this now.`);
  } else if (retired.use.length > 1) {
    lines.push(
      `This job is now done by more than one tool: ${retired.use.map((u) => `${u.tool} (${u.when})`).join('; ')}.`,
    );
  }
  if (ctx.door === 'compact') {
    lines.push(
      retired.use.length
        ? 'Call the replacement now through ziggs_tool_read (read-only tools) or ziggs_tool_write (tools that change something), and also give your person these steps so your tool list is current:'
        : 'Give your person these steps so your tool list is current:',
    );
  } else {
    lines.push(
      'You cannot call a tool that is not in your list. Ask your person, once per conversation, to refresh Ziggs:',
    );
  }
  lines.push(refreshSteps(ctx.clientName));
  const result = toolError(lines.join(' '));
  const error = {
    ...(result.structuredContent.error as unknown as Record<string, unknown>),
    code: 'TOOL_RETIRED',
    message: lines.join(' '),
    retired: { name, replacements: retired.use },
  };
  return {
    structuredContent: { error },
    content: [{ type: 'text' as const, text: JSON.stringify({ error }, null, 2) }],
    isError: true,
  };
}

/** Which door this server was built for, and the client's name once it has connected. */
export function doorContext(server: McpServer, door: Door) {
  return { door, clientName: server.server.getClientVersion()?.name };
}
