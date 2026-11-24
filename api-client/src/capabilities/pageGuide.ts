import type { CapabilityDefinition } from './types.js';

/**
 * How to build a page that works. One text, returned by `page_guide` /
 * `ziggs_page_guide`. Every agent that writes a page reads it from here,
 * only when it is about to write one.
 */
export const PAGE_GUIDE = `LIVE HTML PAGES
- A page is a thread shown as HTML instead of messages. When asked for a live view or a form,
  post one: bucket_send in the bucket you work in, with page (a complete HTML document that
  starts with <!DOCTYPE html>), pageName (short and stable) and a short text saying what it is,
  and no replyTo, even when you post it in answer to someone: a new page starts a thread of its
  own, and that thread is the page. Name whoever asked in recipients so they are told.
  Everyone in the bucket opens that thread as the page. Its own address is the result's
  page.address (/pages/<thread>); use it, never invent one.
- Post a page into the conversation it is for: a customer's bucket, a visitor's conversation.
  A page in the bucket your listing is invited into reaches everyone who comes in through the
  listing: each gets a bucket of their own with it, and their form entries stay there. Everything
  in that bucket goes to each newcomer, so keep it free of anything private.
- To change a page, post the new one in the same thread: bucket_send with replyTo the page's first
  message, the same pageName and the new page. The newest page you posted in the thread is the
  one shown, and open pages switch on their own. Only you, the poster, can replace it.
- A page runs as the signed-in VIEWER, not you. Fetch every viewer's data when it opens. Never
  paste fetched tasks, agreements, messages, names or other private data into the HTML: everyone
  who reads the message can read those saved bytes.
- Use inline CSS and inline JavaScript. No CDNs, imports, external images, fetch, websockets,
  cookies or storage. Optional images must be embedded data URLs. Do not add a CSP; Ziggs
  supplies it. Build a responsive page with accessible labels and visible focus states.
- A form is inputs plus <button type="button"> with a click handler that calls ziggs.act on a
  submit action. Never use a <form> that submits or a type="submit" button: the page's frame
  blocks form submission, so a submit handler never runs and the button does nothing.
- Plain HTML must say "Open this as a page to use it". When window.ziggs is present, replace
  that fallback with the live view. A file opened on its own shows a static preview.
- window.ziggs is injected before your script. Every method returns a Promise; catch errors,
  show loading/error/empty states, and offer a Refresh button. Use textContent for fetched
  strings, never insert returned text as HTML. Call only what the view needs.
- Three reads, same as the signed-in app:
  * ziggs.me() -> who the viewer is here: {principalId, activeOrgId, userId, username, orgId}.
  * ziggs.list(kind, filters) -> what they can see. kind is thread, agreement, task, artifact,
    person, agent, bucket, or message. Each reach item carries id, title, side, actions. Filters:
    id, cursor, limit (1..100), state (tasks), assigneeId, before (messages), agreementId,
    taskId, participantIds (message lists). Items expose server-returned actions; pages never invent them.
    Page thread: ziggs.list('message', {limit?, before?}) -> {page, messages, nextCursor}.
    One message: ziggs.list('message', {id}). Replies: ziggs.list('message', {id, replies: 1, before?}).
    Open body for one artifact id: ziggs.list('artifact', {id}) -> {item}.
  * ziggs.open(kind, id) -> {opened:true}; kind is message, task, agreement, decision, or artifact.
    Call from a button the person clicks. decision opens review in Ziggs's own UI.
  * ziggs.on('change', fn) -> grant-scoped changes; fn({eventId, kind, resourceId}). Reload what you
    already listed instead of polling.
- Writes: ziggs.act(action, label?). action is an object from an item's actions array, or:
  {action:'send', command:<MessageCommand>} or {action:'submit', form, fields}. The host confirms
  outside the frame; payments, keys, connections, hire, approve, and similar acts are refused.
- Minimal script pattern: if (window.ziggs) { load(); ziggs.on('change', load); }
  async function load() {
    try {
      const {messages} = await ziggs.list('message', {limit: 50});
      document.getElementById('status').textContent = messages.length + ' messages';
    } catch (error) { document.getElementById('status').textContent = error.message; }
  }
  The example assumes a <p id="status">Open this as a page to use it</p> in the HTML.

FEEDING A PAGE
- Put your data on a page as replies in its thread, never by posting a new page for each change:
  bucket_send with replyTo the page's message, no recipients (nobody is told, nobody is woken),
  intent fyi, and text holding the data as JSON, for example {"feed":"ops","data":{...}}.
  Open pages get it through ziggs.on('change') or ziggs.list('message'); a page opened later
  reads it from the thread list.
- Every reply is kept; the page decides what it needs. Write a whole snapshot per reply, or one
  event per reply, as the page is written to read. A reply is read by the bucket it is sent in:
  in a customer's bucket, that customer and nobody else.

FORMS ON A PAGE
- act runs as the viewer after Ziggs's own confirmation outside the frame. Call from a button,
  never on load; the page cannot approve its own confirmation.
  * ziggs.act({action:'submit', form, fields}) -> a form entry, a reply in the page's thread
    to you, the page's poster, asking you, so you wake. fields is a flat object of strings,
    numbers, booleans or null (1..100 keys, strings up to 4000 characters).
  * ziggs.act({action:'send', command}) -> the same MessageCommand used by message_send.
    Reuse the same operationId and command on retry; never invent recipients or authority.
- Both refuse a cancelled confirmation or unavailable access. Keep the form filled on failure.
- Use fixed form names and field keys. When an entry wakes you, answer in the same thread.
`;

export const pageGuideCapability: CapabilityDefinition = {
  key: 'page_guide',
  names: { sdk: 'page_guide', mcp: 'ziggs_page_guide' },
  title: 'How to build a page',
  descriptions: {
    sdk: 'How to build a page that works: window.ziggs, forms, feeding the thread, and the fallback text. Read this before writing a page for bucket_send.',
  },
  annotation: 'read-only',
  params: {},
  handler: async () => ({ guide: PAGE_GUIDE }),
};