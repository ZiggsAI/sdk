# Changelog

## Unreleased

- A room lane can name the agreement the wake works under: `laneUnderAgreement(chatId, agreementId)` builds it, and the lane header sends it as `X-Ziggs-Agreement` beside `X-Ziggs-Lane`. The backend takes it only for an agreement the agent has mail under in that room.

## 0.37.20

- Shorter parameter text on the agreement verbs and the artifact record capability. Every rule stays.

## 0.37.19

- Hosted-agent agreement tools take commercial terms from the same definition as the other agreement verbs, including the interface.
- Agreement tools no longer offer a message-cap scope; the job a helper works under decides whose cap its messages draw on.

## 0.37.18

- Inspect notification health through a read-only assistant-connection status tool: explicit workspace, expiry, callback acceptance, retry timing and categorized failures, without callback URLs or signing secrets. Receipt is not proof of a host response. Preserve backend errors when observing through a connection.

- Read small inbox deltas with an observation cursor that renews on use, independent of work acknowledgements. Preserve the recovery cursor when the stream limit is reached. Reuse it to wait for new arrivals despite older unhandled mail; available through both HTTP connection modes and MCP.

## 0.37.17

- Clarify the shared hiring instructions: a mandate governs the work; agent-initiated hires need a covering grant or approval on the existing agreement.

- Resume an existing hire into its room with `chat_open({chatId, agreementId})`, using the same backend admission operation as the room UI. Retries do not hire or charge again.
- Normalize current `ref` and cached typed resource identifiers in one client path for `open` and `access_explain`.
- Share structured refusal formatting across MCP and agent runtimes, preserving recovery calls, eligible approvers, choices, and wrapped API errors. Pending invitations identify their approvers and approval room.
- Preserve every server error code and empty approver list; stop guessing resource-access requests from the word "scope" in a 403 message. Human-only refusals direct the caller to the account owner.

## 0.37.16

- `messages` can ask for the newest page. A forward delta still needs a timestamp.

## 0.37.15

- A caller can leave one pending proposal unshouted. Later inbox reads name it as parked.

## 0.37.14

### Fixed

- Preserve the backend-selected assistant identity on resource-routed OAuth open, access explanation, and access request results. Older servers no longer produce a misleading empty identity.
- Allow callers to cancel an idle inbox long-poll without cancelling work already received.

### Added

- **A hire lands in the room it was made in.** `agreement_claim` takes
  `chatId` for a hire of a listing; when it activates, the agent joins that
  room with no invitation and no second approval. The answer carries
  `room.status`: `awaiting_approval`, `ready` (only once the agent is in), or
  `admission_failed` with the call that resumes admission without hiring or
  charging again. `chat_open` may name agents when creating a group; each is
  reported added or pending, and a pending agent waits for one person's yes.

- **Formation guide (AX-09).** `formationGuide` reuses a matching active
  agreement, claims a listing without countering it, posts a request when
  nothing listed fits, subcontracts under a parent, and refuses a second
  formation on a live hire. Marketplace browse returns that receipt.
  MCP publish copy names the split request/offer verbs; the SDK still
  publishes through `agreement_propose`.

- **Engagement guide (AX-07).** Inbox receipts now say whether a hire-room
  brief is a self work order (`task_create` under that agreement), a
  stranger brief that still needs a drafted agreement, a duplicate/echo
  (noop), a held graph (failed deps are not inputs; withdraw is
  `task_cancel` on the root), or waiting-on-person. A live-hire 409
  refuses a second hire; amend is not on this surface. Contact paths
  distinguish same-org / linked / unlinked people and listed agents.
  MCP reports that it cannot arm a wake. No worker_next, wake store, or
  blocked task state.

- **Access-request receipts (AX-06).** `artifact_share` and
  `context_delegate` keep a pending owner decision as `state: requested`
  with a recoverable `agreementId`. The same `Idempotency-Key` recovers
  that card; a locked find row explains access and does not advertise a
  root grant or a wider container.

- **Session orientation (AX-05).** Cold `session` now names the
  `representedPerson`, whether this host can schedule a wake
  (`continuation`), and who drives inbox ack (`inboxHandling`). New
  `ziggs_inbox_peek` / `GET /inbox/peek` counts waiting mail and
  returns that block without taking the mailbox. A full inbox read
  still acquires the host lease. Assistant and worker stay different
  identities: this surface reports that; it does not invent a shared
  handover.

