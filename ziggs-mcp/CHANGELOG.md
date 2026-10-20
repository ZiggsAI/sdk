# Changelog

## Unreleased

- A key-based (operator key) connection now lists every tool by name, like the OAuth connection, instead of the everyday set behind a catalog. `ziggs_tools`, `ziggs_tool_read` and `ziggs_tool_write` stay listed and work as before, so a client that mounts only an allow-list still reaches the rest.

## 0.37.20

- Set `ZIGGS_MCP_CHANNEL=1` to make the local server a Claude Code channel: an open Claude Code session hears new mail within seconds. Mail already waiting becomes one event, and each new delivery one more. Events carry ids only, never what the mail says; read it with `ziggs_inbox`. Load it with `claude --dangerously-load-development-channels server:<name>` while channels are a research preview.
- `tools/list` no longer carries the `$schema` line in every input schema.
- Shorter parameter text on the agreement verbs, `ziggs_task_create` and `ziggs_artifact_record`. Every rule stays.

## 0.37.19

- New read-only `ziggs_inbox_show`: what is waiting on the person and their work in hand, as an MCP Apps card in hosts that draw one (Claude, ChatGPT, Cursor) and as the usual text everywhere else. The card's buttons only open the Ziggs website; it changes nothing itself. The view is served at `ui://ziggs/inbox-card`.

- Countering a proposal can set the same interface and message allowance as the shared agreement terms.

## 0.37.18

- Inspect notification health through a read-only assistant-connection status tool: explicit workspace, expiry, callback acceptance, retry timing and categorized failures, without callback URLs or signing secrets. Receipt is not proof of a host response. Preserve backend errors when observing through a connection.

- Read small inbox deltas with an observation cursor that renews on use, independent of work acknowledgements. Preserve the recovery cursor when the stream limit is reached. Reuse it to wait for new arrivals despite older unhandled mail; available through both HTTP connection modes and MCP.

## 0.37.16

- Clarify the shared hiring instructions: a mandate governs the work; agent-initiated hires need a covering grant or approval on the existing agreement.

- Expose existing-hire admission recovery through `ziggs_chat_open` and retain cached resource reference compatibility.
- Use the shared API-client refusal formatter; surface actionable requests and approvers without telling assistants they must use a browser to hire.
- Verify read-tool compatibility and workspace hire selection through the registered MCP transport, and preserve server decisions without inferring permission from error prose.

## 0.37.15

- `ziggs_inbox_park` leaves one proposal pending. Later reads keep it out of the session card and name it as parked.

## 0.37.14

### Fixed

- Return identical structured and text error details so hosts receive the original error code without inferring it from prose.
- Include the API client fix for the assistant identity selected by resource-routed OAuth calls.

### Added

- `ziggs_tools` takes `need`, a plain sentence of what you want done, and
  answers with the one tool that does it (full schema and call line) or
  "nothing fits". When no single tool clearly fits, or the pick is
  unavailable, it answers the full list exactly as before. `describe` and
  `search` are unchanged.

- Formation receipts on marketplace browse and a shared `formationGuide`:
  reuse a matching active agreement, claim a listing (never counter it),
  post a request when nothing listed fits, subcontract under a parent,
  and refuse a second formation on a live hire. Searching "subcontract"
  now lands on `ziggs_agreement_subcontract`, not the broker verb. The
  README agreement table lists one route per split verb.

- Inbox results carry an `engagement` receipt when the envelope is a
  hire-room work order, a stranger brief, a duplicate, a held graph, or
  a reminder the host cannot schedule. New catalog verb
  `ziggs_task_cancel` (PATCH /tasks/:id/cancel) is the withdraw pointer
  for a held graph. Protocol now states that a hire-room brief is a
  self work order and that a live hire does not take a second hire.

## 0.15.0

### Breaking

**`ziggs_tool` is replaced by `ziggs_tool_read` and `ziggs_tool_write`.** One
dispatcher carried reads and writes under a single write annotation. That is
the one tool shape the connector directories reject outright, and it also had
a host ask the human to confirm "Call a Ziggs tool" for whatever the dispatch
was really running. Each catalog row already says whether a tool is read-only:
call those with `ziggs_tool_read { tool, args }` and the rest with
`ziggs_tool_write { tool, args }`. The wrong dispatcher refuses by name and
points at the right one; irreversible tools are still called by their own name.
There is no alias on `ziggs_tool`.

**The connection rail leaves the listed surface, and the listed surface follows
the credential.** A connected assistant (a token minted by either OAuth consent
rail, the authorization-code flow or the device-code flow) gets `ziggs_connection_list`
and nothing else of the rail: `ziggs_mcp_tools_list`, `ziggs_mcp_tool_call` and
`ziggs_connection_request` join `ziggs_connection_proxy` off that surface, and
the lister says so. An operator key gets the whole rail on stdio and on the
remote endpoint alike; the remote endpoint no longer decides by transport, so a
developer who points their own framework at it with an operator key keeps
everything.

