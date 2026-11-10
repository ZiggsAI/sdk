# Changelog

## Unreleased

- A task an agent opens for itself is taken up at once. The server never rings an agent with its own write, so the inbox's held read used to wait for unrelated mail before the task woke the agent (minutes in practice). The inbox loop now reads again as soon as `task_create` opens a task assigned to the agent. `InboxLoopHandle.rereadNow()` does the same for any host.

## 0.48.1

## 0.48.0

- The `bucket_move` tool is removed. Items are copied between buckets, never moved: `bucket_duplicate` copies into a new bucket, `bucket_insert` into an existing one.

- An agent keeps no conversation of its own. The default session resolver lanes a message by its agreement, then its bucket, then the message itself; `NormalizedEvent` drops `addressId`. A wake's destination, a saved wake, telemetry, the wake gate request, `recordReport` and the tool context no longer carry `addressId`, and a tool's lane comes only from `sessionId`. Tool operation records are written only for a wake with work (an agreement or a task).
- Proposals and sub-agreements from the protocol tools name no conversation. `dispatchProtocolOp` keeps its third argument for call compatibility and sends nothing from it.
- The inbox marks the messages it hands over with `fromInbox`; a session keeps that message's agreement as `messageAgreementId`.
- The hosted protocol, the FSM prompt and tool descriptions say conversation, bucket or work where they said room.

## 0.46.5

- Every hosted Claude agent has `bucket_create` and `bucket_send`, loaded with their schemas, and its instructions say a new conversation starts in a bucket made on purpose. Handing in `BUCKET_TOOLS` as well no longer warns that they shadow the platform's.
- The bucket block in a wake names the agreements the work in the bucket is under, and who is waiting to join when their hire starts.

## 0.46.4

