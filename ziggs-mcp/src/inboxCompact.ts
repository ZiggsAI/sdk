/**
 * A smaller representation of the same inbox read.
 *
 * Every assistant start-up pays for one inbox read, and it was several times
 * the size of the connect text before any content was opened. This changes how
 * the result is written, never what it says: which deliveries are visible,
 * their order within a thread, their reach, the acknowledgement tokens, the
 * counters and the lease all come from the server unchanged. What goes is only
 * what can be read back from what stays:
 *
 * - a delivery field that is null, false or empty (absent reads the same);
 * - `partyKind` on a delivery, which `sources` already gives for its `partyId`,
 *   and `partyId` itself when it is the window's usual one, named once as
 *   `deliveriesPartyId`;
 * - session fields that repeat another field (`orgId` beside `actingOrgId`,
 *   `identity.agentId` beside `agentId`) and the connection's diagnostics,
 *   which `ziggs_auth_status` returns in full;
 * - a read step's `why` that only restates its tool and args, and the ack
 *   step's long one, whose ids are the step's own args;
 * - a delivery's out-of-reach scope and remedy: the row keeps `outOfReach: true`
 *   beside its own ids, and the chat list says how to ask for the room;
 * - `sessionCardHint` ("the card is not in this response") when the card is.
 *   Both doors assemble the session start from the long-poll result plus the
 *   card, and the long-poll half's hint said the opposite of what followed.
 *
 * Acknowledgement stays exact: every `ackTo` — the envelope's, each row's and
 * the ack step's — is passed through byte for byte.
 *
 * The rows are written grouped rather than as one flat list: by who they are
 * for, then by who sent them, then by the chat, task or agreement they are
 * about. A flat list mixed the assistant's own work with mail it
 * only passes along to its person and mail for the person's other
 * assistants, and the split lived in one sentence of counts. Every row is
 * still there, oldest first inside its thread; see {@link groupDeliveries}.
 */

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Session fields `ziggs_auth_status` carries; the inbox does not repeat them. */
const SESSION_DIAGNOSTICS = ['keyId', 'tokenType', 'docs', 'webAppOrigin'];

/** Session fields that are another field under an older name. */
const SESSION_ALIASES: Record<string, string> = {
  orgId: 'actingOrgId',
  orgName: 'actingOrgName',
  orgKind: 'actingOrgKind',
};

/** One delivery row, without what it would say by default or elsewhere. */
export function compactDelivery(
  row: Json,
  kindOfParty: Map<string, unknown>,
  usualPartyId?: unknown,
): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (key === 'partyKind' && kindOfParty.get(String(row.partyId)) === value) continue;
    if (key === 'partyId' && usualPartyId !== undefined && value === usualPartyId) continue;
    if (key === 'outOfReach') {
      out[key] = true;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function compactSession(session: Json, topLevelNotices: unknown): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(session)) {
    if (SESSION_DIAGNOSTICS.includes(key)) continue;
    const alias = SESSION_ALIASES[key];
    if (alias && session[alias] === value) continue;
    if (
      key === 'connectionNotices' &&
      JSON.stringify(value) === JSON.stringify(topLevelNotices)
    )
      continue;
    if (key === 'identity' && isRecord(value) && value.agentId === session.agentId) {
      const { agentId: _same, ...rest } = value;
      out[key] = rest;
      continue;
    }
    out[key] = value;
  }
  return out;
}

const ACK_WHY = 'after handling these rows; a row’s ackTo stops earlier';

/** The partyId most rows carry, when there is one worth naming once. */
function usualPartyOf(rows: unknown[]): unknown {
  const counts = new Map<unknown, number>();
  for (const r of rows) if (isRecord(r) && r.partyId) counts.set(r.partyId, (counts.get(r.partyId) ?? 0) + 1);
  let best: unknown;
  let most = 1;
  for (const [id, n] of counts) if (n > most) [best, most] = [id, n];
  return best;
}

/** Who an inbox read belongs to: the connection's assistants and their person. */
export interface InboxReader {
  agentIds: readonly string[];
  /** The person the assistants work for; read off the human source when absent. */
  personId?: string | null;
}

/** The sections of a grouped inbox, in the order they are written. */
export const INBOX_SECTIONS = ['forYou', 'forYourPerson', 'forOtherAssistants', 'context'] as const;
export type InboxSection = (typeof INBOX_SECTIONS)[number];

