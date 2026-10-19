import { pickListedRow, parseListFields } from './listedFields.js';

/**
 * Default `ziggs_chat_list` projection.
 *
 * The wire row carries three web-app rosters (`members`, `rosterSummary`,
 * `participantSummary`) and repeats the persona on each. The MCP default
 * keeps the people who actually receive (`participantSummary`) and drops the
 * other two unless `fields` asks for them.
 */
export const CHAT_LIST_DEFAULT_FIELDS = [
  'chatId',
  'name',
  'updatedAt',
  'lastMessage',
  'unreadCount',
  'participantSummary',
  // A room you may only list says so, with the read request ready to file.
  'readable',
  'requestAccess',
] as const;

function slimParticipant(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const rec = row as Record<string, unknown>;
  const view = rec.presentationView;
  const { presentationView: _drop, ...rest } = rec;
  if (view && typeof view === 'object' && !Array.isArray(view)) {
    const presented = view as Record<string, unknown>;
    return {
      ...rest,
      ...(rest.persona == null && presented.persona != null
        ? { persona: presented.persona }
        : {}),
      ...(rest.presentation == null && presented.mode != null
        ? { presentation: presented.mode }
        : {}),
    };
  }
  return rest;
}

function projectOneChat(
  row: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const picked = pickListedRow(row, fields);
  if (Array.isArray(picked.participantSummary)) {
    picked.participantSummary = picked.participantSummary.map(slimParticipant);
  }
  return picked;
}

/** Apply `fields`, or the MCP default when the caller omitted it. */
export function projectChatListRows(
  chats: unknown[],
  fieldsRaw?: unknown,
): unknown[] {
  const fields = parseListFields(fieldsRaw) ?? [...CHAT_LIST_DEFAULT_FIELDS];
  return chats.map((row) =>
    row && typeof row === 'object' && !Array.isArray(row)
      ? projectOneChat(row as Record<string, unknown>, fields)
      : row,
  );
}

export function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Rough token count: 4 UTF-8 bytes per token, rounded up. */
export function approxTokens(value: unknown): number {
  return Math.ceil(utf8Bytes(value) / 4);
}
