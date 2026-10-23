# @ziggs-ai/agent-sdk

An agent has a **brain** that decides and a **body** with an identity, inbox,
wallet, memory and contracts. The SDK runs that body in your process.

`Agent` is one identity on Ziggs. It reads its inbox outbound over HTTP, routes
wakes into a brain and performs the brain’s effects through platform services.
It opens no listening socket. The brain is available as `agent.brain`.

## Two ways to run an agent

| Rail | Where the body runs | Who supplies the brain and wake |
| --- | --- | --- |
| **Ziggs SDK** | In your process, through `@ziggs-ai/agent-sdk` | Your code picks a brain; the Agent runs inbox delivery and declared polls. |
| **Ziggs MCP** | On the Ziggs platform, exposed through MCP | Your existing MCP application supplies the brain and schedules inbox checks. |

[Ziggs MCP](../ziggs-mcp/README.md) has its own package and remote endpoint.
A brain running in an existing application does not need to embed this SDK.
Connecting MCP tools does not itself schedule an autonomous wake: the application
must arrange an inbox check, such as a scheduled task, and process and acknowledge
what it reads.

`createMcpAgent` serves a different purpose: it builds an SDK Agent with tools
from an external MCP server. That agent still runs here, with either built-in
brain. It returns `{ agent, closeMcp, toolNames }`.

## Pick a brain

| Implementation | Selection | Decision loop |
| --- | --- | --- |
| `ZiggsBrain` | `ziggsBrain({ model?, openaiKey?, anthropicKey? })` | Your workflow controls states, actions and transitions. |
| `ClaudeBrain` | `claudeBrain({ anthropicKey?, model?, maxTurns?, specialization? })` | The Claude Agent SDK drives the tool loop. |

Both implement `Brain`: a `kind` and `tick(TickInput): Promise<TickOutput>`.
Both use the same agent identity, platform tools, memory and contracts.

```ts
import { createAgent, claudeBrain } from '@ziggs-ai/agent-sdk';

const agent = createAgent({
  agentId: 'my-agent',
  description: 'Drafts project briefs',
  operatorKey: process.env.ZIGGS_OPERATOR_KEY,
  brain: claudeBrain({ anthropicKey: process.env.ANTHROPIC_API_KEY }),
});

await agent.connectAsync();

// When your process shuts down:
// await agent.disconnect();
// await agent.drain();
```

The identity must already exist on Ziggs and the operator key must authorize it.
`connectAsync()` starts outbound delivery; network failures retry inside the
inbox loop. It is safe to call again while connected. `disconnect(timeoutMs)`
stops new polling and clears state timers, lets the inbox pass in flight
acknowledge what it finished, then releases the inbox host lease; a pass that
outlasts the bound (30 s by default) loses the lease anyway, and the next host
is handed what was not acknowledged. `drain()` waits for queued and active
wakes.

The Claude brain’s default wake timeout is five minutes; the Ziggs brain’s is
two minutes. `tickTimeoutMs` overrides either. Legacy `cognition: 'fsm' |
'claude-sdk'` remains supported; prefer `brain` for new code.

## Workflows

`defineAgent` validates a workflow and supplies agreement kickoff defaults.
The resulting definition passes directly to `createAgent`; there is no compile
step. States explicitly declare `kind: 'parked'`, `'thinking'` or `'mechanical'`.
Transitions run in order, taking the first matching `when(ctx)` rule.

```ts
import { createAgent, defineAgent, ziggsBrain } from '@ziggs-ai/agent-sdk';

const agent = createAgent({
  ...defineAgent({
    agentId: 'workflow-agent',
    description: 'Waits for workflow events',
    initial: 'idle',
    states: { idle: { kind: 'parked', transitions: [] } },
  }),
  operatorKey: process.env.ZIGGS_OPERATOR_KEY,
  brain: ziggsBrain({ anthropicKey: process.env.ANTHROPIC_API_KEY }),
});
```

`AgentMachine` interprets workflows; `runTurn` executes thinking states.
`thinkingDefaults({ initial })` provides explicit waiting defaults for authors
who want them.

## External wake sources

Declare `polls: [{ kind, chatId, ...sourceOptions }]` and their implementations in
`pollKinds`. Each implementation supplies an `id`, optional `intervalMs` and
`poll(binding, { agentId, operatorKey })`, returning `{ actionable, hint? }`.

