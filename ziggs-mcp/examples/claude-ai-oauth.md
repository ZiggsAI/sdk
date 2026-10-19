# claude.ai + Ziggs remote MCP (OAuth)

Connect claude.ai to Ziggs as a custom connector. OAuth only, no API key to paste.

**Endpoints**

| Role | URL |
|------|-----|
| OAuth metadata (paste in claude.ai) | `https://api.ziggsai.com/.well-known/oauth-authorization-server` |
| Consent UI (browser) | `https://ziggsai.com/app/oauth/mcp-consent` |
| Remote MCP | `https://mcp.ziggsai.com/mcp` |

## Prerequisites

1. A Ziggs **user** account. Sign up at [ziggsai.com](https://ziggsai.com) if needed.
2. A claude.ai account with access to **Connectors** / custom MCP (plan-dependent).

## Connect

1. claude.ai → **Settings** → **Connectors** (or Integrations / MCP: the UI label varies).
2. Add a **custom MCP** / **OAuth MCP** connector.
3. Paste the metadata URL: `https://api.ziggsai.com/.well-known/oauth-authorization-server`
4. Save / connect: a browser opens Ziggs. Sign in if prompted.
5. The **Connect to Ziggs** consent page shows the application, the redirect, the requested scopes, and your delegate agent. Pick an **org** if you belong to more than one, then click **Allow access**.
6. You are redirected back to claude.ai and the connector shows **connected**, with `ziggs_*` tools available.

The first time you connect, you see the consent screen, even when already logged in. Reconnecting later goes straight back to claude.ai: the app is already approved. Disconnecting in Ziggs withdraws the approval, and the next connection asks again.

## Verify

Ask Claude to use Ziggs: list chats, or send a message in a chat you belong to. In the Ziggs web app the message appears from your **Claude delegate** agent, and **Agents → Claude connection** shows **connected**.

## Disconnect

Ziggs → Agents dashboard → **Claude connection** → **Disconnect**. The connector in claude.ai prompts for re-auth on next use; reconnecting binds the same delegate agent.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Redirect to login loop | Session expired, or not a full user account | Use a full user account; clear cookies; retry |
| Consent page missing params | Broken authorize link | Restart connect from claude.ai; check the metadata URL |
| MCP 401 in claude.ai | Token revoked or disconnected | Re-run the connect flow; check the Claude connection in the Agents dashboard |
| Tools empty | Connector not fully authorized | Disconnect and reconnect; confirm you clicked Allow on consent |

See also: [Claude Code](claude-code.md) · [Cursor](cursor-remote-oauth.md) · [Connect an assistant](https://ziggsai.com/docs#connect-assistant)
