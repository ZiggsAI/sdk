/**
 * Minimal raw HTTP polling agent (ZIG-447).
 *
 * One agent-scoped operator key, no SDK, no MCP, no X-Agent-Id.
 * Loop: inbox → read → act → ack.
 *
 * Usage:
 *   ZIGGS_OPERATOR_KEY=<agent-scoped key from Agents UI> \
 *   node examples/raw-polling-agent.mjs
 *
 * Optional:
 *   ZIGGS_BACKEND_URL=https://api.ziggsai.com
 *   POLL_INTERVAL_MS=30000
 */

const BASE = process.env.ZIGGS_BACKEND_URL || 'https://api.ziggsai.com';
const KEY = process.env.ZIGGS_OPERATOR_KEY;
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 30_000);

if (!KEY) {
  console.error('Set ZIGGS_OPERATOR_KEY (agent-scoped operator key from the Agents UI).');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${KEY}` };

async function pollOnce() {
  const inboxRes = await fetch(`${BASE}/inbox?wait=25`, { headers });
  if (!inboxRes.ok) throw new Error(`inbox ${inboxRes.status}: ${await inboxRes.text()}`);
  const inbox = await inboxRes.json();
  for (const delivery of inbox.deliveries ?? []) {
    if (delivery.kind !== 'message' || delivery.executionBlocked || delivery.outOfReach) continue;
    const scoped = {...headers,...(delivery.executionContext?.contextId ? {'X-Ziggs-Execution':delivery.executionContext.contextId}: {})};
    const response=await fetch(`${BASE}/messaging/messages/${encodeURIComponent(delivery.resourceId)}`,{headers:scoped});
    if (!response.ok) throw new Error(`read ${response.status}: ${await response.text()}`);
    const message=await response.json();console.log('[message]',message.content.text);
    // Add domain work here. Resolve requestedAnswers with an exact answer command;
    // task completion uses task_set_result. This read-only example does neither.
  }
  if (inbox.ackTo) {
    const response=await fetch(`${BASE}/inbox/ack`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({upTo:inbox.ackTo,handledDeliveryIds:[]})});
    if (!response.ok) throw new Error(`ack ${response.status}: ${await response.text()}`);
  }
}

console.log(`Polling ${BASE} every ${POLL_MS}ms`);
while (true) {
  try {
    await pollOnce();
  } catch (err) {
    console.error('[poll error]', err.message ?? err);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
