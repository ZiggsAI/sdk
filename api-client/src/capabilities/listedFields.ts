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
    'Return only these keys on each row. Omit for the full row. Keep the id you will use next (agreementId, taskId, artifactId, grantId). A name no row has is listed in unknownFields.',
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The value a caller asked for, including the names list rows actually store. */
export function readListedField(
  row: Record<string, unknown>,
  key: string,
): { found: true; value: unknown } | { found: false } {
  if (key in row) return { found: true, value: row[key] };
  const scope = asRecord(row.scope);
  if (key === 'scopeKind' && scope && 'kind' in scope)
    return { found: true, value: scope.kind };
  if (key === 'scopeId' && scope && 'id' in scope)
    return { found: true, value: scope.id };
  const terms = asRecord(row.terms);
  const description =
    typeof row.description === 'string'
      ? row.description
      : typeof terms?.description === 'string'
        ? terms.description
        : undefined;
  if ((key === 'name' || key === 'title') && description !== undefined)
    return { found: true, value: description };
  if (key === 'name' && typeof row.title === 'string')
    return { found: true, value: row.title };
  if (key === 'title' && typeof row.name === 'string')
    return { found: true, value: row.name };
  if (key === 'agentId' && 'providerAgent' in row)
    return { found: true, value: row.providerAgent };
  if (key === 'providerId' && 'provider' in row)
    return { found: true, value: row.provider };
  if (key === 'kind' && 'engagementKind' in row)
    return { found: true, value: row.engagementKind };
  const parties = asRecord(row.parties);
  const provider = asRecord(parties?.provider);
  if (key === 'agentId' && provider && 'actor' in provider)
    return { found: true, value: provider.actor };
  if (key === 'providerId' && provider && 'principal' in provider)
    return { found: true, value: provider.principal };
  return { found: false };
}

export function pickListedRow(
  row: Record<string, unknown>,
  fields: string[] | undefined,
): Record<string, unknown> {
  if (!fields) return row;
  const picked: Record<string, unknown> = {};
  for (const key of fields) {
    const resolved = readListedField(row, key);
    if (resolved.found) picked[key] = resolved.value;
  }
  return picked;
}

/** Names in `fields` that no row could resolve. Empty rows say nothing. */
export function listedFieldNote(
  rows: unknown[],
  fields: string[] | undefined,
): { unknownFields?: string[] } {
  if (!fields || rows.length === 0) return {};
  const unknown = fields.filter(
    (key) =>
      !rows.some((row) => {
        const record = asRecord(row);
        return record != null && readListedField(record, key).found;
      }),
  );
  return unknown.length > 0 ? { unknownFields: unknown } : {};
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
