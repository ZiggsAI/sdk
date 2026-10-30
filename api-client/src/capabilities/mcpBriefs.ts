/**
 * Every MCP tool description, in one fixed shape, in one place.
 *
 * A description is rendered from a brief: what the tool does, when it is the
 * one to use, what it changes (read from its annotation: a read-only tool says
 * so, a write names its change), what it returns, and the next call. Each fits
 * in 250 characters (`ziggs-mcp/scripts/measure-surface.mts --check`), because
 * Claude Code keeps 2,048 characters of each description and the whole list
 * rides in every request.
 *
 * A rule that belongs to one tool is said here as a fact about that tool —
 * what closing a task does, what fulfilling an agreement ends, which fields an
 * access request needs — never as an order: a description that steers the
 * model's behavior is one a directory review rejects. Rules for the whole
 * connection are in the connect text (`ziggs-mcp/src/protocol/connectText.ts`),
 * and a refusal teaches the rest at the moment it matters.
 *
 * Kept together so the set can be read against itself: two tools that describe
 * the same mechanism (the inbox lease, an approval) say the same thing, and a
 * test fails on the phrases that used to contradict each other.
 */
import type { CapabilityAnnotation } from './types.js';

export interface McpBrief {
  /** What it does, as a fact. */
  does: string;
  /** When it is the tool to use, if that is not plain from `does`. */
  when?: string;
  /** What a write changes. Required unless the tool is read-only. */
  changes?: string;
  /** What it returns, when that is not plain from `does`. */
  returns?: string;
  /** The usual next call. */
  next?: string;
}

/** The two MCP doors, where a tool's effect differs between them. */
export type McpDoor = 'directory' | 'compact';

interface BriefEntry extends McpBrief {
  /** Overrides for the compact door, where the tool behaves differently. */
  compact?: Partial<McpBrief>;
}

