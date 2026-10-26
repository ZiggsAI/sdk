import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { InboxEnvelope } from '@ziggs-ai/api-client';
import { formatInboxToolResult } from '../src/inboxToolResult.js';
import {
  INBOX_SECTIONS,
  compactInboxResult,
  compactTextResult,
  groupDeliveries,
  windowNote,
} from '../src/inboxCompact.js';
import { renderConnectText, sessionRules } from '../src/protocol/connectText.js';

/**
 * A busy mailbox, shaped from a real lab envelope: 23 deliveries — 11 assigned
 * to this assistant (9 old, 2 new), 8 for two other assistants, 4 for the
 * person, 6 of them out of reach. The same mix an assistant was handed in
 * production when one inbox read cost about 12,000 tokens.
 */
const envelope = JSON.parse(
  readFileSync(new URL('./support/inbox-busy.json', import.meta.url), 'utf8'),
) as InboxEnvelope;
const SELF = 'delegate--3e09e2a988a61c5d';

const session = {
  agentId: SELF,
  ownerId: 'lab-ada:::lab-ada@mcp-lab.ziggs.local',
  keyId: 'op_jlymeufravllbofihxzgwxab',
  tokenType: 'operator',
  connected: true,
  actingOrgId: 'org_mukyjhy9_57738565',
  actingOrgName: 'Lab Acme',
  actingOrgKind: 'team',
  orgId: 'org_mukyjhy9_57738565',
  orgName: 'Lab Acme',
  orgKind: 'team',
  apiBase: 'http://localhost:3001',
  webAppOrigin: 'https://ziggsai.com',
  docs: 'https://ziggsai.com/docs',
  identity: { agentId: SELF, distinctFromBackgroundWorker: true },
};

function result() {
  const news = formatInboxToolResult(envelope, null, undefined, undefined, [], undefined, {
    agentId: SELF,
  });
  return { ...news, session } as Record<string, unknown>;
}

type Row = Record<string, unknown>;
const rowsOf = (r: Record<string, unknown>) => r.deliveries as Row[];
const READER = { agentIds: [SELF] };

/**
 * Grouped deliveries read back as flat rows, putting back what a row's place
 * in the grouping says: its sender, its thread's ids, its assignee in forYou
 * (one assistant) and needsHuman in forYourPerson.
 */
function flatten(grouped: unknown, agentIds: readonly string[] = [SELF]): Row[] {
  const out: Row[] = [];
  for (const section of INBOX_SECTIONS) {
    for (const group of ((grouped as Row)[section] as Row[] | undefined) ?? []) {
      for (const thread of group.threads as Row[]) {
        const { rows, artifactId: _a, resourceId: _r, ...anchor } = thread;
        for (const row of rows as Row[])
          out.push({
            ...(group.from !== null ? { actorId: group.from } : {}),
            ...anchor,
            ...(section === 'forYou' && agentIds.length === 1 ? { assigneeId: agentIds[0] } : {}),
            ...(section === 'forYourPerson' ? { needsHuman: true } : {}),
            ...row,
          });
      }
    }
  }
  return out;
}
const byEvent = (rows: Row[]) => new Map(rows.map((d) => [d.eventId, d]));

