# Cursor + Ziggs remote MCP (OAuth)

Connect Cursor (desktop IDE) to Ziggs: same OAuth authorization server and remote MCP endpoint as [claude.ai](claude-ai-oauth.md), with a Cursor-specific redirect URI and a local stdio fallback.

## Two paths

| Path | Config | Auth |
|------|--------|------|
| **Remote OAuth (recommended)** | [`cursor-remote-mcp.json`](cursor-remote-mcp.json) | Browser OAuth → Bearer on `/mcp` |
| **Local stdio** | [`cursor-mcp.json`](cursor-mcp.json) | Paste `ZIGGS_OPERATOR_KEY` |

## Remote OAuth setup (desktop)

### 1. Add the MCP server

One click: [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=ziggs&config=eyJ1cmwiOiJodHRwczovL21jcC56aWdnc2FpLmNvbS9tY3AifQ==). The link carries only the server URL below; Cursor asks before it installs. Then skip to step 3.

Or by hand. Project: `.cursor/mcp.json`
Global: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "ziggs": {
      "url": "https://mcp.ziggsai.com/mcp"
    }
  }
}
```

Or copy [`cursor-remote-mcp.json`](cursor-remote-mcp.json).

### 2. Restart Cursor

Quit and reopen Cursor (not just close the window).

### 3. Connect

1. **Settings → Tools & MCP** (or **Tools and Integrations**).
2. Find **ziggs** → **Connect** / authorize.
3. A browser opens the Ziggs consent page (`/app/oauth/mcp-consent`): click **Allow**.
4. Tools such as `ziggs_chat_list` appear in Cursor.

## How it maps to claude.ai

| Step | claude.ai | Cursor IDE |
|------|-----------|------------|
| MCP URL | `https://mcp.ziggsai.com/mcp` | Same |
| OAuth metadata | `https://api.ziggsai.com/.well-known/oauth-authorization-server` | Same (via protected-resource discovery) |
| Client registration | DCR at `/oauth/register` | Cursor DCR with the Cursor redirect URI |
| Consent | `/app/oauth/mcp-consent` | Same |
| Token | PKCE code → `/oauth/token` | Same |

**Cursor redirect URI (registered via DCR automatically):**

```text
cursor://anysphere.cursor-mcp/oauth/callback
```

Ziggs DCR accepts this in `redirect_uris`, no pre-whitelisting needed.

**Cursor cloud agents / automations** use a different callback and are not supported; use the desktop IDE.

## Local stdio fallback (operator key)

When OAuth is blocked or you need offline dev:

```json
{
  "mcpServers": {
    "ziggs": {
      "command": "node",
      "args": ["ABS_PATH/ziggs-mcp/dist/index.js"],
      "env": {
        "ZIGGS_API_URL": "https://api.ziggsai.com",
        "ZIGGS_OPERATOR_KEY": "op_..."
      }
    }
  }
}
```

See [`cursor-mcp.json`](cursor-mcp.json) and the [Claude Code doc](claude-code.md) for key minting.

## Verify

- Connect → browser consent → Allow.
- `ziggs_chat_list` returns data in Cursor chat.
- Disconnecting in the Ziggs Agents dashboard makes Cursor prompt for auth again on next use.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No Connect button | Update Cursor; confirm the config uses `url`, not `command` |
| Invalid redirect URI | Desktop Cursor must use `cursor://anysphere.cursor-mcp/oauth/callback` |
| 401 on tools | Re-authorize; check the connection in the Agents dashboard |