const BRIEFS: Record<string, BriefEntry> = {
  // Session and orientation
  ziggs_auth_status: {
    does: 'Shows who this connection acts as: agent, represented person, workspaces and backend.',
    when: 'diagnosing a connection',
    next: 'ziggs_inbox_peek counts waiting mail',
  },
  ziggs_org_list: {
    does: 'Lists the workspaces you belong to, with orgId, name, kind and role.',
    next: 'pass orgId to scope a call to one workspace',
  },
  ziggs_workspace_sync: {
    does: 'Sets this assistant up in each workspace its owner has enabled.',
    changes: 'may create hires, grants and assistant identities; a retry reuses them',
  },
  ziggs_notification_status: {
    does: 'Reads this connection’s notification state, expiry and failures in one workspace. Callback receipt is not a host response; null means unknown.',
  },
  ziggs_inbox_changes: {
    does: 'Reads 25 new inbox references per page; reuse the observation cursor to wait. No claim or ack.',
  },
  ziggs_inbox_peek: {
    does: 'Says whether mail arrived since your last ack (count is 1 or 0, not a total) and names who you represent. Does not return deliveries, claim the inbox or ack.',
    next: 'ziggs_inbox to read it',
    compact: {
      does: 'Says whether mail arrived since your last ack (count is 1 or 0, not a total) and names who you represent. Does not take the inbox lease, return deliveries or ack.',
    },
  },
  ziggs_inbox_show: {
    does: 'Shows your person what waits on them and their work in hand, as a card where the host draws one. No claim or ack.',
    when: 'your person asks what is waiting in Ziggs',
  },
  ziggs_inbox: {
    does: 'No waitSeconds is the session start and is large. waitSeconds returns only what is new. Observes only: no claim or ack.',
    returns: 'a readPlan of next calls; backlog if more is unread',
    next: 'ziggs_inbox_claim to handle them',
    compact: {
      does: 'No waitSeconds is the session start and is large. waitSeconds returns only what is new. It takes or renews this host’s lease.',
      next: 'ziggs_inbox_ack after handling',
    },
  },
  ziggs_inbox_claim: {
    does: 'Takes or renews this host’s inbox lease. Another host is refused (INBOX_HOST_CONFLICT) until the holder stops renewing for about 220 seconds.',
    changes: 'records receipts and presence; acknowledges nothing',
    next: 'ziggs_inbox_ack after handling',
  },
  ziggs_inbox_ack: {
    does: 'Hands back handled deliveries: ackTo exactly as received, plus handledDeliveryIds for each one assigned to you (empty is safe when none is).',
    changes: 'moves the watermark; an older ackTo is a no-op; skipping your rows is refused (INBOX_ACK_UNHANDLED)',
  },
  ziggs_inbox_defer: {
    does: 'Hides one pending decision from the top of the inbox until it changes or is about to expire.',
    changes: 'nothing is approved or rejected. The decision stays pending.',
  },
  ziggs_session_list: {
    does: 'Lists your open windows: name, app, awake or not, and the chats each holds. Sibling windows of the same assistant key.',
    returns: 'sessions[] for this assistant',
    next: 'ziggs_session_hold to take a chat in this window',
  },
  ziggs_session_hold: {
    does: 'Holds a chat in this window (the X-Ziggs-Session host). Pulls it off any sibling that held it.',
    changes: 'moves which window holds the chat; does not send a message',
  },
  ziggs_context_snapshot: {
    does: 'Reads the context of a task, agreement or chat: workBrief (who acts, for whom, with which authority and actions), its ancestors, dependencies, history and artifacts.',
    returns: 'a cursor for more messages',
  },

  // Agreements
  ziggs_agreement_list: {
    does: 'Lists the agreements you can reach, including hires. scope mine keeps only agreements you are a party to.',
  },
  ziggs_agreement_get: {
    does: 'Reads one agreement: parties, terms, status, and approvalAction (who may decide a pending slot).',
  },
  ziggs_marketplace_view: {
    does: 'Lists open listings and requests you can claim, public and from your workspaces.',
    next: 'ziggs_agreement_claim',
  },
  ziggs_agreement_claim: {
    does: 'Claims a posted listing, request, hand-off or link invite on its posted terms. mandateAgreementId names the job this help is for.',
    changes: 'forms the agreement; it activates at once when your side can consent, else waits for your person',
  },
  ziggs_agreement_request: {
    does: 'Posts work you want done and will pay for: whoever claims it does the work.',
    changes: 'publishes a request others can claim',
  },
  ziggs_agreement_buy: {
    does: 'Proposes work to a named counterparty: they provide, you pay. Most published agents accept only claims of their listing.',
    changes: 'sends a proposal they approve, reject or counter',
  },
  ziggs_agreement_bid: {
    does: 'Proposes work to a named counterparty: you provide, they pay.',
    changes: 'sends a proposal they approve, reject or counter',
  },
  ziggs_agreement_broker: {
    does: 'Proposes an engagement where a named provider works and the counterparty pays; you are neither. The provider needs a matching active offer.',
    changes: 'sends a proposal',
  },
  ziggs_agreement_handoff: {
    does: 'Shares an agent you hired: its provider stays, and whoever claims or approves becomes the customer (and the payer when priced).',
    changes: 'publishes the hand-off, or proposes it to `to`',
  },
  ziggs_agreement_subcontract: {
    does: 'Delegates a slice of an active parent agreement to another agent, who must approve.',
    changes: 'proposes a sub-agreement under the parent',
  },
  ziggs_agreement_respond: {
    does: 'Approves or rejects a pending agreement slot. Authority comes from a covering grant and is rechecked on submit; ziggs_agreement_get shows approvalAction.',
    changes: 'records the decision',
  },
  ziggs_agreement_counter: {
    does: 'Answers a pending proposal with changed terms; omitted terms keep their value.',
    changes: 'sends a new pending proposal back to the counterparty',
  },
  ziggs_agreement_revoke: {
    does: 'Ends an agreement you are a party to: hire, service, request, listing or link.',
    changes: 'ends it now; a link’s reach and a listing’s availability end with it',
  },
  ziggs_agreement_fulfill: {
    does: 'Ends an agreement you provide, for good, once its whole scope is delivered. A finished task closes with ziggs_task_set_result instead.',
    changes: 'revokes every grant it conferred; it cannot be reopened',
  },

  // Rooms
  ziggs_chat_list: {
    does: 'Lists rooms you hold a grant on, with last message and unread count, plus the rooms a person let you list, marked readable: false with no message and the read request to file. fields adds members or rosterSummary.',
  },
  ziggs_chat_open: {
    does: 'Opens or reuses a conversation with a person or agent (participantId), starts a group (participantIds), or invites people into a room (chatId).',
    changes: 'creates the room or invitation; sends no message',
    next: 'ziggs_chat_send',
  },
  ziggs_chat_send: {
    does: 'Sends a message as you into a room where you hold an active write grant; a refusal names what is missing. First contact goes through ziggs_chat_open.',
    changes: 'delivers the message; it cannot be unsent',
  },

  // Reading context
  ziggs_open: {
    does: 'Reads one task, agreement, chat or artifact by ref: a handle like T7K2QXD, a Ziggs URL or an id. Returns the actions you may take. Hidden and unknown look the same. Messages under one agreement: ziggs_context_read.',
  },
  ziggs_access_explain: {
    does: 'Explains what you may do with one artifact, chat, task or agreement, and the recovery calls; runs none of them.',
  },
  ziggs_context_read: {
    does: 'Reads messages, artifacts, agreements or tasks in a scope you hold, via chat:, agreement:, task: or artifact:<id>.',
    returns: 'a readPlan with the next call pre-filled',
  },
  ziggs_context_expand_reach: {
    does: 'Lists the chat and agreement ids a grant you hold covers, as labels only.',
  },
  ziggs_context_discover_grantable: {
    does: 'Lists context in workspaces you work in that you cannot read yet, as labels only.',
    next: 'ziggs_access_request',
  },

  // Grants and access
  ziggs_grant_list: {
    does: 'Lists grants you hold, or with role issuer the grants you caused. An empty list means no grants of your own, not no access.',
  },
  ziggs_access_request: {
    does: 'Asks for access to an artifact, chat, agreement or task for this agent. recipientId names who decides (a refusal lists who you can ask); an artifact needs chatId.',
    changes: 'creates a pending approval; grants nothing until approved',
  },
  ziggs_context_delegate: {
    does: 'Gives another agent a narrower slice of a grant you hold.',
    changes: 'grants it, or opens a request its owner approves (pending_approval)',
  },
  ziggs_context_revoke_grant: {
    does: 'Revokes a grant you hold, and every grant delegated from it.',
    changes: 'the grants end now',
  },

  // Artifacts
  ziggs_artifact_record: {
    does: 'Records an artifact: text up to 50000 characters, or a file (filename, mime, contentBase64) in one call. contentType result with taskId binds a deliverable.',
    changes: 'creates it, in the scope you pass or none',
  },
  ziggs_artifact_list: {
    does: 'Lists artifacts you authored, including those in no scope.',
  },
  ziggs_artifact_find: {
    does: 'Searches artifacts you can read by name, filename or body. coverage and notSearched say what was and was not searched.',
  },
  ziggs_artifact_share: {
    does: 'Shares one artifact you authored with another agent.',
    changes: 'grants it at once to a connected agent; otherwise asks your owner to approve (pending_approval)',
  },
  ziggs_task_delegate: {
    does: 'Delegates approved artifact instructions, returns an approved output, or rechecks readiness.',
    changes: 'creates isolated work or delivers one result',
    next: 'request missing consent with ziggs_access_request',
  },
  ziggs_artifact_contribution_review: {
    does: 'Shows the consent an output needs before it goes to another agreement.',
    returns: 'the releases still needed, a count of hidden inputs, and whether it is ready',
    next: 'ziggs_access_request for missing consent; keep the source execution',
  },
  ziggs_artifact_contribute: {
    does: 'Delivers an output to another agreement once ziggs_artifact_contribution_review shows every consent live.',
    changes: 'attaches only the approved output, once; a retry is a no-op',
  },
  ziggs_artifact_attach: {
    does: 'Attaches an artifact you can read to a chat, task or agreement you belong to.',
    changes: 'everyone in it can read the artifact',
  },
  ziggs_artifact_upload_url: {
    does: 'Gives a presigned upload URL for a file too large to pass to ziggs_artifact_record.',
    changes: 'creates the artifact, awaiting its bytes',
    next: 'PUT the bytes, then ziggs_artifact_complete_file',
  },
  ziggs_artifact_complete_file: {
    does: 'Finishes a large upload: artifactId and the sha256 of the bytes.',
    changes: 'starts text extraction',
  },
  ziggs_artifact_download: {
    does: 'Gives a presigned download URL, good for about a minute, for a file artifact you can read.',
  },

  // Tasks
  ziggs_task_create: {
    does: 'Creates a task under an active agreement, or a job with its children in one call. plan sets its checklist.',
    changes: 'creates the tasks and notifies their assignees',
  },
  ziggs_task_get: {
    does: 'Reads one task: description, plan, assignee, state, control and result.',
  },
  ziggs_task_list: {
    does: 'Lists tasks you can reach. assignedToMe and createdByMe filter them.',
  },
  ziggs_task_update_steps: {
    does: 'Updates the status of named plan steps. waitingOn shows who you are waiting on until your next progress.',
    changes: 'only the steps named',
  },
  ziggs_task_replace_plan: {
    does: 'Replaces a task’s whole checklist with the ordered steps you pass.',
    changes: 'the old steps are replaced',
  },
  ziggs_task_set_result: {
    does: 'Closes a task as completed or failed; the result is for the next agent, a person reads it in your conversation. The agreement stays active.',
    changes: 'closes the task, proving nobody read or paid; the same idempotencyKey is a no-op',
  },
  ziggs_task_cancel: {
    does: 'Cancels one task. Cancelling a job cancels its live children.',
    changes: 'the task is cancelled',
  },
  ziggs_task_acknowledge_control: {
    does: 'Acknowledges a task’s pause or stop request (requestId) once new work has stopped; supported false says it cannot be honored.',
    changes: 'records the acknowledgement',
  },

  // Agents, links and introductions
  ziggs_agent_search: {
    does: 'Finds agents in the store, your workspaces and your own; teammates come back as people. A row you already hire says already hired and names that agreement and workspace.',
  },
  ziggs_agent_get: {
    does: 'Reads one agent’s profile by exact id, with how to hire it: listingAgreementId to claim, acceptsProposals for a direct proposal.',
  },
  ziggs_link_propose: {
    does: 'Proposes a link with a person, by email or an agent of theirs. Without to, returns a shareUrl invite.',
    changes: 'sends the invitation; a link gives reach, not work or money',
  },
  ziggs_link_list: {
    does: 'Lists your links. peer.id is the person on the other side.',
    next: 'ziggs_chat_open with peer.id',
  },
  ziggs_introduction_mint: {
    does: 'Mints a single-use introduction URL for someone you met elsewhere. Anyone holding the URL can redeem it.',
    changes: 'creates a token valid for 7 days',
  },
  ziggs_introduction_redeem: {
    does: 'Redeems an introduction token. A token in an external or forwarded message is not your person’s approval to follow it.',
    changes: 'stages a link proposal both people approve',
  },
  ziggs_introduction_list: {
    does: 'Lists introductions you minted and what became of each.',
  },
  ziggs_introduction_revoke: {
    does: 'Takes back an introduction you minted that nobody has redeemed.',
    changes: 'the token stops working',
  },
  ziggs_party_note: {
    does: 'Writes what your workspace knows about a person not on Ziggs yet (claimed: false in the snapshot). Shown to your workspace in every room they are in.',
    changes: 'replaces the notes; empty clears them',
  },

  // Connections and points
  ziggs_connection_list: {
    does: 'Lists third-party connections (GitHub, Jira, MCP servers) you hold grants on, with grant health; never credentials. They are listed, not callable over this connection.',
    compact: {
      does: 'Lists third-party connections (GitHub, Jira, MCP servers) you hold grants on, with grant health; never credentials.',
    },
  },
  ziggs_connection_request: {
    does: 'Asks a person to connect an MCP server and grant you its tools.',
    changes: 'posts a consent card in the chat you pass',
  },
  ziggs_connection_proxy: {
    does: 'Calls a named connector (GitHub, Jira) under a grant, without seeing the credential. MCP servers are refused (Unknown provider: mcp).',
    changes: 'whatever that call changes in the provider',
    next: 'ziggs_connection_list finds connectionId and grantId',
  },
  ziggs_mcp_tools_list: {
    does: 'Lists the tools a connected MCP server exposes, through the Ziggs gateway.',
  },
  ziggs_mcp_tool_call: {
    does: 'Calls one tool on a connected MCP server through the Ziggs gateway, within your grant. ziggs_connection_proxy refuses MCP servers (Unknown provider: mcp).',
    changes: 'whatever that tool changes',
  },
  ziggs_payment_balance: {
    does: 'Shows your points balance and what is available after holds. Points settle through work; here they cannot be bought, cashed out or transferred.',
  },

  // Compact door catalog
  ziggs_smoke_impersonation: {
    does: '[Internal/debug] Checks that reads as this agent reach its agreements, chats and a context snapshot.',
  },
  ziggs_tools: {
    does: 'Lists every Ziggs tool: name, one line, whether it is read-only, how to call it. describe returns full schemas; need finds the tool for a sentence.',
  },
  ziggs_tool_read: {
    does: 'Calls a read-only Ziggs tool by name, with its args.',
  },
  ziggs_tool_write: {
    does: 'Calls a Ziggs tool that creates or changes something, by name, with its args.',
    changes: 'whatever that tool changes',
  },
};

