# ChatGPT + Ziggs remote MCP (OAuth)

Connect ChatGPT to Ziggs as a custom MCP app. OAuth only, no API key to paste.

Verified end to end against `https://mcp.ziggsai.com/mcp` on 2026-08-13. OpenAI
changed this surface around 2026-08-21 (what you can do once connected now
depends on your plan, and the settings path moved), so the plan table and the
labels below are current as of 2026-08-26 while the verification date stands for
the Ziggs half: the connection completes, consent is issued, and the tools work.
Treat the labels as a guide and the URL plus auth method as the contract.

## What your plan can do

Connecting works on every plan that exposes custom MCP. **Whether the write tools
run is a ChatGPT-side limit, not a Ziggs one.**

| Plan | Custom MCP | Ziggs tools you get |
|------|-----------|---------------------|
| Business / Enterprise / Edu | full (beta) | everything, reads and writes |
| Pro | developer mode, read/fetch only | the read tools |
| Plus | developer mode; write support not stated on both of OpenAI's pages | assume read-only until you see otherwise |

Read-gated plans still work usefully, because every read tool on the Ziggs side
carries a `readOnlyHint` annotation, so ChatGPT keeps exactly the tools it is
willing to run rather than dropping the connector.

Custom MCP apps are **web only**. There is no mobile support, and desktop is
undocumented.

**Endpoints**

| Role | URL |
|------|-----|
| Remote MCP (paste in ChatGPT) | `https://mcp.ziggsai.com/mcp` |
| OAuth metadata | `https://api.ziggsai.com/.well-known/oauth-authorization-server` |
| Consent UI (browser) | `https://ziggsai.com/app/oauth/mcp-consent` |

## Prerequisites

1. A Ziggs **user** account. Sign up at [ziggsai.com](https://ziggsai.com) if needed.
2. A ChatGPT account on a plan that exposes custom MCP: see the plan table
   above. On a workspace plan an admin may have to allow it first.

## Connect

1. Turn developer mode on. On an individual account: **Settings → Security and
   login → Developer mode**. On a workspace plan this is an admin setting rather
   than a personal one, so ask whoever administers the workspace.
2. **Settings → Plugins → +** to add a server, and give it a name, for example
   `Ziggs`. What used to be called connectors is now called **apps**, listed in a
   **Plugin directory**, so older instructions naming Settings → Connectors are
   pointing at a path that no longer exists.
3. For the server URL paste the remote MCP endpoint:
   `https://mcp.ziggsai.com/mcp`. It speaks Streamable HTTP.
4. Choose **OAuth** as the authentication method. There is no key or header to
   fill in, and no client id to register by hand: the server publishes its own
   metadata and ChatGPT registers dynamically.
5. Save and connect. A browser opens Ziggs. Sign in if prompted.
6. The **Connect to Ziggs** consent page names the application, the redirect, the
   requested scopes, and your delegate agent. Pick an **org** if you belong to
   more than one, then click **Allow access**.
7. You are returned to ChatGPT and the connector reports connected, with the
   `ziggs_*` tools available.

The first time you connect, you see the consent screen, even when already signed in
to Ziggs. Reconnecting later goes straight back to ChatGPT: the app is already
approved. Disconnecting in Ziggs withdraws the approval, and the next connection
asks again.

## Verify

Verify with a **read**, because a read works on every plan: ask ChatGPT to list
your Ziggs chats. Tools appearing and answering is the connection working.

Then, only if your plan allows writes, ask it to send a message in a chat you
belong to. In the Ziggs web app the message appears from your delegate agent, and
**Agents** shows the connection either way.

If the read works and the send does not, nothing is broken on the Ziggs side:
that is the plan gate in the table above.

## Disconnect

Ziggs → Agents dashboard → your connection → **Disconnect**. The connector in
ChatGPT prompts for re-auth on next use, and reconnecting binds the same delegate
agent.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| No option to add a custom MCP server | Developer mode off, or the plan does not include custom MCP | Turn on developer mode (Settings → Security and login on an individual account; an admin setting on a workspace plan); otherwise use claude.ai, Claude Code, or Cursor |
| Connected, reads work, every write is refused | Read-gated plan (Pro, and probably Plus) | Nothing to fix on Ziggs. Use the reads, or connect from a Business/Enterprise/Edu workspace |
| Nothing to add on your phone | Custom MCP apps are web only | Connect from a browser |
| Connector saves but no tools appear | The URL points somewhere other than the MCP endpoint | The path matters: `https://mcp.ziggsai.com/mcp`, not the bare host |
| Browser opens and returns without connecting | Consent was not completed | Finish the consent page and click **Allow access** |
| Tools appear but every call is refused | The token is bound to an org you did not mean | Disconnect, reconnect, and pick the right org on the consent screen |

See [Connect an assistant](https://ziggsai.com/docs#connect-assistant).
