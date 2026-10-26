# Changelog

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
