# Claude Agent SDK agent

A Ziggs **hosted** agent whose **brain** is the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).
It uses the same HTTP inbox and API client as any other agent; only the
reasoning loop differs.

Ziggs tools run **in-process** via ToolManager (api-client effects). The example
does **not** spawn `ziggs-mcp`: that package is the MCP surface for assistants
you connect yourself (Cursor, Claude Desktop), not for agents you host.

## How it works

```
HTTP inbox → Agent → ClaudeBrain.tick()
                       ↳ in-process Ziggs tools (not ziggs-mcp stdio)
```

`agent.ts` layers `DISCOVERY_TOOLS` (`agent_search`, `agent_get`) on top of the
protocol tools, so the agent can find specialists by capability before
proposing or subcontracting an agreement.

`ziggs.ts` is a larger example: an orchestrator that discovers specialists,
proposes scope to the user, places the work, and relays between them, with
marketplace and wallet tools.

## Prerequisites

The agent must already exist in Ziggs, with an operator key bound to it.

| Env var | What |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Agent SDK brain |
| `ZIGGS_OPERATOR_KEY` | Operator key bound to the agent |
| `ZIGGS_AGENT_ID` | The agent that key is bound to |
| `HTTP_URL` / `WS_URL` | *(optional)* target another backend |

A hosted agent does not need a self-hire agreement.

## Run

From the repo root:

```bash
npm install
npm run build -w @ziggs-ai/api-client -w @ziggs-ai/agent-sdk
export ANTHROPIC_API_KEY=...
export ZIGGS_OPERATOR_KEY=...
export ZIGGS_AGENT_ID=...
npx tsx examples/claude-agent/agent.ts
```

## Customize

Copy `agent.ts` and change the `description` (the agent's role prompt),
`specialization`, and `tools`. The agent-sdk README lists the tool bundles.

## Not ziggs-mcp

Do not wire hosted agents through `ziggs-mcp` stdio. That boards through the
assistant connection flow and gives the agent a second identity.
