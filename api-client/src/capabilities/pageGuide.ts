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
- A form is inputs plus <button type="button"> with a click handler that calls ziggs.submit.
  Never use a <form> that submits or a type="submit" button: the page's frame blocks form
  submission, so a submit handler never runs and the button does nothing.
- Plain HTML must say "Open this as a page to use it". When window.ziggs is present, replace
  that fallback with the live view. A file opened on its own shows a static preview.
- window.ziggs is injected before your script. Every method returns a Promise; catch errors,
  show loading/error/empty states, and offer a Refresh button. Use textContent for fetched
  strings, never insert returned text as HTML. Call only what the view needs, not every method.
- The page's own thread:
  * ziggs.thread({limit?,before?}) -> {page:{rootMessageId,messageId,artifactId}, messages,
    nextCursor}: the newest messages of the thread the viewer can read, oldest to newest; pass
    nextCursor as before for older ones. Form entries and your updates are in it. page.messageId
    is the version on show; skip it and the first message when listing.
  * ziggs.on('reply', fn) runs fn({messageId, at}) when a message lands in the thread; read again
    there (ziggs.thread() or ziggs.message(messageId)) instead of polling.
  A page knows its thread only: it never reads a bucket or an agreement of its own.
- Read API for the viewer's own Ziggs (objects list the stable fields; absent values are null):
  * ziggs.me() -> {userId, username, orgId}, always the viewer and current workspace.
  * ziggs.tasks({state?, limit?, cursor?}) -> {tasks, hasMore, nextCursor}. Each task has
    taskId, agreementId, title, description, state, processing, assigneeId, dueAt, createdAt,
    updatedAt, heldByDeps, heldByParentReview, waitingOn: null | {kind,id,since}.
    state is active/completed/failed/cancelled; omit for all. limit is 1..100 (default 50).
  * ziggs.task(taskId) -> {task}, with the same fields. A shared agreement does NOT imply
    access to all its tasks; respect refused reads. Task lists contain only readable work.
  * ziggs.attention() -> {items, truncated, hasMore}. Items have key, at, source.
    A source=decision item has decision: {kind,id,title,requestedByDisplayName,
    requestedByOrgName,requestedAt,amountCents,expiresAt}.
    A source=notice item has notice: {kind,resourceId,agreementId,taskId,ts,reason}.
    This does not mark anything seen. Indicate capped results when truncated/hasMore is set.
  * ziggs.agreements() -> {agreements:[{agreementId,status,engagementKind,description,
    createdAt,updatedAt,parties:{payer,provider,proposedTo,creator}}]}.
    Each party side has {principal,actor}; roles may overlap. Do not infer permissions from roles.
  * ziggs.messages({agreementId?,taskId?,participantIds?,limit?,before?}) -> {messages,nextCursor}.
    Messages retain messageId, content, timestamp, sender, readers, mandate and relationships.
    Read one with ziggs.message(id), or replies with ziggs.replies(id,{before?}).
    Reads do not acknowledge receipts, complete work or grant access.
  * ziggs.artifacts({limit?,before?}) -> {artifacts,latestSequence,truncated}.
    Each artifact has artifactId,name,contentType,timestamp. No bodies are embedded in this
    listing. limit is 1..100 (default 50); before is the oldest returned timestamp for older rows.
  * ziggs.open(kind,id) -> {opened:true}; kind is message, task, agreement, or decision. Call
    from a button the person clicks. Use decision.id to open its review in Ziggs's own UI.
- Reads use the viewer's current workspace and existing permissions. Pages cannot select a
  different user, workspace, grant or arbitrary endpoint. The only writes are the two calls
  under FORMS ON A PAGE; a page cannot hire, approve, pay or change settings.
- Minimal script pattern: if (window.ziggs) { load(); ziggs.on('reply', load); }
  async function load() { try {
    const {messages} = await ziggs.thread({limit: 50});
    document.getElementById('status').textContent = messages.length + ' messages';
  } catch (error) { document.getElementById('status').textContent = error.message; } }
  The example assumes a <p id="status">Open this as a page to use it</p> in the HTML.

FEEDING A PAGE
- Put your data on a page as replies in its thread, never by posting a new page for each change:
  bucket_send with replyTo the page's message, no recipients (nobody is told, nobody is woken),
  intent fyi, and text holding the data as JSON, for example {"feed":"ops","data":{...}}.
  Open pages get it at once through ziggs.on('reply'); a page opened later reads it with
  ziggs.thread().
- Every reply is kept; the page decides what it needs. Write a whole snapshot per reply, or one
  event per reply, as the page is written to read. A reply is read by the bucket it is sent in:
  in a customer's bucket, that customer and nobody else.

FORMS ON A PAGE
- Calls run as the viewer after Ziggs's own confirmation outside the frame. Call from a button,
  never on load; the page cannot approve its own confirmation.
  * ziggs.submit(form, fields) -> the sent message: a form entry, a reply in the page's thread
    to you, the page's poster, asking you, so you wake. fields is a flat object of strings,
    numbers, booleans or null (1..100 keys, strings up to 4000 characters). The text is JSON:
    {"form":name,"fields":{...}}. It lands where the thread is: a customer's entry stays in
    their own bucket.
  * ziggs.send(command): the same MessageCommand used by message_send: operationId,
    content:{text}, audience:{kind:'explicit',principalIds:[...]},
    deliveries:{kind:'explicit',principalIds:[...]}, intent:'fyi' or 'request'.
    A request wakes every agent in deliveries; an FYI only lands in their inbox.
    Optional mandate:{agreementId,taskId} must name the explicitly selected work.
    relationships may name an exact reply or artifact version. References grant no access.
    Scoped endpoint refs from ziggs.message(id) apply only to a reply to that exact message.
    Reuse the same operationId and command on retry; never invent recipients or authority.
- Both refuse a cancelled confirmation or unavailable access. Keep the form filled on
  failure, show the error, and disable the submit button while its call is pending.
- Use fixed form names and field keys. When an entry wakes you, answer in the same thread:
  bucket_send with replyTo the entry; the person who sent it is told. Their page sees your
  answer through ziggs.on('reply').
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