/**
 * Who a row is for. One rule for the grouping and for the counts in the
 * notice, so the two cannot disagree: assigned to one of the reader's
 * assistants is theirs to handle; unassigned and flagged for a human is the
 * person's, which the assistant passes along; assigned to anyone else is
 * another assistant's; the rest nobody is asked to act on.
 */
export function sectionOf(row: Json, agentIds: readonly string[]): InboxSection {
  const assignee = row.assigneeId ? String(row.assigneeId) : '';
  if (assignee && agentIds.includes(assignee)) return 'forYou';
  if (!assignee && row.needsHuman === true) return 'forYourPerson';
  if (assignee) return 'forOtherAssistants';
  return 'context';
}

/** What a row is about: its chat, else its task, else its agreement, else itself. */
function anchorOf(row: Json): [field: string, id: string] {
  if (row.chatId) return ['chatId', String(row.chatId)];
  if (row.taskId) return ['taskId', String(row.taskId)];
  if (row.agreementId) return ['agreementId', String(row.agreementId)];
  return [row.kind === 'artifact' ? 'artifactId' : 'resourceId', String(row.resourceId)];
}

interface Thread { anchor: [string, string]; rows: Json[] }
interface SenderGroup { from: string | null; threads: Map<string, Thread> }

/**
 * The window's rows, grouped: section, then sender, then thread.
 *
 * Nothing is hidden and nothing is reordered within a thread. Senders and
 * threads are written in the order their oldest row arrived, which is the
 * order the server sends (oldest first), except that the reader's own actions
 * and their person's come last in a section: they are a record of what this
 * side did, not news from anyone.
 *
 * A row drops only what its place in the grouping says: the sender (the
 * group's `from`), the thread's own id, the assignee in `forYou` when the
 * connection has one assistant, and `needsHuman` in `forYourPerson`. A thread
 * names the first agreement its rows sit under; a row under another one keeps
 * its own, and a row under none says `agreementId: null`, so every row reads
 * back exactly.
 */
export function groupDeliveries(
  rows: readonly Json[],
  reader: InboxReader,
  compactRow: (row: Json) => Json = (row) => ({ ...row }),
): Partial<Record<InboxSection, Json[]>> {
  const sections = new Map<InboxSection, Map<string, SenderGroup>>();
  for (const row of rows) {
    const section = sectionOf(row, reader.agentIds);
    const from = row.actorId ? String(row.actorId) : null;
    const anchor = anchorOf(row);
    let senders = sections.get(section);
    if (!senders) sections.set(section, (senders = new Map()));
    let group = senders.get(String(from));
    if (!group) senders.set(String(from), (group = { from, threads: new Map() }));
    const key = anchor.join(':');
    let thread = group.threads.get(key);
    if (!thread) group.threads.set(key, (thread = { anchor, rows: [] }));
    thread.rows.push(row);
  }

  const own = (from: string | null) =>
    from !== null && (reader.agentIds.includes(from) || from === reader.personId);
  const out: Partial<Record<InboxSection, Json[]>> = {};
  for (const section of INBOX_SECTIONS) {
    const senders = sections.get(section);
    if (!senders) continue;
    const ordered = [...senders.values()];
    out[section] = [
      ...ordered.filter((g) => !own(g.from)),
      ...ordered.filter((g) => own(g.from)),
    ].map((g) => {
      const threads = [...g.threads.values()].map((t) => writeThread(t, section, reader, compactRow));
      const count = [...g.threads.values()].reduce((n, t) => n + t.rows.length, 0);
      return {
        from: g.from,
        ...(g.from !== null && reader.agentIds.includes(g.from) ? { you: true } : {}),
        ...(g.from !== null && g.from === reader.personId ? { yourPerson: true } : {}),
        count,
        threads,
      };
    });
  }
  return out;
}

function writeThread(
  thread: Thread,
  section: InboxSection,
  reader: InboxReader,
  compactRow: (row: Json) => Json,
): Json {
  const [field, id] = thread.anchor;
  const lifted = field === 'agreementId'
    ? null
    : (thread.rows.map((r) => r.agreementId).find(Boolean) as string | undefined) ?? null;
  const rows = thread.rows.map((original) => {
    const row = compactRow(original);
    delete row.actorId;
    if (field !== 'resourceId' && field !== 'artifactId') delete row[field];
    if (lifted) {
      if (row.agreementId === lifted) delete row.agreementId;
      else if (!row.agreementId) row.agreementId = null;
    }
    if (section === 'forYou') {
      if (reader.agentIds.length === 1) delete row.assigneeId;
      if (row.assignedToConnection === true) delete row.assignedToConnection;
    }
    if (section === 'forYourPerson') delete row.needsHuman;
    return row;
  });
  return { [field]: id, ...(lifted ? { agreementId: lifted } : {}), rows };
}

