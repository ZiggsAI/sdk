/**
 * Minimal raw HTTP polling agent (ZIG-447).
 *
 * One agent-scoped operator key — no SDK, no MCP, no X-Agent-Id.
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

async function handleMessages(items) {
  for (const item of items) {
    console.log('[message]', item.text ?? item);
  }
}

async function pollOnce() {
  const inboxRes = await fetch(`${BASE}/inbox`, { headers });
  if (!inboxRes.ok) {
    throw new Error(`inbox ${inboxRes.status}: ${await inboxRes.text()}`);
  }
  const inbox = await inboxRes.json();

  for (const { scope, since, latestAt } of inbox.scopes ?? []) {
    const via = `${scope.kind}:${scope.id}`;
    const url = new URL(`${BASE}/context/read/messages`);
    url.searchParams.set('via', via);
    url.searchParams.set('after', since);
    url.searchParams.set('direction', 'forward');

    const readRes = await fetch(url, { headers });
    if (!readRes.ok) {
      throw new Error(`read ${readRes.status}: ${await readRes.text()}`);
    }
    const { items } = await readRes.json();
    await handleMessages(items);

    if (latestAt) {
      const ackRes = await fetch(`${BASE}/inbox/ack`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes: [{ kind: scope.kind, id: scope.id, upTo: latestAt }] }),
      });
      if (!ackRes.ok) {
        throw new Error(`ack ${ackRes.status}: ${await ackRes.text()}`);
      }
    }
  }

  for (const p of inbox.proposalsAwaitingMe ?? []) {
    console.log('[proposal awaiting]', p.agreementId, p.title);
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