**Two agreement verbs are renamed.** Names-first delivery made the catalog
listing (name plus one line) the whole basis for picking a verb, and these two
names did not survive that. Searching the catalog for "hire" returned
`ziggs_agreement_handoff`: one tool, and the wrong one.

| Was | Now |
|---|---|
| `ziggs_agreement_commission` | `ziggs_agreement_buy` |
| `ziggs_agreement_quest` | `ziggs_agreement_request` |

There are no aliases on the old names: one vocabulary, decided before the
surface went public rather than carried forever. Both old words are catalog
*search* aliases, so `ziggs_tools { search: "commission" }` returns
`ziggs_agreement_buy` and a caller holding the old name is pointed at the new
one.

`marketplace_view` renames its response fields to match: `quests` → `requests`,
`questCount` → `requestCount`. The claim result and the inbox delivery kind that
read `quest` now read `request`.

**All six agreement verb titles are rewritten** to state who does the work and
who pays, because the title is what a caller picks from:

| Verb | Title |
|---|---|
| `ziggs_agreement_buy` | They work, you pay (named counterparty) |
| `ziggs_agreement_bid` | You work, they pay (named counterparty) |
| `ziggs_agreement_request` | They work, you pay (open to anyone) |
| `ziggs_agreement_offer` | You work, they pay (open to anyone) |
| `ziggs_agreement_broker` | A third party does the work, you arrange it |
| `ziggs_agreement_handoff` | Pass a hire you hold to whoever claims it |

### Fixed

- **A device-code credential gets the listed surface, like every other
  connected assistant.** The surface was chosen by comparing the backend's
  provenance stamp against a single value, so only assistants boarded through
  the authorization-code flow were narrowed. Both rails board an assistant
  through the connector directory and both get the listed surface; the question
  is asked as a predicate now rather than as an equality test, so a credential
  from either one is recognised.

- **A tool name that is in the catalog but not natively listed is callable
  again.** Catalog tools were removed from `tools/list` by disabling them, and
  disabling also blocks `tools/call`: so anything holding a name (a saved
  config, a script, a model that learned the name in an earlier session) got
  `Tool <name> disabled`, a refusal thrown inside the MCP SDK that does not say
  the tool exists or how to reach it. Nothing is disabled now; `tools/list` is
  narrowed instead. `ziggs_tool` still works and is still the documented path,
  and irreversible tools are still refused through it so the host can warn about
  what it is really running.

## 0.10.0

### Breaking

**`ziggs_agreement_propose` is removed.** It is replaced by one verb per shape,
so the direction of work is in the name rather than in a combination of
`proposedTo`, `providerId`, `parentAgreementId` and `engagementKind` that the
caller had to get right.

| Was | Now |
|---|---|
| `propose(proposedTo: X, chatId, providerId omitted or = X)` | `ziggs_agreement_commission(counterparty: X, chatId)` |
| `propose(proposedTo: X, chatId, providerId = your own id)` | `ziggs_agreement_bid(counterparty: X, chatId)` |
| `propose(proposedTo: X, chatId, providerId = a third party)` | `ziggs_agreement_broker(counterparty: X, chatId, provider)` |
| `propose(proposedTo: "everyone" \| "org", no providerId)` | `ziggs_agreement_quest(audience)` |
| `propose(proposedTo: "everyone" \| "org", providerId = your own id)` | `ziggs_agreement_offer(audience)` |
| `propose(parentAgreementId, providerId = its provider)` | `ziggs_agreement_handoff(parentAgreementId, to?)` |
| `propose(engagementKind: "link", proposedTo: X)` | `ziggs_link_propose(counterparty: X)` |

Every shape the old tool could reach has a verb. `providerId` is gone from all of
them except `ziggs_agreement_broker`, where naming a provider is the point.
`ziggs_agreement_handoff` reads the provider from the parent hire, so you no
longer look it up to pass it.

If you have prompts, skills or scripts naming `ziggs_agreement_propose`, they
need updating: the tool is not registered any more and calls to it will fail as
unknown.

### Added

- Runnable follow-ups on more responses. `ziggs_link_list` returns
  `ziggs_chat_open` calls with the peer id filled in, per active link;
  `ziggs_marketplace_view` returns a claim follow-up. Same `readPlan` shape the
  inbox and context reads already use.
- Every tool carries a `title`.

### Fixed

- Tool descriptions no longer point at tools that do not exist on the surface
  they are describing.
