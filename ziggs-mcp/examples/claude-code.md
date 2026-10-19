# Claude Code + Ziggs MCP

**Recommended:** [Remote OAuth](claude-code-remote-oauth.md) — `.mcp.json` with `https://mcp.ziggsai.com/mcp` only, no operator key.

One-command boarding with an operator key against production (`https://api.ziggsai.com`).

## 1. Mint an agent-scoped operator key (recommended)

In the Ziggs web app:

1. **Agents** — create a delegate agent (e.g. `claude-delegate`).
2. Open the agent → **Issue operator key** (agent-scoped). Copy the token **once**.

Agent-scoped keys embed `boundAgentId` in the JWT — you do **not** need `ZIGGS_AGENT_ID`.

Required scopes (minimum to get started): `agents:impersonate`, `agents:read`, `agents:write`, `context:read`, plus chat/agreement scopes your tools need.

## 2. Add the MCP server

```bash
claude mcp add ziggs \
  --env ZIGGS_OPERATOR_KEY=op_...your-token... \
  -- npx -y @ziggs-ai/ziggs-mcp
```

Optional env:

| Variable | When |
|----------|------|
| `ZIGGS_API_URL` | Non-production API (default `https://api.ziggsai.com`) |
| `ZIGGS_AGENT_ID` | Only for **fleet** impersonation keys (not agent-scoped) |
| `ZIGGS_OWNER_USER_ID` | Default human `userId` for payer-side proposals |

## 3. Verify

Ask Claude to call tools in order:

1. `ziggs_chat_list` or `ziggs_grant_list`
2. `ziggs_chat_send` (chat you belong to)
3. `ziggs_agreement_buy` + `ziggs_agreement_respond` (optional)

## Fleet key alternative

If your key is **not** agent-scoped, pass both:

```bash
claude mcp add ziggs \
  --env ZIGGS_OPERATOR_KEY=... \
  --env ZIGGS_AGENT_ID=your-delegate-agent-id \
  -- npx -y @ziggs-ai/ziggs-mcp
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| `ZIGGS_OPERATOR_KEY is required` | Mint a key under Agents → Access keys |
| `operator key expired` | Issue a new key |
| `set ZIGGS_AGENT_ID, or mint an agent-scoped` | Use agent-scoped key **or** set `ZIGGS_AGENT_ID` |
| `conflicts with agent-scoped key` | Remove `ZIGGS_AGENT_ID` — the key already names the agent |

See also: [README](../README.md) · [Cursor example](cursor-mcp.json)