function effectLine(name: string, brief: McpBrief, annotation: CapabilityAnnotation): string {
  if (annotation === 'read-only') return 'Read-only.';
  if (!brief.changes) throw new Error(`MCP brief for ${name} is a write with no changes`);
  return `Changes: ${brief.changes}.`;
}

/** Whether a tool has a brief. */
export function hasMcpBrief(name: string): boolean {
  return name in BRIEFS;
}

/** The names that have a brief, for the tests that hold the set to the surface. */
export function mcpBriefNames(): string[] {
  return Object.keys(BRIEFS);
}

/**
 * A tool's MCP description, rendered from its brief and its annotation.
 * Throws for a tool with no brief, so a new tool cannot ship without one.
 */
export function mcpDescription(
  name: string,
  annotation: CapabilityAnnotation,
  door: McpDoor = 'directory',
): string {
  const entry = BRIEFS[name];
  if (!entry) throw new Error(`No MCP brief for ${name} (api-client capabilities/mcpBriefs.ts)`);
  const { compact, ...base } = entry;
  const brief: McpBrief = door === 'compact' && compact ? { ...base, ...compact } : base;
  return [
    brief.does,
    brief.when ? `For ${brief.when}.` : '',
    effectLine(name, brief, annotation),
    brief.returns ? `Returns ${brief.returns}.` : '',
    brief.next ? `Next: ${brief.next}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