/** The reader's assistants, without empty ids, and their person. */
function readerOf(result: Json, reader?: InboxReader): InboxReader | null {
  const agentIds = (reader?.agentIds ?? []).filter(Boolean);
  if (!agentIds.length) return null;
  const human = Array.isArray(result.sources)
    ? result.sources.find((s) => isRecord(s) && s.partyKind === 'human')
    : undefined;
  const personId = reader?.personId ?? (isRecord(human) ? String(human.partyId) : null);
  return { agentIds, personId };
}

/**
 * The compact inbox result. Takes the result exactly as it would otherwise be
 * returned and gives back the same information in fewer characters.
 *
 * With a reader, `deliveries` is written grouped ({@link groupDeliveries});
 * without one there is no telling whose a row is, so it stays one list.
 */
export function compactInboxResult(result: Json, reader?: InboxReader): Json {
  const kindOfParty = new Map<string, unknown>();
  if (Array.isArray(result.sources))
    for (const s of result.sources)
      if (isRecord(s)) kindOfParty.set(String(s.partyId), s.partyKind);

  const out: Json = { ...result };
  if (typeof result.sessionChatCard === 'string' && result.sessionChatCard)
    delete out.sessionCardHint;
  if (Array.isArray(result.deliveries)) {
    const usual = usualPartyOf(result.deliveries);
    if (usual !== undefined) out.deliveriesPartyId = usual;
    const whose = readerOf(result, reader);
    out.deliveries = whose
      ? groupDeliveries(result.deliveries.filter(isRecord), whose, (d) =>
          compactDelivery(d, kindOfParty, usual),
        )
      : result.deliveries.map((d) =>
          isRecord(d) ? compactDelivery(d, kindOfParty, usual) : d,
        );
  }
  if (isRecord(result.session))
    out.session = compactSession(result.session, result.connectionNotices);
  if (Array.isArray(result.readPlan))
    out.readPlan = result.readPlan.map((step) => {
      if (!isRecord(step)) return step;
      if (step.tool === 'ziggs_inbox_ack') return { ...step, why: ACK_WHY };
      const args = isRecord(step.args) ? Object.values(step.args) : [];
      const restates =
        step.tool === 'ziggs_open' &&
        typeof step.why === 'string' &&
        args.length === 1 &&
        step.why.startsWith('open the ') &&
        step.why.endsWith(String(args[0]));
      if (!restates) return step;
      const { why: _restated, ...rest } = step;
      return rest;
    });
  return out;
}

/** The inbox result as one line of JSON: indentation is most of nothing. */
export function compactTextResult(data: Json, reader?: InboxReader) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(compactInboxResult(data, reader)) }],
  };
}

/**
 * What the session notice's counts cover, said beside them.
 *
 * The notice counts decisions and active tasks; it never counted messages.
 * Read alone, "No pending decisions or active tasks" sounded like an empty
 * inbox while assigned messages waited in `deliveries`. This adds what the
 * window holds, without changing what counts as pending or actionable.
 */
export function windowNote(deliveries: unknown, selfAgentIds: readonly string[]): string {
  const rows = Array.isArray(deliveries) ? deliveries.filter(isRecord) : [];
  if (!rows.length) return '';
  const outOfReach = rows.filter((d) => d.outOfReach).length;
  // The same rule the grouping uses, so each count is its section's size.
  const count = (s: InboxSection) => rows.filter((d) => sectionOf(d, selfAgentIds) === s).length;
  const words: Record<InboxSection, string> = {
    forYou: 'yours to handle',
    forYourPerson: 'pass these along to your person',
    forOtherAssistants: 'your person’s other assistants',
    context: 'nobody is asked to act',
  };
  // forYou is always named, so "nothing for you" is said rather than implied.
  const parts = INBOX_SECTIONS.filter((s) => s === 'forYou' || count(s) > 0).map(
    (s) => `${s} ${count(s)} (${words[s]})`,
  );
  const reach = outOfReach ? ` ${outOfReach} of them ${outOfReach === 1 ? 'is' : 'are'} out of reach.` : '';
  const total = `${rows.length} ${rows.length === 1 ? 'delivery' : 'deliveries'}`;
  return `Those counts are decisions and tasks, not messages. This window has ${total}, grouped by who they are for, then by sender: ${parts.join(', ')}.${reach}`;
}
