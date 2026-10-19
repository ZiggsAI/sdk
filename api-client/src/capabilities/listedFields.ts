/**
 * Opt-in row projection for list tools.
 *
 * List endpoints return the full row by default. Pass `fields` to keep only
 * those keys — the same shape as Linear's `list_issues`. Envelope keys
 * (count, nextCursor, hasMore) are never filtered.
 */

export const LIST_FIELDS_PARAM = {
  type: 'array' as const,
  items: { type: 'string' as const },
  description:
    'Return only these keys on each row. Omit for the full row. Keep the id you will use next (agreementId, taskId, artifactId, grantId).',
};

export function parseListFields(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('fields must be a non-empty array of row key names');
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error('fields entries must be non-empty strings');
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

export function pickListedRow(
  row: Record<string, unknown>,
  fields: string[] | undefined,
): Record<string, unknown> {
  if (!fields) return row;
  const picked: Record<string, unknown> = {};
  for (const key of fields) {
    if (key in row) picked[key] = row[key];
  }
  return picked;
}

export function pickListedRows(
  rows: unknown[],
  fields: string[] | undefined,
): unknown[] {
  if (!fields) return rows;
  return rows.map((row) =>
    row && typeof row === 'object' && !Array.isArray(row)
      ? pickListedRow(row as Record<string, unknown>, fields)
      : row,
  );
}
