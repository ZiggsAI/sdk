# Ziggs CLI for Codex and Claude Code

The session-aware CLI lets an assistant use Ziggs from its shell without enabling MCP in the host. It reaches the same credential-filtered operations and strict schemas as Ziggs MCP through a local adapter. The adapter opens no MCP port or transport; its handlers call the Ziggs API.

## Install

```sh
npm install --global @ziggs-ai/ziggs-cli
```

Requires Node.js 20 or newer. Check that `ziggs --help` lists `session`, `tools`, `describe`, and `call`; an older install lacks them.

## Install the skill

Copy the `skills/ziggs-cli` folder from this package to your host's skill directory:

| Host | Project location | Personal location |
| --- | --- | --- |
| Codex | `.agents/skills/ziggs-cli/` | `~/.agents/skills/ziggs-cli/` |
| Claude Code | `.claude/skills/ziggs-cli/` | `~/.claude/skills/ziggs-cli/` |

Invoke `$ziggs-cli` in Codex or `/ziggs-cli` in Claude Code. The skill also describes when it should load automatically. Hosts need shell execution, Node 20+, and access to the Ziggs API. A text-only assistant cannot gain execution or connectivity from a skill.

Skill locations: [Codex documentation](https://learn.chatgpt.com/docs/build-skills), [Claude Code documentation](https://code.claude.com/docs/en/skills).

## Connect a session

Supply your authorized operator key through the host's private environment as `ZIGGS_OPERATOR_KEY`. An agent-bound key identifies its agent; a fleet key additionally requires `ZIGGS_AGENT_ID`. Existing assistant connection credentials are supported and retain their workspace routing. The CLI does not sign in, refresh tokens, or store credentials. Configure `ZIGGS_API_URL` when using a non-default backend.

```sh
ziggs --json session new
```

Retain the returned UUID for this chat; replace `SESSION_ID` below with it. Use another UUID in another Codex or Claude chat. Reuse the original UUID when resuming a chat, including after the shell process exits.

```sh
ziggs --json --session SESSION_ID --app "Codex" session status
ziggs --json --session SESSION_ID --app "Codex" call ziggs_inbox
ziggs --json --session SESSION_ID --app "Codex" tools task
ziggs --json --session SESSION_ID --app "Codex" describe ziggs_task_get
ziggs --json --session SESSION_ID --app "Codex" call ziggs_task_get --read-only --args-file task-get.json
```

For Claude Code, set `--app "Claude Code"`. Optional `--session-name` labels the window. Optional `--workspaces org-a,org-b` narrows the inbox to the workspaces the user selected; individual operations still use their own `orgId` selection and normal authorization. Equivalent environment settings are `ZIGGS_SESSION_ID`, `ZIGGS_APP`, `ZIGGS_SESSION_NAME`, and `ZIGGS_WORKSPACES`. A session ID is required; the CLI never silently substitutes a shared machine/user ID.

Session IDs and labels use printable ASCII within the backend header limits. Session IDs are at most 128 characters. Do not share the same ID between concurrent chats. Legacy shorthand commands remain available but reject the new session options; use `call` for assistant work.

## Available capabilities and limits

`tools` exposes the operations allowed by your credential: inbox and acknowledgments, task progress/results/control, chats, artifacts, scoped context, discovery, agreements, and other permitted operations. `describe` provides parameters on demand. Directory credentials retain the narrower operation set, including separate observation and claiming of the inbox.

The backend retains control of assignment, session marks, leases, and permissions. A distinct session ID does not guarantee that two workers can own the same agent inbox simultaneously. Respect conflicts, and use the backend's assignment rules. This integration shares authorized Ziggs records, not private assistant transcripts or local files.

`call` emits the same content envelope as the underlying operation. Both local validation errors and backend tool errors exit nonzero; errors may appear in stderr as `{ "error": "..." }` or as a stdout envelope with `isError: true`. It does not retry mutations automatically. Use `--args-file PATH` or `--args-file -` for arbitrary content, and retain operation idempotency keys across retries.

After finishing or handing off work:

```sh
ziggs --json --session SESSION_ID session release
```

Normal CLI process exit does not release the session's lease, so a later process can acknowledge the same inbox window. Explicit release hands back the lease; it does not delete history or terminate another worker.

The skill does not keep a model running. Long polling works while the host is active. Scheduled waking or work while the host is closed needs a separately configured scheduler/worker.
