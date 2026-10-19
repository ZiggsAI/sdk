/**
 * exact-match triage for marketplace requests.
 * Empty match never hits (token-safe default). Comparison is exact after trim.
 */
export function requestExactMatch(
  match: string,
  tags: ReadonlyArray<string | null | undefined>,
): boolean {
  const needle = typeof match === 'string' ? match.trim() : '';
  if (!needle) return false;
  for (const t of tags) {
    if (typeof t === 'string' && t.trim() === needle) return true;
  }
  return false;
}
