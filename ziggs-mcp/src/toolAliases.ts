/**
 * Search aliases for the catalog listing.
 *
 * `ziggs_tools { search }` is how a caller finds a tool in the catalog, and it
 * matched on name and title only. That is fine when the caller
 * already speaks our vocabulary and useless when it does not: searching "hire"
 * returned `ziggs_agreement_handoff` — one tool, and the wrong one — because
 * "hire" happened to appear in that title and nowhere else. The default door
 * is `ziggs_agreement_claim`; `ziggs_agreement_buy` is the direct proposal.
 *
 * So a tool may declare the words a caller is likely to reach for. Aliases are
 * a DISCOVERY aid and nothing else: they never become callable names, never
 * appear in a catalog row, and cost nothing at connect time because the search
 * runs server-side.
 *
 * The word belonging here is the plain-English word for the intent, when our
 * name is a term of art: "hire" for claim (the default) and for buy (a direct
 * proposal), "subcontract" for the parent-rail verb.
 *
 * A retired name is not an alias: retiredTools.ts holds those, and search
 * reads it, so anything still holding an old name lands on its replacement.
 */
export const SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ziggs_message_send: ['contact', 'message someone', 'teammate', 'group'],
  ziggs_agent_search: ['teammate', 'colleague', 'directory', 'find person'],
  ziggs_access_request: ['access', 'permission', 'request access', 'address', 'approval', 'grant', 'restricted', 'unlock document'],
  ziggs_agreement_claim: ['hire'],
  ziggs_agreement_buy: [
    'hire',
    'procure',
    'outsource',
    'engage',
  ],
  ziggs_agreement_bid: ['sell', 'pitch', 'apply', 'tender', 'quote'],
  ziggs_agreement_request: [
    'wanted',
    'open call',
    'rfp',
    'post a job',
    'hire anyone',
  ],
  ziggs_agreement_broker: ['introduce', 'arrange', 'refer'],
  ziggs_agreement_handoff: ['transfer', 'reassign', 'pass on', 'give away'],
  ziggs_agreement_subcontract: ['subcontract', 'delegate a slice', 'under a parent'],
};

/** Does `needle` match one of this tool's aliases? Substring, both ways. */
export function aliasMatches(toolName: string, needle: string): boolean {
  const aliases = SEARCH_ALIASES[toolName];
  if (!aliases) return false;
  return aliases.some(
    (alias) => alias.includes(needle) || needle.includes(alias),
  );
}