describe('the compact inbox says the same thing in less (ZIG-2117)', () => {
  it('is far smaller than the indented result it replaces', () => {
    const before = JSON.stringify(result(), null, 2).length;
    const after = compactTextResult(result()).content[0].text.length;
    // Recorded so the number moves visibly when either side changes.
    console.log(`busy inbox: ${before} → ${after} characters (~${Math.round(before / 4)} → ~${Math.round(after / 4)} tokens)`);
    assert.ok(after < before * 0.6, `${after} is not well under ${before}`);
  });

  it('keeps every delivery, with its acknowledgement token byte for byte', () => {
    const full = result();
    const compact = compactInboxResult(full, READER);
    const rows = flatten(compact.deliveries);
    assert.deepEqual(
      rows.map((d) => d.eventId).sort(),
      rowsOf(full).map((d) => d.eventId).sort(),
    );
    const compacted = byEvent(rows);
    for (const original of rowsOf(full))
      assert.equal(compacted.get(original.eventId)!.ackTo, original.ackTo, String(original.eventId));
    assert.equal(compact.ackTo, full.ackTo);
    const ackStep = (r: Record<string, unknown>) =>
      (r.readPlan as Row[]).find((s) => s.tool === 'ziggs_inbox_ack')?.args;
    assert.deepEqual(ackStep(compact), ackStep(full));
    // Without a reader there is no telling whose a row is: one list, in order.
    assert.deepEqual(
      rowsOf(compactInboxResult(full)).map((d) => d.ackTo),
      rowsOf(full).map((d) => d.ackTo),
    );
  });

  it('drops only what can be read back from what stays', () => {
    const full = result();
    const compact = compactInboxResult(full, READER);
    const kindOf = new Map(
      (full.sources as Row[]).map((s) => [s.partyId, s.partyKind]),
    );
    const compacted = byEvent(flatten(compact.deliveries));
    rowsOf(full).forEach((original) => {
      const row = compacted.get(original.eventId)!;
      const partyId = row.partyId ?? compact.deliveriesPartyId;
      const restored: Row = { partyKind: kindOf.get(partyId), partyId, ...row };
      for (const [key, value] of Object.entries(original)) {
        // ZIG-2170 — out of reach is a flag on the row; the chat list says
        // how to ask for the room.
        if (key === 'outOfReach') {
          assert.equal(row.outOfReach, true, `outOfReach on ${row.resourceId}`);
          continue;
        }
        if (value === null || value === false || (Array.isArray(value) && !value.length))
          assert.ok(!(key in row) || row[key] === value, `${key} on ${row.resourceId}`);
        else assert.deepEqual(restored[key], value, `${key} on ${row.resourceId}`);
      }
    });
    // ZIG-2170 — no list repeats the rows: each carries the flag, and the
    // result says once where to look.
    assert.ok(flatten(compact.deliveries).some((d) => d.outOfReach === true));
    assert.equal('outOfReach' in compact, false);
    assert.equal(compact.outOfReachNote, full.outOfReachNote);
    // The long-poll half's "card is not here" hint goes when the card is here.
    const withCard = compactInboxResult({ ...full, sessionCardHint: 'the card is not in this response', sessionChatCard: '## card' });
    assert.equal('sessionCardHint' in withCard, false);
    assert.equal(withCard.sessionChatCard, '## card');
    assert.equal(compactInboxResult({ ...full, sessionCardHint: 'hint' }).sessionCardHint, 'hint');
    // Session: aliases and diagnostics go; ziggs_auth_status has them all.
    const s = compact.session as Row;
    assert.equal(s.actingOrgId, session.orgId);
    assert.equal(s.agentId, session.identity.agentId);
    for (const gone of ['orgId', 'orgName', 'orgKind', 'keyId', 'tokenType', 'docs', 'webAppOrigin'])
      assert.ok(!(gone in s), gone);
  });

  it('says what the session counters count, beside the counts', () => {
    const note = windowNote(envelope.deliveries, [SELF], 6);
    assert.equal(
      note,
      'Those counts are decisions and tasks, not messages. This window has 23 deliveries, grouped by who they are for, then by sender: forYou 11 (yours to handle), forYourPerson 4 (pass these along to your person), forOtherAssistants 8 (your person’s other assistants). 6 of them are out of reach.',
    );
    assert.equal(windowNote([], [SELF], 0), '');
    // Every row is accounted for: one nobody is asked to handle is context.
    assert.match(
      windowNote([{ assigneeId: SELF }, { needsHuman: true }, {}], [SELF], 0),
      /3 deliveries, grouped by who they are for, then by sender: forYou 1 \(yours to handle\), forYourPerson 1 \(pass these along to your person\), context 1 \(nobody is asked to act\)\.$/,
    );
    // Nothing for the assistant is said, not left out.
    assert.match(windowNote([{ needsHuman: true }], [SELF], 0), /: forYou 0 \(yours to handle\), forYourPerson 1 /);
    // Each count is its section's size.
    const grouped = compactInboxResult(result(), READER).deliveries as Record<string, Row[]>;
    const size = (rows: Row[] = []) => rows.reduce((n, g) => n + Number(g.count), 0);
    assert.deepEqual(
      [size(grouped.forYou), size(grouped.forYourPerson), size(grouped.forOtherAssistants)],
      [11, 4, 8],
    );
  });
});

/**
 * One window from a real account, shaped down: the assistant's own work, mail
 * its person should see, a person's own actions, another assistant's row and
 * one nobody has to act on.
 */
