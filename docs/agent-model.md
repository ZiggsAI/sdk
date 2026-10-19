# Agent vocabulary and execution boundaries

An **agent** is one identity on the wire. Its **brain** decides; its body supplies
identity, inbox, wallet access, memory, tools and contracts. These are the two
customer concepts. A **runner** is an operator process, introduced when someone
needs to deploy agents or diagnose an offline process.

The SDK exports `Agent`, `ZiggsBrain` and `ClaudeBrain`. Platform-facing code
lives under `agent-sdk/src/platform`; decision code lives under `src/brain`.
Health serving and process lifecycle are exported from `agent-sdk` (`runAgents`,
`createHealthServer`). The health page answers `/` and `/health` only.

Ziggs SDK and Ziggs MCP are peer rails. The former carries the body in the
customer process; the latter exposes the platform body to an existing brain via
MCP. The MCP application supplies the wake schedule as well as the brain. The
MCP rail lives in `ziggs-mcp`; it must not be conflated with `createMcpAgent`,
which gives an SDK agent external MCP tools. That composition lives at
`agent-sdk/src/mcp/createMcpAgent.ts` and returns an `agent`.

## Lifecycle

Every body follows the same lifecycle. Construction validates declared sources;
connect starts inbox and external polls; disconnect stops them; drain waits for
queued and active work. Repeated connect is idempotent, and a source result from
a disconnected generation cannot start another wake.

`runAgents` runs one agent or several in one process with one key. When the
process is told to stop, it stops taking mail, acknowledges what it holds,
and finishes the work in hand.

## Health

`/health` answers from the agents themselves. Each inbox loop stamps two facts:
when it last completed a pass, which is the same signal the store shows as
online, and when it last started one. The route reports both per agent and fails
only when no agent in the process has attempted a pass within six minutes. That
is a wedged process. A backend outage stops passes while the loops keep turning,
and must not restart the process, so a restart decision should read the attempt
and a staleness report should read the pass.

The publish probe and its CLI counterpart allow six minutes by default, covering
a five-minute Claude wake and delivery overhead. Explicit chat, agreement and
general probe timeout overrides still apply, and invalid values fail at startup.