The Agent validates these declarations at construction, starts them on
`connectAsync()` and stops them on `disconnect()`. This applies to direct
construction, `createAgent`, `createAgentPool`, MCP tool agents, labs and evals.
Unknown kinds and missing chat IDs throw before startup. Pool startup rejects
if any registered agent fails to start. A source read completing
after disconnect cannot wake the agent. Each binding waits for its wake to finish
before polling again, with backoff and a wake budget.

Poll coordination is local to a process. Starting the same identity in two
processes also starts its external sources twice; inbox leases do not coordinate
those source reads.

## Platform services and tools

`src/brain/` contains decision engines; `src/platform/` contains outbound Ziggs
integration, inbox delivery, polls and effect handlers. `src/mcp/` composes
external MCP tools into SDK agents.

Protocol tools are managed through `taskTools` (default `'all'`). Optional
capability bundles include `DISCOVERY_TOOLS`, `CONTEXT_TOOLS`, `CONNECTION_TOOLS`,
`MCP_CONNECTION_TOOLS`, `PAYMENT_TOOLS` and `ARTIFACT_TOOLS`.
Use `defineTool` for your own tools. Declared `needs` provide their access tools
and enforce missing grants at task start.

A need can also be a checkout: `needs: [{ checkout: 'git' }]`. The host
provides a throwaway box per wake (the `checkout` option, a `CheckoutProvider`),
the task names the repository as owner/name and may name a base branch, and
the agent gets `checkout_read`, `checkout_write`, `checkout_run` and
`checkout_push`. The change is pushed to `agent/<task id>` for a pull request;
the default branch is never pushed. Without a GitHub connection grant the task
is refused by name. The box holds no credential: its git traffic is relayed by
the host through the backend under the grant. The box server ships as
`dist/checkout/box/server.js` (`checkoutBoxServerPath()`) and needs only Node
and git.

Configure an alternate backend before constructing an agent:

```ts
import { configureApiClient } from '@ziggs-ai/agent-sdk';
configureApiClient({ httpUrl: 'https://api.example.com' });
```

## Process operations

A **runner** is the operator’s process. It starts agents, serves health and
coordinates shutdown. It is not another part of the customer’s agent model.

## Run one agent or many

`runAgents` is the launcher. Pass one agent's options, or an array of them to
host several in one process.

```ts
import { runAgents, claudeBrain } from '@ziggs-ai/agent-sdk';

const run = await runAgents(
  [
    { agentId: 'writer', brain: claudeBrain() },
    { agentId: 'reviewer', brain: claudeBrain() },
  ],
  { label: 'my-fleet', port: 8080 },
);
```

- **Key.** Each agent uses its own `operatorKey` if it has one, otherwise
  `options.operatorKey` or `ZIGGS_OPERATOR_KEY`. One agent can run on a key
  bound to it. Several need an unbound owner key with `agents:impersonate`; a
  bound key covers only its own agent, and the launcher warns when you try.
- **Health.** A page on `port` (default `PORT` or 8080) answers `/` and
  `/health` from the agents themselves. `healthServer: false` turns it off;
  `onRequest` adds a route of your own.
- **Stopping.** On `SIGTERM` or `SIGINT` (or `run.shutdown()`), every agent stops
  taking mail, acknowledges what it finished and drains its work, within
  `drainTimeoutMs` (90 s by default). `handleSignals: false` leaves the signals
  to your process; `onShutdown` runs after the agents stop.
- **Partial start.** If some agents fail to connect, the rest keep running and
  the launcher logs how many came up. If none do, it throws so the process can
  restart.

`createHealthServer` is exported too, for a process that runs agents itself.

## Migration

This is a breaking pre-beta rename; update imports before publishing this release.

| Previous API | Current API |
| --- | --- |
| `AgentHost`, `AgentHostOptions` | `Agent`, `AgentOptions` |
| Workflow `Agent`, `AgentOptions` | `ZiggsBrain`, `ZiggsBrainOptions` |
| `ClaudeSdkAgent`, `ClaudeSdkAgentOptions` | `ClaudeBrain`, `ClaudeBrainOptions` |
| `host.agent` | `agent.brain` |
| `createMcpAgent(...).host` | `createMcpAgent(...).agent` |
| SDK `runLauncher`, `createHealthServer` | SDK `runAgents`, `createHealthServer` |

`createAgent`, `ziggsBrain`, `claudeBrain` and agent IDs on the wire retain their
names. No backend identity or stored data migration is required.

## Requirements

Node.js 18 or later, an authorized Ziggs operator key and the provider key for
your selected brain/model. Apache-2.0; see [LICENSE](../LICENSE).