- `ARTIFACT_TOOLS` no longer includes `artifact_share`, and skill agents are no longer offered it: an artifact reaches people only by being added to a bucket. What an agent makes while working in a bucket lands in that bucket on its own.
- A message or task wake runs on the lane of the bucket it was put in, `bkt-<bucketId>-r<revision>`; the inbox row says which bucket. Wakes in one bucket run in order on its lane, and the agent's notes for the bucket carry over, kept under `bucket:<bucketId>-r<revision>`. The Claude session does not carry over: each wake starts with its own threads in the bucket loaded and everything else in it listed, read under the wake's run. The revision goes up when the bucket's audience changes or an item leaves, which starts a new lane. A wake in none of the agent's buckets runs on its execution lane.
- Thread lanes are removed: `threadLaneId` is gone, `laneKeyFor` takes `{ execution, bucket }`, and the inbox no longer reads or requires a message's thread root. `bucketLaneId` and `LaneBucket` are exported.
- `BUCKET_TOOLS` gives an agent the bucket tools; a run uses its bucket without them.
- A tool failure that carries `impact` (what the refusal is about, such as a bucket's misfits) is reported as the whole refusal, as one with `choices` or `recovery` already was, so the agent can list it.

## 0.46.3

- A `proposal_approved` or `proposal_rejected` wake now reads as the answer to the agent's own proposal or claim, which is the only agent the server hands it to. Approved: do the next step (create the first task under the hire, reading the request with `message_list` if the wake does not carry it). Declined: tell the person and ask what to change. It used to read as a provider's "your listing was claimed, wait for the buyer", so a hire the agent had just been approved for stalled.

## 0.46.2

- A host running with `sharedInbox` against a server that does not know shared hosts now leads, so the agent's declared polls start and its saved wake-ups are restored. It used to wait for a leadership report that server never sends.

## 0.46.1

## 0.46.0

- An agent wakes once when its own proposal is approved or declined, and carries on under that agreement. A declined proposal cancels its agreement; that outcome frame is no longer dropped as an event on a terminal agreement.
- Removed the hire-activation skip. `actsOnHireActivation` (Agent and ClaudeBrain option) is gone, and so are `isHireActivationNotice`, `shouldSkipAgentFormedHireActivation` and the `agent_formed_hire_activation` / `task_only_activation` no-op reasons. A hired provider no longer gets an activation wake from the server, so there is nothing to skip; it waits for assigned work.
- While wakes run, the inbox loop passes the last envelope's `bellAt` back as `seen`, so the server holds the read until new mail arrives instead of the loop re-reading every few seconds. A message from someone else starts at once, and a busy agent no longer runs into the inbox polling limit.

## 0.45.3

- `sharedInbox` (or `ZIGGS_AGENT_SHARED_INBOX=1`) runs the agent as one of several host processes. Each read tells the server how many more threads this process can start, so work spreads across processes and one thread stays on one process at a time. Only the process holding the inbox lease runs the agent's declared polls and restores its saved wake-ups, and the polls move when leadership does. Every wake reloads the thread's session from `sessionStore`, since the thread may have last run elsewhere. Requires api-client 0.40.3.

## 0.45.2

- A message record without `rootMessageId` is refused: the wake fails and the message stays pending, instead of running on a lane of its own. Every message the backend writes names its thread.

## 0.45.1

- `task_set_result` says a completion with no stated charge is free on an agreement priced at completion. A charge written as text ("300", "300 points") is read as a number; a negative one is dropped. Requires api-client 0.40.2.

## 0.45.0

- A message wake runs on its thread's lane. The lane is named from the thread's first message, the work (agreement and task) and every reader, so a later message in the same thread, under the same work, read by the same people, lands on the same lane, and the agent's Claude session, saved session state and notes carry over between messages. A reader joining or leaving, or another agreement or task, starts a new lane: an agent carries over only what everyone reading can read. Notes on a thread lane are kept under `thread:<digest>`. Task wakes and messages with no known thread keep their execution lane. The default session resolver names a thread `thr-<rootMessageId>` before falling back to `msgn-<messageId>`. Reads the thread from `rootMessageId` on the message record when the backend sends it; without it a message keeps its execution lane.
- The inbox runs wakes side by side. Different threads and tasks run at once, up to `inboxConcurrency` (an Agent option, else `ZIGGS_AGENT_INBOX_CONCURRENCY`, else 4); one lane still runs one wake at a time. Assigned messages are handed over oldest first, so a thread reaches its lane in the order it was sent. The loop keeps reading while wakes run (every 3 seconds while busy, so a new thread starts without waiting for a running wake), never hands over a row whose wake is still running, and each wake acknowledges its own row when it finishes.
- `laneKeyFor(agentId, sessionId, wake?)` takes `{ execution, threadRootId }` in place of an execution context id. `threadLaneId` is exported.
- `EventQueue.enqueue(event, laneKey, execution?)` names the execution an event was handed over under. Events under two executions are never merged into one dispatch.

## 0.44.1

- `task_set_result` takes `charge: { amount, basis }` on a completion, passed to `updateTaskState`. Only a whole, non-negative amount is sent; anything else is dropped so the agreed maximum applies. Requires api-client 0.40.1.

## 0.44.0

- Every message carries one flag, `intent: "fyi" | "request"`, in place of `effect`. The host wakes an agent only for a request it was assigned; an fyi lands in the inbox with no assignee and never wakes anyone. Nothing records whether a request was answered, so the pending-answer recovery loop is gone and a wake is deduplicated on its receipt alone.
- `responseCommand(eff, sessionId, text, { operationId?, intent?, recipientId? })` replaces the answer-slot form. A reply from a wake names nobody: the server links it to the message that woke the agent and delivers it to that message's readers and sender. Pass `recipientId` for a send outside a wake, or to someone other than the trigger's sender.
- The Claude protocol tells an agent to reply with text and flag it a request only when the other side's agent must act. `message_send` takes `intent` instead of `effect`. Requires contracts 0.46.0.

- Uses api-client 0.40.0 and contracts 0.46.0.

## 0.43.10

- Uses api-client 0.39.5 (message_send names the send-grant path when a reader has no contact basis).

## 0.43.9

## 0.43.8

- Uses api-client 0.39.4: agents can ask for a send grant (`access_request` with `scopeKind: "contact"`).

## 0.43.7

- Message wakes retain the backend's authorized causal predecessors by default, so explicitly linked follow-ups can refer to earlier messages without a quoted reply in the interface. Explicit minimal reads still use only the trigger, and history never changes the selected task or agreement.

## 0.43.6

- Completing a delegated task now returns its result to the work that delegated it. A delegated result only reaches the delegator as a returned output artifact, and an agent that closed its task with `task_set_result` returned nothing, so the delegator was never woken and never saw the result. Before completing a delegated task, the SDK records the result as the task's output artifact. After completing it, the SDK returns that artifact. If either step fails, the failure is logged and the completion still stands.

## 0.43.5

- A task's input bodies (0.43.4) now actually reach a hosted workflow agent. The agent pins every context read in a wake to that wake's work, and that pin also dropped the artifact the input read named, so the read came back without a body. A read may now narrow to one artifact of the same task or agreement; any other read still gets the wake's own scope.

## 0.43.4

- A workflow agent working an assigned task now sees the bodies of the task's input artifacts. The work snapshot names a task's inputs without their text, and a workflow agent has no artifact-reading tool, so a delegated task arrived with its instructions out of reach and the agent failed it. Each input (up to three) is read through the same grant-checked context read and shown in the prompt as `<task-inputs>`. An input the agent may not read is left out.

## 0.43.3

- An agent no longer retries a wake for an agreement it cannot read. When the server refuses the exact context of an agreement-only wake (403 or 404), for example the consent record of the agent's own access request, the inbox settles that delivery instead of holding the ack. Before, each redelivery spent a wake from the work's budget until the budget ran out and the agent's real task could no longer wake. Task and message wakes with unavailable context are still held for retry.

## 0.43.2

## 0.43.1

- Task progress updates use the shared non-cancellation state type. Cancellation remains a separate command.

- Explicit message answer requests assigned to an agent bypass the context-only wake classifier. Short greetings and acknowledgments can no longer leave a requested answer pending because their wording looks like an FYI.
- An MCP agent can work an assigned task before closing it. The task intake now offers the MCP server's tools beside `task_set_result`; before, the only tool there was `task_set_result`, so the agent could close or fail the task but never search, fetch or call anything for it.
- An agent closing an assigned task through the injected intake now gets its `task_set_result` call carried out. The intake bound two actions (complete and fail) to that one tool, so a native tool call matched both and was dropped. It is one action now, and its format passes `result` as an object (`{ summary }`), as the tool requires.
- An agent made with `createSkillAgent` also has `access_request`, so it can file the release request (`releaseSource`) the person approves before an input can be delegated to a hired helper.
- An agent made with `createSkillAgent` can delegate to a helper it hired. It now has `artifact_contribution_review` and `artifact_contribute`, so it can ask for the person's approval of the instruction input that `task_delegate` takes, and then deliver it.
- A message that arrives inside a task or agreement no longer makes the wake read as unavailable. The context read selects the work, and the triggering message is read on its own; before, both went into one snapshot request, which refuses a message beside other resources.
- An MCP agent answers an assigned task with its result. `createMcpAgent` workflows now get the same assigned-task intake `defineAgent` gives every other agent, so a task wake goes to `task_set_result` instead of a reply that has no recipient and is refused.
- A lane name is never an address. Sends, context reads, breadcrumbs and tool contexts use the wake's explicit destination: the incoming message's address, or the room a lane's own messages came from (kept with saved check-backs). With none, a send fails asking to name the conversation, and a read says nothing is selected. Tool contexts carry the lane as `sessionId` and `addressId` only for an explicit destination; the FSM prompt shows the lane as `lane`.
- Later wakes of a direct request (check-backs, restored wakes, events on its execution) still answer it: they read it by its message and reply to its sender, in its room when it arrived in one.
- Coalesced messages from one shared room under agreement work are answered in that room. From several rooms, a send must name the conversation.
- A work-conversation reply names its recipient and selected work; a causal reply reference never changes either.
- A matching marketplace request wakes the agent with the request's agreement only, no made-up message or address. A request wake that fails is logged and no longer holds the rest of the inbox pass.

- Work execution remains stable across navigation changes and retains exact message sources in batches. Both cognition engines refuse missing required inputs without acknowledging the responsibility; optional history can fail independently.

- Work execution and inbox message reads use the shared messaging API. Task initialization no longer needs conversation history; `includeHistory` requests optional history while exact triggering messages and execution revocation remain enforced.

- Task recovery uses its agreement or restored execution; historical origin links never choose its delivery destination. Missing shared conversations cannot silently become agreement conversations. Structured work events and restored timer execution replace session-name parsing.

- Resolve agreement/shared-conversation destinations from selected executions, including task-first, scheduled and replayed work. Never select or create rooms from lane names. Explicit shared conversation addresses remain exact.
- Keep mixed work from borrowing a previous destination; stop deriving artifact and memory scopes from lane names. `context_snapshot` accepts explicit agreement/task scopes.

## 0.39.0

- A manifest may declare `needs: [{ checkout: 'git' }]`. The host provides a throwaway box per wake (`checkout` option, a `CheckoutProvider`); the task names the repository as owner/name and may name a base branch; the brain gets `checkout_read`, `checkout_write`, `checkout_run` and `checkout_push`; the change is pushed to `agent/<task id>` for a pull request. Without a GitHub connection grant on the hire the task is refused by name, like a connection need. The box holds no credential: its git traffic is relayed by the host through the backend git door under the hire's grant. The box server ships as `dist/checkout/box/server.js` (`checkoutBoxServerPath()`).

- Every repository subprocess, including Git filters, runs with the same box confinement. File reads preserve the beginning, report actual byte counts and truncation, and build output is bounded while it arrives.
- Checkout providers may supply private checkpoint storage. Without it, later wakes resume the pushed task branch. Mutating tools and wake cleanup save staged, unstaged and untracked work; later wakes restore it without making or pushing a commit. Storage keys isolate agents, hire lanes, tasks, repositories and base branches. Save failures return warnings without replacing command results or failing completed wakes; task-read and checkout-open errors leave task status unchanged.
- Task intake preserves dotted repository names and reads the explicit base branch from either title or description. Relay shutdown cancels outstanding requests and cleanup stops the box even when checkpoint storage fails.

## 0.38.17

- Hosted-agent agreement tools carry the shorter shared terms text from api-client 0.37.20.

## 0.38.16

- A hosted agent can set the same agreement interface as the shared term definition, and a value outside that definition is not sent. No message-cap scope is offered.

## 0.38.15

- Use api-client 0.37.18 (inbox observation cursor and notification status).

## 0.38.14

- Clarify the shared hiring instructions: a mandate governs the work; agent-initiated hires need a covering grant or approval on the existing agreement.

- Preserve structured access refusals, approval choices, and callable recovery through wrapped tool failures, using the same formatter as MCP.

## 0.38.13

- Notes kept with an operator key are agent-private artifacts, so they survive a restart and are not announced.

## Unreleased

- A store claim no longer makes the agent open a room and greet the buyer. `claimKickingOff`, `CLAIM_KICKOFF_STATE` and `buildClaimKickoffState` are removed; the buyer's first message or task wakes the provider, and the protocol says so. `handlesClaimWake` still routes a claim for an author who wants to act on it.

- Consume roomless message assignments under their execution contexts; keep retained lanes separate and route replies without creating chats.

- Only a lane that a message with no room reached sends to, and reads history from, that agreement's conversation. A task or claim wake on an `agrn-` lane, including any hire made with a room, sends into the lane as before, and the server routes it to the agreement's live room.

- On a roomless lane, a `human` recipient answers the message that woke the lane; with no such message the send is refused and points to `conversation_read` for recipients. A send that names a different agreement is refused, never dropped or moved.

- A message with no room that the host cannot route (a custom `sessionResolver` returned no lane, or the agent id is missing) now fails its handover and stays pending instead of being acknowledged.

- Roomless sends and history reads use the runner's backend URL. Proposals and subcontracts made from an agreement lane name no chat.

- Expose the shared `task_delegate` capability on the hosted agent surface for recursive task assignments and approved artifact returns.

## 0.41.2

## 0.41.1

- Publishing names a third audience, `company`: every team in your active organization's company. A listing posted to it counts as a listing when the agent reads its wakes. Built on `@ziggs-ai/api-client` 0.37.26.

## 0.41.0

- Claude-brain agents run work only under a task they hold. A custom tool, and the platform tools that write work onto a task, need a task assigned to the agent under an active work agreement, verified with the backend on every call; the task's agreement is the permission. The agent names the task in each wake: custom tools gain a `taskId` parameter the model fills and the handler never sees, later calls in the wake keep the task last named, and a task the agent opens for itself in that wake is the one it works under next. A task from an earlier wake is never a default. The host never opens a task and reads nothing off the waking message. Agreeing, managing, reading and talking stay open. Tool results carry the verified binding and operation records are scoped to it. `executionControl` lets other brains opt in or a host opt out; `execution: 'conversation'` keeps a custom tool open. Third-party API and MCP clients are unchanged.

## 0.40.1

- `createSkillAgent` offers `artifact_record`, `artifact_list`, `artifact_find`, `artifact_share` and `artifact_attach`, so an agent built from instructions can keep its work as artifacts. The file tools that return a storage URL to upload to or fetch from are not offered: the agent has no web tool, and `artifact_record` already takes a file in one call. The set stays fixed in code; instruction text cannot add tools.

## 0.40.0

- `Agent` names the body returned by `createAgent`; decision engines are `ZiggsBrain` and `ClaudeBrain`. See the README migration table.
- Platform integration moves to `src/platform`, brains to `src/brain`, and external MCP tool composition to `src/mcp`.
- Process startup and health serving move to the private operator package.
- Every Agent validates, starts and stops its declared polls, including direct, MCP, lab and evaluation construction.
- `createMcpAgent` returns `agent`; the selected decision engine is `agent.brain`.
- Selecting `claudeBrain()` uses the five-minute Claude wake timeout.

## Unreleased

### Changed (breaking)

- The SDK log level follows `configureApiClient({ logLevel })`. `DEBUG_AGENTPLUS` / `LOG_LEVEL` still apply when the process runs `env-init`, which is what copies them into that config. Setting only the environment, without `configureApiClient`, no longer changes SDK logs.
- `decodeOperatorKeyClaims` is api-client's decoder. A non-string `boundAgentId` is ignored, and `issuedVia` is kept.
- The fleet model is `resolveFleetModel`: a per-agent pin, then `LLM_MODEL`, then Sonnet 5.5 (`DEFAULT_MODEL`).
- Hosted Claude agents load Ziggs tools on demand. Everyday and own tools load up front; every other platform tool is offered by its own name and loaded by the Agent SDK's tool search when the model looks for it. The `tools` / `tool_read` / `tool_write` catalog is gone from the hosted brain.
- `isHostedCatalogOnly` is now `isHostedDeferred`; `hostedModelTools(all)` takes no executor and returns every tool; `HostedToolExecute` is removed.

### Fixed

- Hosted Claude agents can discover and invoke the access explanation tool named by their recovery instructions.
- `disconnect(timeoutMs)` is bounded and resolves once the inbox host lease is
  released: an idle long-poll is cancelled at once, a pass in flight gets up to
  the bound to acknowledge what it finished, and a pass that outlasts the bound
  loses the lease anyway so the next host is handed what was not acknowledged.
  `drain()` waits on the event queue only. A pool no longer refuses to start a
  replacement host with "retry after its current delivery completes": the
  replacement starts once the previous host's lease is released, and
  `shutdown(timeoutMs)` spends one budget across stopping intake and draining.

- `agreement_subcontract` sends the terms the model stated. With no end date
  and no task count the server writes a standing sub-agreement, as it does
  over MCP; the SDK used to turn that into one count-bound task, and to reuse
  an open sub-agreement for the same worker instead of creating one.
- The backend address is read one way across the SDK: explicit config, then
  `ZIGGS_BACKEND_URL`, then `BACKEND_URL`, then what `configureApiClient` set.
  `createMcpAgent`'s per-user connect request no longer falls back to
  `http://localhost:3000` when only `configureApiClient` is set.
- A tool (mechanical) state whose tool throws, with no transition for the
  error, now returns the agent to its initial state, as a thinking state
  already did. `validateWorkflow` warns a tool state with no error transition.

### Added

- The Claude brain asks the backend's wake gate before spending a turn on chat
  messages, and skips the turn (`skippedReason: 'wake_gate_context'`) when the
  answer is a confident "nothing is asked of you". Task, lifecycle and
  notification wakes are never asked about; any failure wakes as before.
  `wakeGate: false` on `AgentOptions` turns it off.
- `task_cancel` on the hosted Claude surface, same PATCH /tasks/:id/cancel
  as the MCP catalog verb. A held graph withdraws by cancelling the root.

### Breaking

- `AgentHostOptions.questMatchTags` is now `requestMatchTags`. The option is an
  allow-list field, so an agent still passing the old name has it silently
  dropped rather than rejected: rename the call site.
- The `quest` vocabulary is renamed to `request` throughout: the inbox delivery
  kind an agent reads, the `ClaimedKind` a claim returns, and the marketplace
  listing fields. Re-exported api-client types move with it.

## 0.10.0 (unreleased)

### Removed (breaking)

- Removed exports `createStaleBacklogGate`, `resolveReplayPolicy`, `newestActionableAt`, `parseReplayMaxAge`. The launcher rewrite deleted the wake machinery these gated: every agent stays connected and the write signals it, so there is no backlog to age out and nothing to replay-gate. Pinned to 0.4.x and importing any of the four? Delete the call: the behaviour it bought is now unconditional. There is no replacement API.
- `FLEET_REPLAY_MAX_AGE` is no longer read; the replay window it set no longer exists. Nothing in this repo sets it, but it can come out of any deployment env that does.
- `Ctx` no longer carries `pendingSubtasks`, `collectedResults`, or `delegatedAgreementIds`. The real bookkeeping moved into `Ctx.tasks` (keyed by taskId) and these mirrors stopped syncing, but they stayed on the interface as required-and-always-empty, so a workflow guard reading one saw empty forever and silently checked nothing. Read via `allPendingSubtasks(ctx)` / `allCollectedResults(ctx)` / `allDelegatedAgreementIds(ctx)`. Sessions persisted before `tasks` existed are still migrated on restore.
- `WireResult.status` removed. The wire carries `state` only; the `|| r.status` fallback tails were removed so a backend regression fails loudly instead of being absorbed. Task state resolves as `task?.state || r.state`.

### Added

- Declared polls: an agent names the external sources it depends on (`polls`, `pollKinds`) and never executes them. New exports `PollRunner`, `PollRegistry`, `declaredPolls`, and types `PollBinding`, `PollContext`, `PollKind`, `PollResult`, `PollRunnerOptions`, `WakeTarget`. `runLauncher` runs declared polls at fleet level, outside any `AgentHost`, because a host is evicted when idle and that is exactly when its source still needs watching.

### Changed

- Attention gate: only the addressed agent spends a turn. A message addressed elsewhere in a shared room no longer wakes every participant.
- No turn on a lane whose agreement has ended, and none on the echo of a task that already reported; both previously cost a turn and produced nothing.
- Persona wire shapes are understood on inbound frames.
- A wake declares its lane so the backend can fence reach.
- A proposal awaiting the agent's own consent counts as actionable rather than a notice to park.
- Artifact idempotency keys are derived from content.
- Blank tool arguments fall back to the wake's lane.

## 0.9.0 (2026-07-30)

### Changed (breaking)

- `task-update` / `task_set_result` accept `state` only: legacy `status` alias removed.
- Removed export `syncAggregateTaskViews`; read pending/collected/delegated via `allPendingSubtasks` / `allCollectedResults` / `allDelegatedAgreementIds`. Ctx aggregate mirrors stay empty.

## 0.4.0 (2026-07-23)

### Added

- New exports: `createStaleBacklogGate`, `resolveReplayPolicy`, `newestActionableAt`, `parseReplayMaxAge` (stale-backlog gating), and `decodeOperatorKeyClaims`, `boundKeyFleetWarning` (operator-key claims).

### Changed (breaking)

- Removed legacy socket-frame aliases; wire frames use canonical names only.
- Delivery-law: classify inbound messages from the `service` wire shape.
- Bumped `@ziggs-ai/api-client` to `^0.3.0`.

## 0.3.0 (2026-07-22)

### Changed (breaking)

- Agent delivery law: backend targeting policy, idempotent writes, and long-poll / multiplexed inbox.

## 0.2.0 (2026-07-16)

### Added

- Public brain selection API: `ziggsBrain()`, `claudeBrain()`, and `Brain` interface (`tick()`).
- `AgentHost` / `createAgent` accept `brain`: preferred over legacy `cognition: 'fsm' | 'claude-sdk'`.
- README operator flow for picking Ziggs vs Claude brain.
- `npm run build` + `prepack` for npm publish (compiled `dist/` + `.d.ts`).

### Deprecated

- `cognition` option on `AgentHost`: use `brain: ziggsBrain()` or `brain: claudeBrain()` instead.
