import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * The inbox card: what is waiting on the person and the work in hand, drawn
 * inside the chat by hosts that render MCP Apps views (Claude, ChatGPT,
 * Cursor). A host that does not still gets the text result.
 *
 * The view changes nothing. Its buttons only ask the host to open a page on
 * the Ziggs website, where the person acts signed in as themselves: a click
 * inside the card would reach Ziggs on the assistant's key, and Ziggs could
 * not tell the person clicked.
 */
export const INBOX_CARD_URI = 'ui://ziggs/inbox-card';
export const INBOX_CARD_MIME = 'text/html;profile=mcp-app';
/** Tool `_meta` linking `ziggs_inbox_show` to the view. */
export const INBOX_CARD_TOOL_META = { ui: { resourceUri: INBOX_CARD_URI } };

/** One request waiting on the person. */
export interface InboxCardRequest {
  kind: string;
  title: string;
  who: string | null;
  when: string | null;
  url: string;
}

/** One task in hand. */
export interface InboxCardWork {
  title: string;
  /** `2/5` when the task has a plan, otherwise null. */
  progress: string | null;
  url: string | null;
}

export interface InboxCardData {
  waitingOnYou: InboxCardRequest[];
  /** Requests past the listed ones, which the card counts but does not show. */
  moreWaiting: number;
  yourWork: InboxCardWork[];
  /** Everything, on the website. */
  allUrl: string | null;
}

interface SessionPayload {
  decisions?: Array<{
    kind: string;
    title: string;
    subtitle: string | null;
    proposedAtLabel: string | null;
    appUrl: string;
  }>;
  activeWork?: Array<{
    title: string;
    planDone: number;
    planTotal: number;
    appUrl: string | null;
  }>;
  truncatedProposals?: number;
  truncatedConnectionRequests?: number;
  agreementsListAppUrl?: string;
  sessionChatCard?: string;
  notice?: string;
}

/** The card's data, from the session block `ziggs_inbox` already builds. */
export function inboxCardData(payload: SessionPayload): InboxCardData {
  return {
    waitingOnYou: (payload.decisions ?? []).map((item) => ({
      kind: item.kind,
      title: item.title,
      who: item.subtitle,
      when: item.proposedAtLabel,
      url: item.appUrl,
    })),
    moreWaiting:
      (payload.truncatedProposals ?? 0) + (payload.truncatedConnectionRequests ?? 0),
    yourWork: (payload.activeWork ?? []).map((item) => ({
      title: item.title,
      progress: item.planTotal > 0 ? `${item.planDone}/${item.planTotal}` : null,
      url: item.appUrl,
    })),
    allUrl: payload.agreementsListAppUrl ?? null,
  };
}

/**
 * The tool result: the text a host without views shows (the session card the
 * model already relays, or the one-line notice when nothing is waiting), and
 * the same facts structured for the view.
 */
export function inboxCardResult(payload: SessionPayload) {
  const text = payload.sessionChatCard || payload.notice || 'Nothing is waiting on you.';
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: inboxCardData(payload) as unknown as Record<string, unknown>,
  };
}

