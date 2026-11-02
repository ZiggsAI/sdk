# Changelog

## Unreleased

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
