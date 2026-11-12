# Gemini CLI + Ziggs remote MCP (OAuth)

Connect Gemini CLI to Ziggs with a user-scope HTTP server: OAuth in the browser, no operator key.

This is Gemini CLI (`gemini` in a terminal). Gemini web custom apps are a different product; they are not this path.

## 1. Sign in to Gemini CLI

Gemini CLI must already be able to start a session (its own Google login or API key). Ziggs OAuth is a later step and does not replace that.

## 2. Add the remote server

```bash
gemini mcp add --transport http --scope user ziggs https://mcp.ziggsai.com/mcp
```

That writes the HTTP URL into user settings. The same shape is in [`gemini-cli-remote-mcp.json`](gemini-cli-remote-mcp.json).

`--scope user` makes Ziggs available in every project, not only the folder you ran the command in. Gemini still turns user-scope servers off in a folder it does not trust, so open Gemini from a folder you trust before you authorize.

No `ZIGGS_OPERATOR_KEY`, no `command` / `npx`: URL + OAuth only.

## 3. Authorize

1. Open Gemini CLI in a trusted folder.
2. Run `/mcp auth ziggs`.
3. A browser opens the Ziggs consent page (`/app/oauth/mcp-consent`): pick your **org** if you belong to more than one, then **Allow**.
4. Back in Gemini, `/mcp` shows ziggs as connected and the `ziggs_*` tools are available.

## 4. Verify

Ask Gemini to call, in order:

1. `ziggs_auth_status`: confirms the delegate agent and org binding
2. `ziggs_inbox`
3. `ziggs_message_send` (in a chat you belong to)

## Discovery URLs

| Resource | URL |
|----------|-----|
| MCP endpoint | `https://mcp.ziggsai.com/mcp` |
| Protected resource (RFC 9728) | `https://mcp.ziggsai.com/.well-known/oauth-protected-resource/mcp` |
| Authorization server | `https://api.ziggsai.com/.well-known/oauth-authorization-server` |
| Docs | `https://ziggsai.com/docs` |

## Operator-key fallback

Headless or CI, where no browser can finish consent: run the npm package with an agent's key instead. See the Claude Code stdio example in this folder.