/** Serve the view. It loads nothing from outside and calls no tools. */
export function registerInboxCardResource(server: McpServer): void {
  server.registerResource(
    'ziggs-inbox-card',
    INBOX_CARD_URI,
    {
      title: 'Ziggs inbox card',
      description: "What is waiting on you and the work you have in hand.",
      mimeType: INBOX_CARD_MIME,
      _meta: { ui: { prefersBorder: true } },
    },
    async () => ({
      contents: [
        {
          uri: INBOX_CARD_URI,
          mimeType: INBOX_CARD_MIME,
          text: INBOX_CARD_HTML,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    }),
  );
}

/**
 * The view. Plain DOM, text only: titles and names can be written by a
 * counterparty, so nothing is ever parsed as HTML. It speaks the MCP Apps
 * postMessage protocol: `ui/initialize`, then `ui/notifications/initialized`,
 * then it draws whatever `ui/notifications/tool-result` carries, and its
 * buttons send `ui/open-link`.
 */
export const INBOX_CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ziggs</title>
<style>
  :root { --fg:#1d1a20; --muted:#6b6470; --line:#e7e2ea; --bg:#ffffff; --brand:#7c3aed; --chip:#f4f1f6; }
  @media (prefers-color-scheme: dark) { :root { --fg:#f2eef4; --muted:#a59cab; --line:#332d38; --bg:#1b171e; --brand:#a78bfa; --chip:#29232d; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:14px 16px; font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--fg); background:var(--bg); }
  h2 { margin:0 0 8px; font-size:12px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); }
  section + section { margin-top:16px; }
  ul { list-style:none; margin:0; padding:0; }
  li { display:flex; align-items:center; gap:12px; padding:9px 0; border-top:1px solid var(--line); }
  li:first-child { border-top:0; }
  .text { flex:1; min-width:0; }
  .title { font-weight:600; overflow-wrap:anywhere; }
  .meta { color:var(--muted); font-size:12px; }
  .chip { display:inline-block; padding:1px 7px; border-radius:999px; background:var(--chip); color:var(--muted); font-size:11px; margin-left:6px; font-weight:500; }
  button { flex:none; min-height:32px; padding:0 12px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--fg); font:inherit; font-size:13px; cursor:pointer; }
  button.primary { background:var(--brand); border-color:var(--brand); color:#fff; }
  .empty { color:var(--muted); }
  .all { margin-top:12px; }
</style>
</head>
<body>
<main id="root"><p class="empty">Loading your Ziggs inbox…</p></main>
<script>
(function () {
  var nextId = 1, pending = {};
  function send(method, params) {
    var id = nextId++;
    window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params || {} }, "*");
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params || {} }, "*");
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function open(url) {
    if (!url) return;
    send("ui/open-link", { url: url }).catch(function () {});
  }
  function row(title, chip, meta, label, url, primary) {
    var li = el("li"), text = el("div", "text"), head = el("div", "title", title);
    if (chip) head.appendChild(el("span", "chip", chip));
    text.appendChild(head);
    if (meta) text.appendChild(el("div", "meta", meta));
    li.appendChild(text);
    if (url) {
      var button = el("button", primary ? "primary" : "", label);
      button.type = "button";
      button.addEventListener("click", function () { open(url); });
      li.appendChild(button);
    }
    return li;
  }
  function kindLabel(kind) {
    return kind === "link_request" ? "Link request" : kind === "proposal" ? "Proposal" : "";
  }
  function render(data) {
    var root = document.getElementById("root");
    root.textContent = "";
    data = data || {};
    var waiting = data.waitingOnYou || [], work = data.yourWork || [], more = data.moreWaiting || 0;
    if (!waiting.length && !more && !work.length) {
      root.appendChild(el("p", "empty", "Nothing is waiting on you in Ziggs."));
    }
    if (waiting.length || more) {
      var s1 = el("section"), l1 = el("ul");
      s1.appendChild(el("h2", "", "Waiting on you"));
      waiting.forEach(function (item) {
        var meta = [item.who, item.when].filter(Boolean).join(" · ");
        l1.appendChild(row(item.title, kindLabel(item.kind), meta, "Review", item.url, true));
      });
      s1.appendChild(l1);
      if (more) s1.appendChild(el("p", "meta", more + " more on the website"));
      root.appendChild(s1);
    }
    if (work.length) {
      var s2 = el("section"), l2 = el("ul");
      s2.appendChild(el("h2", "", "Your work"));
      work.forEach(function (item) {
        l2.appendChild(row(item.title, null, item.progress ? "Plan " + item.progress : "In progress", "Open", item.url, false));
      });
      s2.appendChild(l2);
      root.appendChild(s2);
    }
    if (data.allUrl) {
      var all = el("button", "all", "Open Ziggs");
      all.type = "button";
      all.addEventListener("click", function () { open(data.allUrl); });
      root.appendChild(all);
    }
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id != null && pending[msg.id] && !msg.method) {
      var waiter = pending[msg.id];
      delete pending[msg.id];
      if (msg.error) waiter.reject(msg.error); else waiter.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-result") {
      render((msg.params || {}).structuredContent);
    }
  });
  send("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "Ziggs inbox card", version: "1" },
    appCapabilities: {}
  }).then(function () { notify("ui/notifications/initialized", {}); }, function () {});
})();
</script>
</body>
</html>
`;