describe('the inbox is grouped by who it is for, then sender, then thread (ZIG-2161)', () => {
  const ME = 'delegate--me';
  const PERSON = 'person:::person@example.com';
  const row = (eventId: string, fields: Row): Row => ({
    kind: 'message', resourceId: `res-${eventId}`, eventId, assigneeId: null, needsHuman: false,
    chatId: null, agreementId: null, taskId: null, ts: `2026-10-0${eventId.length}T00:00:00.000Z`,
    actorId: null, ackTo: `ack-${eventId}`, ...fields,
  });
  const rows: Row[] = [
    row('a1', { assigneeId: ME, actorId: 'delegate--colleague', chatId: 'chat-work' }),
    row('p1', { kind: 'task-state', resourceId: 'task-1', needsHuman: true, actorId: 'delegate--worker', taskId: 'task-1', agreementId: 'agr-job' }),
    row('p2', { kind: 'agreement', resourceId: 'agr-mine', needsHuman: true, actorId: PERSON, agreementId: 'agr-mine' }),
    row('p3', { kind: 'artifact', resourceId: 'art-1', needsHuman: true, actorId: 'delegate--worker', taskId: 'task-1' }),
    row('p4', { needsHuman: true, actorId: 'colleague:::c@example.com', chatId: 'chat-pair' }),
    row('a2', { assigneeId: ME, actorId: 'delegate--colleague', chatId: 'chat-work' }),
    row('o1', { assigneeId: 'delegate--other', needsHuman: true, actorId: PERSON, agreementId: 'agr-other' }),
    row('c1', { kind: 'agreement', resourceId: 'agr-context', agreementId: 'agr-context' }),
    row('p5', { kind: 'task-state', resourceId: 'task-1', needsHuman: true, actorId: 'delegate--worker', taskId: 'task-1', agreementId: 'agr-job' }),
  ];
  const grouped = groupDeliveries(rows, { agentIds: [ME], personId: PERSON });

  it('writes the sections in a fixed order and skips empty ones', () => {
    assert.deepEqual(Object.keys(grouped), ['forYou', 'forYourPerson', 'forOtherAssistants', 'context']);
    assert.deepEqual(Object.keys(groupDeliveries([rows[0]], { agentIds: [ME] })), ['forYou']);
  });

  it('puts one sender per group, their threads under them, and the person’s own actions last', () => {
    assert.deepEqual(grouped.forYou, [{
      from: 'delegate--colleague',
      count: 2,
      threads: [{ chatId: 'chat-work', rows: [
        { kind: 'message', resourceId: 'res-a1', eventId: 'a1', needsHuman: false, agreementId: null, taskId: null, ts: rows[0].ts, ackTo: 'ack-a1' },
        { kind: 'message', resourceId: 'res-a2', eventId: 'a2', needsHuman: false, agreementId: null, taskId: null, ts: rows[5].ts, ackTo: 'ack-a2' },
      ] }],
    }]);
    const person = grouped.forYourPerson!;
    assert.deepEqual(person.map((g) => [g.from, g.count, g.yourPerson ?? false]), [
      ['delegate--worker', 3, false],
      ['colleague:::c@example.com', 1, false],
      [PERSON, 1, true],
    ]);
    // A task's updates and its file are one thread, under the task's agreement;
    // the file, which names none, says so instead of inheriting it.
    const [task] = person[0].threads as Row[];
    assert.equal(task.taskId, 'task-1');
    assert.equal(task.agreementId, 'agr-job');
    assert.deepEqual((task.rows as Row[]).map((r) => [r.eventId, r.agreementId]), [
      ['p1', undefined], ['p3', null], ['p5', undefined],
    ]);
    assert.deepEqual((person[2].threads as Row[])[0].agreementId, 'agr-mine');
  });

  it('marks another assistant’s row and leaves its assignee on it', () => {
    const [other] = grouped.forOtherAssistants!;
    assert.equal(other.yourPerson, true);
    assert.equal(((other.threads as Row[])[0].rows as Row[])[0].assigneeId, 'delegate--other');
    assert.equal(((other.threads as Row[])[0].rows as Row[])[0].needsHuman, true);
  });

  it('reads back to exactly the rows it was given', () => {
    const back = byEvent(flatten(grouped, [ME]));
    assert.equal(back.size, rows.length);
    for (const original of rows) {
      const restored = back.get(original.eventId)!;
      for (const [key, value] of Object.entries(original))
        assert.deepEqual(restored[key] ?? null, value ?? null, `${key} on ${original.eventId}`);
    }
  });

  it('keeps every row’s assignee when the connection has several assistants', () => {
    const several = groupDeliveries(rows, { agentIds: [ME, 'delegate--me-too'] });
    const mine = ((several.forYou![0].threads as Row[])[0].rows as Row[]);
    assert.ok(mine.every((r) => r.assigneeId === ME));
  });
});

