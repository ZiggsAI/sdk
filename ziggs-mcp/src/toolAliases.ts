/**
 * Search aliases for the catalog listing.
 *
 * Names-first delivery made `ziggs_tools { search }` the way a caller finds a
 * tool, and it matched on name and title only. That is fine when the caller
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
 * Two kinds of word belong here:
 *
 * 1. The plain-English word for the intent, when our name is a term of art.
 *    "hire" for claim (the default) and for buy (a direct proposal),
 *    "subcontract" for the parent-rail verb.
 * 2. A name we retired. `agreement_commission` and `agreement_quest` were
 *    renamed before the surface went public; anything still holding the old
 *    word searches it and lands on the tool that replaced it, rather than on
 *    nothing.
 */
export const SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ziggs_chat_open: [
    'contact',
    'teammate',
    'colleague',
    'start conversation',
    'create chat',
    'message someone',
    'room',
    'group',
    'channel',
    'invite',
    'add people',
  ],
  ziggs_agent_search: ['teammate', 'colleague', 'directory', 'find person'],
  ziggs_access_request: ['access', 'permission', 'request access', 'chat', 'approval', 'grant', 'restricted', 'unlock document'],
  ziggs_agreement_claim: ['hire'],
  ziggs_agreement_buy: [
    'hire',
    'commission', // retired name
    'procure',
    'outsource',
    'engage',
  ],
  ziggs_agreement_bid: ['sell', 'pitch', 'apply', 'tender', 'quote'],
  ziggs_agreement_request: [
    'quest', // retired name
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