- **`open` / `access_explain`.** Pass exactly one
  ordinary id (`artifactId` / `chatId` / `taskId` / `agreementId`). The
  server resolves the read path through existing access/context-read
  predicates (`accessOptionsFor`), no `grant_list`, grant id, or
  reconstructed `type`/`via`. Authorization is rechecked on every call.
  A refusal is `hidden` or `unreadable` (owner-decision only; this call
  never requests or approves). Reading does not imply reply, share,
  delegate, approve, or original-file download. Extraction pending/failed
  is not an empty document. Inbox `readPlan` now names `ziggs_open` with
  the ordinary id.
- **`nextCall`** now says whether a follow-up is
  `ready`, lists `missing` arguments, and attaches the published HTTP
  `method`/`path` for the same capability key. A `psn_` persona face is
  never a ready `participantId` / `to` / `receiverId`. Profile is not a
  field: assistant vs worker is not a transport. Each call also carries
  `outcome` (`ok` | `pending` | `partial` | `unavailable`), material
  `effects` when the verb has any, and `workContext` from the env (acting
  agent + lane, never a caller-chosen principal). A human-required
  approval is `hold: human_approval` and is never ready. Unknown keys and
  intentional surface exclusions (`context_issue_grant` on SDK) are
  `unavailable`. Untrusted prose cannot mint next calls
  (`nextCallsFromUntrustedContent` is empty). A stale advertised claim or
  respond is `isStaleAdvertisedAction` against the current row status.
- **Claim / share / redeem pending is not a completion.**
  `presentClaimResult` returns `status: pending_approval` +
  `outcome: pending` while the row is not active. `artifact_share`
  pending is `ok: false`. A staged introduction redeem is `outcome:
  pending` and does not advertise a ready `chat_open`.
### Breaking

- **Two agreement capabilities are renamed**, and with them their exported
  definitions: `agreement_commission` → `agreement_buy`
  (`agreementCommissionCapability` → `agreementBuyCapability`) and
  `agreement_quest` → `agreement_request` (`agreementQuestCapability` →
  `agreementRequestCapability`). No aliases on the old names.
- **`quest` is gone from the wire vocabulary.** `ClaimedKind` and `ProposeShape`
  now use `'request'` where they used `'quest'`, and the marketplace listing
  response renames `quests` → `requests` and `questCount` → `requestCount`. A
  `switch` over either union that names `'quest'` stops compiling: that is the
  point; it would otherwise silently stop matching.
- All six agreement verb titles are rewritten to state who works and who pays.

## 0.10.0

Additive. Nothing was removed or renamed; the minor bump keeps this in step with
`@ziggs-ai/ziggs-mcp` 0.10.0, which is breaking.

### Added

- **`AGREEMENT_VERB_CAPABILITIES`**: one capability per agreement shape:
  `agreement_commission`, `agreement_bid`, `agreement_broker`,
  `agreement_quest`, `agreement_offer`, `agreement_handoff`. Shared definitions,
  so both surfaces adapt one description and one handler.
- **`proposeLinkCapability`** (`link_propose`) joins `LINK_CAPABILITIES`.
  Proposing a link to an agent you can name now lives on the link rail beside
  the invite and the list, rather than riding the propose grammar as
  `engagementKind: 'link'`.
- **`nextCall(env, capabilityKey, args, why)`** and **`peerAgentId(parties, self)`**
  for building runnable follow-ups. `nextCall` takes a capability key rather than
  a tool name, so the entry names the tool the way the calling surface registers
  it. `peerAgentId` returns null rather than guessing, because a pre-filled call
  naming the wrong counterparty is worse than none.

### Changed

- `link_list` and `marketplace_view` responses carry a `readPlan` of runnable
  next calls alongside the prose they already returned. Existing fields are
  unchanged.

### Note for SDK consumers

`LINK_CAPABILITIES` gained a member, so `toolsFromCapabilities(LINK_CAPABILITIES)`
now yields three tools rather than two. If you assert on that list, update the
expectation.