// The connection door (ChatGPT, Claude, Cursor over OAuth) builds its inbox
// result on its own path. It must come out as compact as the compact door's.
describe('the connection door’s inbox read is compact too (ZIG-2117)', () => {
  it('compacts the snapshot and the claim, keeps every ackTo, and says what the counters count', async () => {
    const { mock } = await import('node:test');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createZiggsMcpServer } = await import('../src/server.js');
    const key = `e30.${Buffer.from(JSON.stringify({ type: 'operator', keyId: 'key', ownerId: 'owner', connectionClientId: 'client', issuedVia: 'mcp_oauth' })).toString('base64url')}.test`;
    const served = { ...envelope, agentIds: [SELF], workspaces: [{ orgId: 'org_a', name: 'A', agentId: SELF }] };
    const fetchMock = mock.method(globalThis, 'fetch', async (input: unknown) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/connection-notices')) return new Response(JSON.stringify({ notices: [], assistantConnection: true }));
      return new Response(JSON.stringify(served));
    });
    const server = createZiggsMcpServer({ operatorKey: key, agentId: '', instanceId: 'test-host' } as never, { directConnection: false, debugTools: false } as never);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ChatGPT', version: 'test' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      for (const name of ['ziggs_inbox']) {
        const r = await client.callTool({ name, arguments: {} });
        const raw = (r.content as Array<{ text: string }>)[0].text;
        const out = JSON.parse(raw) as Record<string, unknown>;
        assert.equal(raw.includes('\n'), false, `${name} is not one line`);
        assert.equal(out.deliveriesPartyId, envelope.deliveries[0].partyId, name);
        const rows = flatten(out.deliveries);
        assert.deepEqual(rows.map((d) => d.eventId).sort(), envelope.deliveries.map((d) => d.eventId).sort(), name);
        const acks = byEvent(rows);
        for (const d of envelope.deliveries) assert.equal(acks.get(d.eventId)!.ackTo, d.ackTo, name);
        assert.ok(rows.every((d) => !('partyKind' in d)), name);
        assert.deepEqual(Object.keys(out.deliveries as Row), ['forYou', 'forYourPerson', 'forOtherAssistants'], name);
        assert.match(String(out.notice), /This window has 23 deliveries, grouped by who they are for, then by sender: forYou 11 /, name);
        assert.match(String(out.instruction), /^deliveries\.forYou is your work; deliveries\.forYourPerson is for your person to see\./, name);
        // The session-start read carries the rules a host that hides the
        // server instructions would otherwise never show; the claim does not.
        if (name === 'ziggs_inbox') {
          assert.deepEqual(out.rules, sessionRules('directory'));
          // Claude.ai can omit server instructions, so these must arrive on
          // the actual first inbox response, not only in generated skill text.
          assert.match(out.rules.join(' '), /requestReplyAccess/);
          assert.match(out.rules.join(' '), /original chatId/);
          assert.match(out.rules.join(' '), /finishing the request needs a reply or decision/);
        }
        else assert.equal('rules' in out, false, name);
      }
      const claimed = JSON.parse(
        (await client.callTool({ name: 'ziggs_inbox_claim', arguments: {} })).content[0].text,
      ) as Record<string, unknown>;
      assert.equal(claimed.claimed, true);
      assert.equal(typeof claimed.deliveryCount, 'number');
      assert.equal('deliveries' in claimed, false);
      assert.equal('rules' in claimed, false);
      const polled = JSON.parse((await client.callTool({ name: 'ziggs_inbox', arguments: { waitSeconds: 0 } })).content[0].text);
      assert.equal('rules' in polled, false, 'a long-poll tick does not repeat the rules');
      for (const rule of sessionRules('directory'))
        assert.ok(renderConnectText('directory').includes(rule), 'the rules are the connect text’s own words');
    } finally {
      fetchMock.mock.restore();
      await client.close();
    }
  });
});
